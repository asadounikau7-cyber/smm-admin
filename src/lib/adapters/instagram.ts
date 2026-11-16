import type { SocialAccount } from "@prisma/client";
import { db } from "../db";
import { env } from "../env";
import { decryptJson, encryptJson } from "../crypto";
import { mediaUrl } from "../mediaSource";
import { coverPublicUrl } from "../covers";
import { AdapterError, httpJson, type JobCtx, type Outcome, type PlatformAdapter } from "./types";

const GRAPH = "https://graph.instagram.com/v23.0";
export const IG_SCOPES = ["instagram_business_basic", "instagram_business_content_publishing"];

type IgCreds = { access_token: string; expires_at: number };

/** The container is created this long before the slot so the video is processed by publish time. */
const PREP_MINUTES = 30;

export async function igToken(account: SocialAccount): Promise<string> {
  const c = decryptJson<IgCreds>(account.credentials);
  if (!c) throw new AdapterError("AUTH", "Нет токена Instagram");
  if (c.expires_at < Date.now()) throw new AdapterError("AUTH", "Токен Instagram истёк, переподключите аккаунт");
  return c.access_token;
}

/** Long-lived tokens live 60 days; the worker refreshes them when < 10 days remain. */
export async function igRefresh(account: SocialAccount) {
  const c = decryptJson<IgCreds>(account.credentials);
  if (!c || c.expires_at - Date.now() > 10 * 86400_000) return;
  const { body } = await httpJson(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(c.access_token)}`);
  const next = { access_token: body.access_token, expires_at: Date.now() + body.expires_in * 1000 };
  await db.socialAccount.update({ where: { id: account.id }, data: { credentials: encryptJson(next), tokenExpiresAt: new Date(next.expires_at) } });
}

async function call(account: SocialAccount, path: string, params: Record<string, string> = {}, method: "GET" | "POST" = "GET") {
  const token = await igToken(account);
  const qs = new URLSearchParams({ ...params, access_token: token });
  return method === "GET"
    ? httpJson(`${GRAPH}/${path}?${qs}`)
    : httpJson(`${GRAPH}/${path}`, { method: "POST", body: qs, headers: { "content-type": "application/x-www-form-urlencoded" } });
}

function igError(e: unknown): never {
  if (e instanceof AdapterError && e.kind === "INVALID" && /"code":190|OAuthException/.test(e.message)) throw new AdapterError("AUTH", e.message, e.httpStatus);
  if (e instanceof AdapterError && /"code":(4|17|32|613)\b|rate limit|limit reached/i.test(e.message)) throw new AdapterError("RATE_LIMIT", e.message, e.httpStatus, 3600);
  throw e;
}

async function findPublished(job: JobCtx): Promise<{ id: string; permalink: string } | null> {
  // Used when we can't tell whether media_publish went through: look for our caption in recent posts.
  const { body } = await call(job.account, `${job.account.externalId}/media`, { fields: "id,caption,permalink,timestamp", limit: "15" });
  const since = job.scheduledAt.getTime() - 3600_000;
  const hit = (body.data ?? []).find(
    (m: { caption?: string; timestamp: string }) => (m.caption ?? "").trim() === job.caption.trim() && new Date(m.timestamp).getTime() >= since,
  );
  return hit ? { id: hit.id, permalink: hit.permalink } : null;
}

export const instagram: PlatformAdapter = {
  capabilities: { nativeSchedule: false, reschedule: true, cancel: true, autoPublish: true },

  leadMinutes() {
    return PREP_MINUTES;
  },

  async checkAccount(account) {
    try {
      const { body } = await call(account, "me", { fields: "user_id,username,account_type" });
      if (String(body.user_id) !== account.externalId) return { ok: false, error: "Токен принадлежит другому аккаунту" };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async publish(job, state) {
    try {
      if (state.publishCalledAt && !state.mediaId) {
        // We called media_publish before and don't know the result: never post twice.
        const found = await findPublished(job);
        if (found) return { status: "PUBLISHED", externalId: found.id, externalUrl: found.permalink };
        throw new AdapterError("UNKNOWN_RESULT", "Публикация в Instagram могла пройти: проверьте профиль вручную");
      }
      let containerId = state.containerId as string | undefined;
      if (!containerId) {
        if (!job.assetVersion) throw new AdapterError("INVALID", "Нет файла");
        const params: Record<string, string> = {
          media_type: "REELS",
          video_url: await mediaUrl(job.assetVersion.asset, job.assetVersion, 6 * 3600),
          caption: job.caption,
          share_to_feed: "true",
        };
        if (job.coverKey) params.cover_url = coverPublicUrl(job.coverKey, 6 * 3600);
        const { body } = await call(job.account, `${job.account.externalId}/media`, params, "POST");
        containerId = body.id as string;
        return { status: "SENT", state: { containerId, containerCreatedAt: Date.now() }, recheckInSec: 30, note: "Контейнер создан, Instagram обрабатывает видео" };
      }
      return await this.reconcile(job, state);
    } catch (e) {
      igError(e);
    }
  },

  async reconcile(job, state): Promise<Outcome> {
    try {
      if (state.mediaId) {
        const { body } = await call(job.account, String(state.mediaId), { fields: "id,permalink" });
        return { status: "PUBLISHED", externalId: body.id, externalUrl: body.permalink };
      }
      const containerId = state.containerId as string | undefined;
      if (!containerId) return this.publish(job, state);
      const { body } = await call(job.account, containerId, { fields: "status_code,status" });
      switch (body.status_code) {
        case "IN_PROGRESS":
          return { status: "PROCESSING", recheckInSec: 30 };
        case "ERROR":
          throw new AdapterError("INVALID", `Instagram не принял видео: ${body.status ?? ""}`);
        case "EXPIRED": {
          // Safe to recreate only because media_publish was never called for this container.
          if (state.publishCalledAt) throw new AdapterError("UNKNOWN_RESULT", "Контейнер истёк после попытки публикации");
          return { status: "SENT", state: { containerId: null }, recheckInSec: 1, note: "Контейнер истёк, будет создан заново" };
        }
        case "PUBLISHED":
        case "FINISHED": {
          if (Date.now() < job.scheduledAt.getTime() - 15_000)
            return { status: "PROCESSING", recheckInSec: Math.max(5, (job.scheduledAt.getTime() - Date.now()) / 1000), note: "Видео готово, ждём слот" };
          await saveIgState(job.id, { publishCalledAt: Date.now() });
          let mediaId: string;
          try {
            const { body: p } = await call(job.account, `${job.account.externalId}/media_publish`, { creation_id: containerId }, "POST");
            mediaId = p.id;
          } catch (e) {
            if (e instanceof AdapterError && e.kind === "TRANSIENT") {
              const found = await findPublished(job).catch(() => null);
              if (found) return { status: "PUBLISHED", externalId: found.id, externalUrl: found.permalink };
              throw new AdapterError("UNKNOWN_RESULT", `Тайм-аут публикации: ${e.message}`);
            }
            await saveIgState(job.id, { publishCalledAt: null });
            throw e;
          }
          const { body: m } = await call(job.account, mediaId, { fields: "id,permalink" });
          return { status: "PUBLISHED", externalId: mediaId, externalUrl: m.permalink, state: { mediaId } };
        }
        default:
          return { status: "PROCESSING", recheckInSec: 60 };
      }
    } catch (e) {
      igError(e);
    }
  },

  async cancel(_job, state) {
    // Nothing is visible before media_publish; we simply never call it.
    if (state.mediaId || state.publishCalledAt) throw new AdapterError("INVALID", "Уже опубликовано в Instagram: удалите пост вручную");
  },

  async reschedule(_job, state) {
    if (state.mediaId || state.publishCalledAt) throw new AdapterError("INVALID", "Уже опубликовано");
    // Containers expire after 24h; the worker recreates them when needed.
  },
};

async function saveIgState(jobId: string, patch: Record<string, unknown>) {
  const j = await db.publicationJob.findUniqueOrThrow({ where: { id: jobId }, select: { meta: true } });
  const meta = (j.meta ?? {}) as Record<string, any>;
  await db.publicationJob.update({ where: { id: jobId }, data: { meta: { ...meta, adapter: { ...(meta.adapter ?? {}), ...patch } } } });
}

export function igAuthUrl(state: string) {
  const e = env();
  const p = new URLSearchParams({
    client_id: e.INSTAGRAM_APP_ID ?? "",
    redirect_uri: `${e.APP_URL}/api/oauth/instagram/callback`,
    response_type: "code",
    scope: IG_SCOPES.join(","),
    state,
  });
  return `https://www.instagram.com/oauth/authorize?${p}`;
}

export async function igExchange(code: string) {
  const e = env();
  const short = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: e.INSTAGRAM_APP_ID ?? "",
      client_secret: e.INSTAGRAM_APP_SECRET ?? "",
      grant_type: "authorization_code",
      redirect_uri: `${e.APP_URL}/api/oauth/instagram/callback`,
      code,
    }),
  }).then((r) => r.json());
  if (!short.access_token) throw new Error(`Instagram: ${JSON.stringify(short)}`);
  const long = await fetch(
    `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(e.INSTAGRAM_APP_SECRET ?? "")}&access_token=${encodeURIComponent(short.access_token)}`,
  ).then((r) => r.json());
  if (!long.access_token) throw new Error(`Instagram long-lived: ${JSON.stringify(long)}`);
  const me = await fetch(`${GRAPH}/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(long.access_token)}`).then((r) => r.json());
  return { creds: { access_token: long.access_token, expires_at: Date.now() + long.expires_in * 1000 } as IgCreds, me };
}

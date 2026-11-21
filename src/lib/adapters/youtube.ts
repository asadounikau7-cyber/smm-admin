import type { PublicationJob, SocialAccount } from "@prisma/client";
import { db } from "../db";
import { env } from "../env";
import { decryptJson, encryptJson } from "../crypto";
import { mediaStream } from "../mediaSource";
import { notify, resolveNotification } from "../notify";
import { audit } from "../audit";
import { youtubeMeta, YT_META_VERSION } from "../ytMeta";
import { AdapterError, classifyHttp, httpJson, type JobCtx, type Outcome, type PlatformAdapter } from "./types";

export const YT_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube",
];

type YtCreds = { access_token: string; refresh_token: string; expires_at: number };

/** Uploads public videos this many hours ahead and lets YouTube publish them natively via publishAt. */
const LEAD_HOURS = 6;

export async function ytAccessToken(account: SocialAccount): Promise<string> {
  const c = decryptJson<YtCreds>(account.credentials);
  if (!c?.refresh_token) throw new AdapterError("AUTH", "Нет refresh token для YouTube");
  if (c.expires_at > Date.now() + 60_000) return c.access_token;
  const e = env();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: e.GOOGLE_CLIENT_ID ?? "",
      client_secret: e.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: c.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const j = await res.json();
  if (!res.ok) {
    if (j.error === "invalid_grant") throw new AdapterError("AUTH", "Доступ к YouTube отозван или истёк (invalid_grant)");
    throw new AdapterError("TRANSIENT", `Google token: ${JSON.stringify(j).slice(0, 200)}`);
  }
  const next: YtCreds = { ...c, access_token: j.access_token, expires_at: Date.now() + j.expires_in * 1000 };
  await db.socialAccount.update({ where: { id: account.id }, data: { credentials: encryptJson(next), tokenExpiresAt: new Date(next.expires_at) } });
  return next.access_token;
}

async function api(account: SocialAccount, path: string, init: RequestInit = {}) {
  const token = await ytAccessToken(account);
  return httpJson(`https://www.googleapis.com/youtube/v3/${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
}

function statusBody(job: PublicationJob, scheduleNatively: boolean) {
  const meta = (job.meta ?? {}) as { madeForKids?: boolean; aiDisclosure?: boolean };
  const s: Record<string, unknown> = {
    selfDeclaredMadeForKids: Boolean(meta.madeForKids),
    containsSyntheticMedia: Boolean(meta.aiDisclosure),
  };
  if (scheduleNatively) {
    s.privacyStatus = "private";
    s.publishAt = job.scheduledAt.toISOString();
  } else s.privacyStatus = job.visibility.toLowerCase();
  return s;
}

function snippetBody(job: PublicationJob) {
  const tags = (job.meta as { tags?: unknown } | null)?.tags;
  return {
    title: job.title ?? "Video",
    description: job.caption,
    categoryId: "24",
    ...(Array.isArray(tags) && tags.length ? { tags } : {}),
  };
}

/**
 * Brings public (main channel) uploads to the current title/description format: rewrites the job's
 * text and, for a video already on YouTube, its snippet. A few per call to stay light on quota (50 units each).
 */
export async function refreshYoutubeMeta(limit = 10) {
  const jobs = await db.publicationJob.findMany({
    where: {
      platform: "YOUTUBE",
      visibility: "PUBLIC",
      manualEdit: false,
      // Only what isn't on YouTube yet: uploaded videos keep their title (Andrei, 2026-11-20).
      status: "QUEUED",
      externalId: null,
      createdAt: { gt: new Date(Date.now() - 60 * 86400_000) },
    },
    include: { account: true },
    orderBy: { scheduledAt: "asc" },
  });
  const done: string[] = [];
  for (const job of jobs) {
    if (done.length >= limit) break;
    const meta = (job.meta ?? {}) as Record<string, unknown>;
    if (meta.ytMeta === YT_META_VERSION || typeof meta.episodeId !== "string") continue;
    const ep = await db.episode.findUnique({ where: { id: meta.episodeId }, include: { series: true } });
    if (!ep) continue;
    const m = youtubeMeta(ep.series, ep);
    const next = { ...job, title: m.title, caption: m.description, meta: { ...meta, tags: m.tags, ytMeta: YT_META_VERSION } };
    let error: string | null = null;
    if (job.externalId) {
      try {
        await api(job.account, "videos?part=snippet", { method: "PUT", body: JSON.stringify({ id: job.externalId, snippet: snippetBody(next) }) });
      } catch (e) {
        error = (e as Error).message.slice(0, 300);
        console.error(`[youtube] snippet ${job.externalId}:`, error);
        if (/quota/i.test(error)) break; // try again tomorrow
      }
    }
    await db.publicationJob.update({
      where: { id: job.id },
      data: { title: m.title, caption: m.description, meta: { ...next.meta, ...(error ? { ytMetaError: error } : {}) } },
    });
    if (!error && job.externalId) await audit("youtube.snippet.set", "PublicationJob", job.id, null, { videoId: job.externalId, was: job.title, to: m.title });
    done.push(m.title);
  }
  return done;
}

async function sessionStatus(sessionUrl: string, size: number) {
  const res = await fetch(sessionUrl, { method: "PUT", headers: { "content-range": `bytes */${size}`, "content-length": "0" } });
  if (res.status === 200 || res.status === 201) return { done: true as const, video: await res.json() };
  if (res.status === 308) {
    const range = res.headers.get("range");
    const next = range ? Number(range.split("-")[1]) + 1 : 0;
    return { done: false as const, next };
  }
  if (res.status === 404 || res.status === 410) return { done: false as const, expired: true, next: 0 };
  throw classifyHttp(res, await res.text());
}

export const youtube: PlatformAdapter = {
  capabilities: { nativeSchedule: true, reschedule: true, cancel: true, autoPublish: true },

  leadMinutes(job) {
    return job.visibility === "PUBLIC" ? LEAD_HOURS * 60 : 0;
  },

  async checkAccount(account) {
    try {
      const { body } = await api(account, "channels?part=id,snippet&mine=true");
      const ch = body.items?.[0];
      if (!ch) return { ok: false, error: "Канал не найден" };
      if (ch.id !== account.externalId) return { ok: false, error: `Токен принадлежит другому каналу (${ch.id})` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async publish(job, state) {
    if (!job.assetVersion) throw new AdapterError("INVALID", "Нет файла");
    const { asset } = job.assetVersion;
    const size = Number(job.assetVersion.size);
    // Native schedule only works for a private video that hasn't been published, at least a few minutes ahead.
    const scheduleNatively = job.visibility === "PUBLIC" && job.scheduledAt.getTime() - Date.now() > 5 * 60_000;
    let sessionUrl = state.sessionUrl as string | undefined;
    let offset = 0;

    if (sessionUrl) {
      const st = await sessionStatus(sessionUrl, size);
      if (st.done) return afterUpload(job, st.video.id, scheduleNatively);
      if ("expired" in st && st.expired) {
        // The session is gone and YouTube never confirmed a finished upload, so nothing was created.
        sessionUrl = undefined;
      } else offset = st.next;
    }

    if (!sessionUrl) {
      const token = await ytAccessToken(job.account);
      const meta = {
        snippet: snippetBody(job),
        status: statusBody(job, scheduleNatively),
      };
      const res = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-length": String(size),
          "x-upload-content-type": "video/*",
        },
        body: JSON.stringify(meta),
      });
      if (!res.ok) throw classifyHttp(res, await res.text());
      sessionUrl = res.headers.get("location")!;
      // Persist the session before streaming so a crash resumes instead of re-uploading.
      await saveState(job.id, { sessionUrl, scheduleNatively });
    }

    const src = await mediaStream(asset, job.assetVersion, offset);
    let res: Response;
    try {
      res = await fetch(sessionUrl!, {
        method: "PUT",
        headers: {
          "content-length": String(size - offset),
          ...(offset > 0 ? { "content-range": `bytes ${offset}-${size - 1}/${size}` } : {}),
        },
        body: src.stream as unknown as BodyInit,
        // @ts-expect-error Node fetch streaming body
        duplex: "half",
      });
    } catch (e) {
      throw new AdapterError("TRANSIENT", `Обрыв загрузки: ${(e as Error).message}`);
    }
    if (res.status === 200 || res.status === 201) {
      const video = await res.json();
      return afterUpload(job, video.id, scheduleNatively);
    }
    if (res.status === 308) throw new AdapterError("TRANSIENT", "Загрузка прервана, будет продолжена");
    throw classifyHttp(res, await res.text());
  },

  async reconcile(job, state) {
    const id = job.externalId ?? (state.videoId as string | undefined);
    if (!id) {
      if (state.sessionUrl && job.assetVersion) {
        const st = await sessionStatus(state.sessionUrl as string, Number(job.assetVersion.size));
        if (st.done) return afterUpload(job, st.video.id, Boolean(state.scheduleNatively));
      }
      throw new AdapterError("UNKNOWN_RESULT", "Нет ID ролика: результат загрузки неизвестен");
    }
    const { body } = await api(job.account, `videos?part=status,processingDetails&id=${id}`);
    const v = body.items?.[0];
    if (!v) throw new AdapterError("MODERATION", "Ролик не найден на YouTube (удалён или отклонён)");
    const st = v.status;
    if (st.uploadStatus === "rejected" || st.uploadStatus === "failed")
      throw new AdapterError("MODERATION", `YouTube: ${st.uploadStatus} ${st.rejectionReason ?? st.failureReason ?? ""}`);
    const url = `https://www.youtube.com/shorts/${id}`;
    const target = job.visibility.toLowerCase();
    const recheck = (sec: number) => Math.max(60, Math.min(900, Math.round(sec)));
    if (st.uploadStatus !== "processed")
      return { status: "PROCESSING", externalId: id, externalUrl: url, recheckInSec: recheck((job.scheduledAt.getTime() - Date.now()) / 1000) };
    if (target === "private" || st.privacyStatus !== "private") {
      if (state.manualOpen) await resolveNotification(`studio:${job.id}`);
      const note = st.privacyStatus !== target ? `Доступ на YouTube: ${PRIVACY_RU[st.privacyStatus] ?? st.privacyStatus}` : undefined;
      return { status: "PUBLISHED", externalId: id, externalUrl: url, note };
    }
    // Private on YouTube, but the job wants it open. Wait for the slot (YouTube may open it itself via publishAt).
    let publishAt = st.publishAt ? Date.parse(st.publishAt) : 0;
    // YouTube's publish time must match the job (it moves with the conveyor order or «Перенести»).
    // If it differs or is missing, set it again; YouTube's read-back can lag, so each check repeats this
    // until it matches rather than trusting one read.
    if (state.scheduledNatively && Math.abs(publishAt - job.scheduledAt.getTime()) > 60_000 && job.scheduledAt.getTime() > Date.now() + 10 * 60_000) {
      await api(job.account, "videos?part=status", {
        method: "PUT",
        body: JSON.stringify({ id, status: { privacyStatus: "private", publishAt: job.scheduledAt.toISOString(), selfDeclaredMadeForKids: Boolean((job.meta as any)?.madeForKids) } }),
      });
      await audit("youtube.publishAt.set", "PublicationJob", job.id, null, { videoId: id, was: publishAt ? new Date(publishAt).toISOString() : null, to: job.scheduledAt.toISOString() });
      publishAt = job.scheduledAt.getTime();
    }
    const dueAt = Math.max(job.scheduledAt.getTime(), publishAt ? publishAt + 10 * 60_000 : 0);
    const when = publishAt
      ? `YouTube откроет ${new Date(publishAt).toLocaleString("ru-RU", { timeZone: job.timezone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`
      : "без расписания на YouTube, откроется в слот";
    if (Date.now() < dueAt)
      return { status: "PROCESSING", externalId: id, externalUrl: url, recheckInSec: recheck((dueAt - Date.now()) / 1000 + 30), note: `Загружено закрытым, ${when}` };
    // The slot has passed and the video is still private: try opening it through the API once.
    if (!state.apiOpenTried) {
      const meta = (job.meta ?? {}) as { madeForKids?: boolean; aiDisclosure?: boolean };
      let res: string;
      try {
        const r = await ytSetPrivacy(job.account, id, target as "public" | "unlisted", meta);
        res = r.privacyStatus;
      } catch (e) {
        if (e instanceof AdapterError && (e.kind === "TRANSIENT" || e.kind === "RATE_LIMIT" || e.kind === "AUTH")) throw e;
        res = `ошибка: ${(e as Error).message.slice(0, 200)}`;
      }
      await audit("youtube.api.open", "PublicationJob", job.id, null, { videoId: id, target, result: res });
      if (res === target) return { status: "PUBLISHED", externalId: id, externalUrl: url, state: { apiOpenTried: true, apiOpenResult: res }, note: "Открыт через API" };
      return studioTask(job, id, url, { apiOpenTried: true, apiOpenResult: res });
    }
    return studioTask(job, id, url, {});
  },
  async cancel(job, state) {
    const id = job.externalId ?? (state.videoId as string | undefined);
    await resolveNotification(`studio:${job.id}`);
    if (!id) return; // nothing uploaded yet
    // Keep the uploaded file but make sure it never goes public.
    await api(job.account, "videos?part=status", {
      method: "PUT",
      body: JSON.stringify({ id, status: { privacyStatus: "private", publishAt: null, selfDeclaredMadeForKids: Boolean((job.meta as any)?.madeForKids) } }),
    });
    const { body } = await api(job.account, `videos?part=status&id=${id}`);
    const st = body.items?.[0]?.status;
    if (st && (st.privacyStatus !== "private" || st.publishAt)) throw new AdapterError("UNKNOWN_RESULT", "YouTube не подтвердил отмену");
  },

  async reschedule(job, state, at) {
    const id = job.externalId ?? (state.videoId as string | undefined);
    if (!id) return; // not uploaded yet: the new time is enough
    await api(job.account, "videos?part=status", {
      method: "PUT",
      body: JSON.stringify({ id, status: { privacyStatus: "private", publishAt: at.toISOString(), selfDeclaredMadeForKids: Boolean((job.meta as any)?.madeForKids) } }),
    });
    // YouTube's read-back lags, so no check here: each status check compares and sets the time again.
  },
};

const PRIVACY_RU: Record<string, string> = { public: "открытый", unlisted: "по ссылке", private: "закрытый" };

export const studioEditUrl = (videoId: string) => `https://studio.youtube.com/video/${videoId}/edit`;

/** The API could not open the video: hand it to a person, keep checking until it is open in Studio. */
async function studioTask(job: JobCtx, id: string, url: string, extra: Record<string, unknown>): Promise<Outcome> {
  const target = PRIVACY_RU[job.visibility.toLowerCase()] ?? job.visibility;
  const note = `Откройте ролик в Studio (доступ «${target}»): ${studioEditUrl(id)}`;
  if (!(job.meta as any)?.adapter?.manualOpen)
    await notify(`studio:${job.id}`, "studio", `@${job.account.handle}: время публикации наступило, откройте ролик в Studio`, `/publications/${job.id}`);
  return { status: "PROCESSING", externalId: id, externalUrl: url, state: { ...extra, manualOpen: true }, recheckInSec: 600, note };
}

/**
 * Changes a video's visibility through the API and reads back what YouTube actually kept.
 * Unaudited Google projects may be refused or silently left private.
 */
export async function ytSetPrivacy(
  account: SocialAccount,
  videoId: string,
  privacy: "public" | "unlisted" | "private",
  meta: { madeForKids?: boolean; aiDisclosure?: boolean } = {},
) {
  await api(account, "videos?part=status", {
    method: "PUT",
    body: JSON.stringify({
      id: videoId,
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: Boolean(meta.madeForKids), containsSyntheticMedia: Boolean(meta.aiDisclosure) },
    }),
  });
  const { body } = await api(account, `videos?part=status&id=${videoId}`);
  const st = body.items?.[0]?.status;
  if (!st) throw new AdapterError("MODERATION", "Ролик не найден на YouTube");
  return { privacyStatus: st.privacyStatus as string, publishAt: (st.publishAt as string | undefined) ?? null };
}

async function saveState(jobId: string, patch: Record<string, unknown>) {
  const j = await db.publicationJob.findUniqueOrThrow({ where: { id: jobId }, select: { meta: true } });
  const meta = (j.meta ?? {}) as Record<string, any>;
  await db.publicationJob.update({ where: { id: jobId }, data: { meta: { ...meta, adapter: { ...(meta.adapter ?? {}), ...patch } } } });
}

async function afterUpload(job: JobCtx, videoId: string, scheduledNatively: boolean): Promise<Outcome> {
  await saveState(job.id, { videoId });
  if (job.coverKey) {
    try {
      await uploadThumbnail(job, videoId);
    } catch (e) {
      console.warn(`[youtube] thumbnail failed for ${videoId}: ${(e as Error).message}`);
    }
  }
  return {
    status: "PROCESSING",
    externalId: videoId,
    externalUrl: `https://www.youtube.com/shorts/${videoId}`,
    state: { videoId, scheduledNatively },
    recheckInSec: 120,
    note: scheduledNatively ? "Загружено, YouTube опубликует в назначенное время" : "Загружено",
  };
}

async function uploadThumbnail(job: JobCtx, videoId: string) {
  const { readCover } = await import("../covers");
  const buf = await readCover(job.coverKey!);
  const token = await ytAccessToken(job.account);
  const res = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "image/jpeg" },
    body: new Uint8Array(buf),
  });
  if (!res.ok) throw classifyHttp(res, await res.text());
}

export function googleAuthUrl(state: string, codeChallenge: string) {
  const e = env();
  const p = new URLSearchParams({
    client_id: e.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: `${e.APP_URL}/api/oauth/youtube/callback`,
    response_type: "code",
    scope: YT_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function googleExchange(code: string, verifier: string) {
  const e = env();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      code_verifier: verifier,
      client_id: e.GOOGLE_CLIENT_ID ?? "",
      client_secret: e.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: `${e.APP_URL}/api/oauth/youtube/callback`,
      grant_type: "authorization_code",
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Google: ${JSON.stringify(j)}`);
  const creds: YtCreds = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + j.expires_in * 1000 };
  const ch = await fetch("https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true", {
    headers: { authorization: `Bearer ${creds.access_token}` },
  }).then((r) => r.json());
  const items = (ch.items ?? []) as { id: string; snippet: { title: string; customUrl?: string } }[];
  return { creds, channels: items };
}

const REJECTION_RU: Record<string, string> = {
  claim: "заявка Content ID",
  copyright: "нарушение авторских прав",
  duplicate: "дубликат уже загруженного видео",
  inappropriate: "недопустимый контент",
  legal: "юридическая жалоба",
  length: "слишком длинное",
  termsOfUse: "нарушение правил YouTube",
  trademark: "товарный знак",
  uploaderAccountClosed: "канал закрыт",
  uploaderAccountSuspended: "канал заблокирован",
};

export type VideoHealth =
  | { state: "ok"; note: string }
  | { state: "pending"; note: string }
  /** `region` is set when the only problem is Content ID blocking the video in some countries. */
  | { state: "bad"; note: string; region?: { blocked?: string[]; allowed?: string[] } };

/**
 * What YouTube says about an uploaded video right now: removed, rejected, blocked by Content ID in some countries,
 * still processing, or clean. Claims that only take the money (no block) are not visible through the API.
 */
export async function ytVideoHealth(account: SocialAccount, videoId: string, expectedPrivacy: string): Promise<VideoHealth> {
  const { body } = await api(account, `videos?part=status,contentDetails,processingDetails&id=${videoId}`);
  const v = body.items?.[0];
  if (!v) return { state: "bad", note: "Ролик удалён с YouTube или недоступен" };
  const st = v.status ?? {};
  if (st.uploadStatus === "rejected") return { state: "bad", note: `YouTube отклонил: ${REJECTION_RU[st.rejectionReason] ?? st.rejectionReason ?? "без причины"}` };
  if (st.uploadStatus === "failed") return { state: "bad", note: `YouTube не смог обработать файл: ${st.failureReason ?? ""}`.trim() };
  if (st.uploadStatus === "deleted") return { state: "bad", note: "Ролик удалён" };
  const rr = v.contentDetails?.regionRestriction;
  if (st.uploadStatus !== "processed") return { state: "pending", note: "YouTube ещё обрабатывает ролик" };
  if (expectedPrivacy !== "private" && st.privacyStatus === "private") return { state: "bad", note: "YouTube сделал ролик закрытым" };
  if (v.contentDetails?.contentRating?.ytRating === "ytAgeRestricted")
    return { state: "bad", note: "18+: YouTube поставил возрастное ограничение (такие Shorts почти не показываются)" };
  if (rr?.blocked?.length)
    return { state: "bad", note: `Заблокирован в ${rr.blocked.length} странах (Content ID): ${rr.blocked.slice(0, 8).join(", ")}${rr.blocked.length > 8 ? "…" : ""}`, region: { blocked: rr.blocked } };
  if (rr?.allowed) return { state: "bad", note: `Доступен только в ${rr.allowed.length} странах (Content ID): ${rr.allowed.slice(0, 8).join(", ")}`, region: { allowed: rr.allowed } };
  return { state: "ok", note: "Ролик доступен, блокировок нет" };
}

/**
 * Deletes from YouTube the private test uploads this admin made on a channel (before it becomes a
 * main channel). Only our own test jobs are touched, never other videos on the channel; a series
 * still in testing keeps its video. Returns how many videos were deleted.
 */
export async function deleteTestUploads(accountId: string, userId: string | null) {
  const account = await db.socialAccount.findUniqueOrThrow({ where: { id: accountId } });
  const jobs = await db.publicationJob.findMany({
    where: { accountId, platform: "YOUTUBE", visibility: { not: "PUBLIC" }, externalId: { not: null }, instanceKey: { startsWith: "test:" } },
  });
  let deleted = 0;
  const errors: string[] = [];
  for (const job of jobs) {
    const meta = (job.meta ?? {}) as Record<string, unknown>;
    if (meta.deletedFromYouTube) continue;
    const testing = await db.series.findFirst({ where: { testJobId: job.id, stage: "TESTING" } });
    if (testing) continue;
    try {
      await api(account, `videos?id=${job.externalId}`, { method: "DELETE" });
    } catch (e) {
      const msg = (e as Error).message;
      if (!/404|notFound|videoNotFound/i.test(msg)) {
        errors.push(`${job.externalId}: ${msg.slice(0, 120)}`);
        continue;
      }
    }
    await db.publicationJob.update({ where: { id: job.id }, data: { meta: { ...meta, deletedFromYouTube: new Date().toISOString() } } });
    deleted++;
  }
  await audit("youtube.testUploads.deleted", "SocialAccount", accountId, userId, { deleted, errors });
  return { deleted, errors };
}

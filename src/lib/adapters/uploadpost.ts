import { env } from "../env";
import { mediaBuffer } from "../mediaSource";
import { AdapterError, httpJson, type JobCtx, type PlatformAdapter } from "./types";

/**
 * TikTok and Instagram Reels through Upload-Post (paid partner, docs.upload-post.com).
 * Disabled until UPLOAD_POST_API_KEY is set. The account's externalId is the Upload-Post profile
 * ("user") that has the TikTok / Instagram account connected; one profile holds one of each.
 */
const BASE = "https://api.upload-post.com/api";

function key() {
  const k = env().UPLOAD_POST_API_KEY;
  if (!k) throw new AdapterError("INVALID", "Upload-Post не подключён (UPLOAD_POST_API_KEY)");
  return k;
}
const auth = () => ({ authorization: `Apikey ${key()}` });

type UpState = { requestId?: string; jobId?: string; raw?: unknown };
type UpResult = { platform?: string; success?: boolean; message?: string; url?: string; post_url?: string; platform_post_id?: string; skipped?: boolean; skip_reason?: string; error?: string };

/** Upload-Post's per-platform result, from either the status endpoint (array) or a sync upload (object). */
function pick(body: Record<string, any>, platform: string): UpResult | null {
  const r = body.results;
  if (Array.isArray(r)) return (r as UpResult[]).find((x) => x.platform === platform) ?? null;
  if (r && typeof r === "object" && r[platform]) return r[platform] as UpResult;
  return null;
}

function uploadPost(platform: "tiktok" | "instagram", label: string): PlatformAdapter {
  return {
    capabilities: { nativeSchedule: true, reschedule: false, cancel: true, autoPublish: true },

    leadMinutes() {
      return 60;
    },

    async checkAccount(account) {
      try {
        const { body } = await httpJson(`${BASE}/uploadposts/users`, { headers: auth() });
        const p = ((body.profiles ?? []) as { username: string; social_accounts?: Record<string, unknown> }[]).find((x) => x.username === account.externalId);
        if (!p) return { ok: false, error: `В Upload-Post нет профиля «${account.externalId}»` };
        if (p.social_accounts && !p.social_accounts[platform]) return { ok: false, error: `В профиле «${account.externalId}» не подключён ${label}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },

    async publish(job, state) {
      const st = state as UpState;
      if (st.requestId || st.jobId) return this.reconcile(job, state);
      if (!job.assetVersion) throw new AdapterError("INVALID", "Нет файла");
      const buf = await mediaBuffer(job.assetVersion.asset, job.assetVersion);
      const form = new FormData();
      form.append("user", job.account.externalId);
      form.append("platform[]", platform);
      form.append("title", job.caption);
      form.append("external_id", job.id);
      if (platform === "instagram") {
        form.append("media_type", "REELS");
        form.append("share_to_feed", "true");
      }
      form.append("video", new Blob([new Uint8Array(buf)], { type: "video/mp4" }), "video.mp4");
      const scheduled = job.scheduledAt.getTime() - Date.now() > 10 * 60_000;
      if (scheduled) form.append("scheduled_date", job.scheduledAt.toISOString());
      else form.append("async_upload", "true");
      const { body } = await httpJson(`${BASE}/upload`, {
        method: "POST",
        body: form,
        headers: { ...auth(), "idempotency-key": job.idempotencyKey },
        timeoutMs: 300_000,
      });
      if (body.success === false) throw new AdapterError("INVALID", `Upload-Post: ${String(body.message ?? JSON.stringify(body)).slice(0, 300)}`);
      const next: UpState = { requestId: body.request_id, jobId: body.job_id, raw: body };
      const done = pick(body, platform);
      if (done?.success && (done.url || done.post_url)) return { status: "PUBLISHED", externalId: done.platform_post_id ?? done.url ?? done.post_url, externalUrl: done.url ?? done.post_url, state: next as Record<string, unknown> };
      return {
        status: "SENT",
        state: next as Record<string, unknown>,
        recheckInSec: scheduled ? Math.max(120, Math.round((job.scheduledAt.getTime() - Date.now()) / 1000) + 120) : 120,
        note: scheduled ? `Передано в Upload-Post, выйдет по расписанию` : "Передано в Upload-Post",
      };
    },

    async reconcile(job, state) {
      const st = state as UpState;
      const q = st.jobId ? `job_id=${encodeURIComponent(st.jobId)}` : st.requestId ? `request_id=${encodeURIComponent(st.requestId)}` : null;
      if (!q) throw new AdapterError("UNKNOWN_RESULT", "Нет ID запроса Upload-Post");
      let body: Record<string, any>;
      try {
        ({ body } = await httpJson(`${BASE}/uploadposts/status?${q}`, { headers: auth() }));
      } catch (e) {
        if (e instanceof AdapterError && e.httpStatus === 404 && st.jobId && job.scheduledAt.getTime() > Date.now())
          return { status: "SENT", recheckInSec: 600, note: "Ждёт времени публикации в Upload-Post" };
        throw e;
      }
      const r = pick(body, platform);
      if (r?.skipped) throw new AdapterError("MODERATION", `${label}: пропущено (${r.skip_reason ?? "без причины"})`);
      if (r?.success === false || (body.status === "failed" && !r?.success))
        throw new AdapterError("MODERATION", `${label}/Upload-Post: ${String(r?.message ?? r?.error ?? body.message ?? "ошибка").slice(0, 300)}`);
      const url = r?.url ?? r?.post_url;
      if (r?.success) return { status: "PUBLISHED", externalId: r.platform_post_id ?? url ?? st.jobId ?? st.requestId, externalUrl: url };
      const waiting = job.scheduledAt.getTime() > Date.now();
      return { status: waiting ? "SENT" : "PROCESSING", recheckInSec: waiting ? Math.min(3600, Math.max(120, Math.round((job.scheduledAt.getTime() - Date.now()) / 1000) + 60)) : 180 };
    },

    async cancel(_job: JobCtx, state) {
      const st = state as UpState;
      if (!st.jobId) throw new AdapterError("INVALID", `Отмена возможна только для запланированных постов: удалите пост в ${label} вручную`);
      try {
        await httpJson(`${BASE}/uploadposts/schedule/${encodeURIComponent(st.jobId)}`, { method: "DELETE", headers: auth() });
      } catch (e) {
        if (e instanceof AdapterError && e.httpStatus === 404) return;
        throw e;
      }
    },
  };
}

export const uploadPostTikTok = uploadPost("tiktok", "TikTok");
export const uploadPostInstagram = uploadPost("instagram", "Instagram");

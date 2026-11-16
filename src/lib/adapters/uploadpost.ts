import { env } from "../env";
import { mediaBuffer } from "../mediaSource";
import { AdapterError, httpJson, type PlatformAdapter } from "./types";

/**
 * TikTok through Upload-Post (paid partner). Disabled until UPLOAD_POST_API_KEY is set.
 * The account's externalId is the Upload-Post profile name that has the TikTok account connected.
 * Endpoint and field names follow docs.upload-post.com; verify on a test account before turning it on.
 */
const BASE = "https://api.upload-post.com/api";

function key() {
  const k = env().UPLOAD_POST_API_KEY;
  if (!k) throw new AdapterError("INVALID", "Upload-Post не подключён (UPLOAD_POST_API_KEY)");
  return k;
}

export const uploadPostTikTok: PlatformAdapter = {
  capabilities: { nativeSchedule: true, reschedule: false, cancel: false, autoPublish: true },

  leadMinutes() {
    return 60;
  },

  async checkAccount(account) {
    try {
      await httpJson(`${BASE}/uploadposts/users`, { headers: { authorization: `Apikey ${key()}` } });
      return { ok: Boolean(account.externalId) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async publish(job, state) {
    if (state.requestId) return this.reconcile(job, state);
    if (!job.assetVersion) throw new AdapterError("INVALID", "Нет файла");
    const buf = await mediaBuffer(job.assetVersion.asset, job.assetVersion);
    const form = new FormData();
    form.append("user", job.account.externalId);
    form.append("platform[]", "tiktok");
    form.append("title", job.caption);
    form.append("video", new Blob([new Uint8Array(buf)], { type: "video/mp4" }), "video.mp4");
    if (job.scheduledAt.getTime() - Date.now() > 10 * 60_000) form.append("scheduled_date", job.scheduledAt.toISOString());
    form.append("async_upload", "true");
    const { body } = await httpJson(`${BASE}/upload`, { method: "POST", body: form, headers: { authorization: `Apikey ${key()}` }, timeoutMs: 300_000 });
    const requestId = body.request_id ?? body.job_id ?? body.id;
    return { status: "SENT", state: { requestId, raw: body }, recheckInSec: 120, note: "Передано в Upload-Post" };
  },

  async reconcile(_job, state) {
    if (!state.requestId) throw new AdapterError("UNKNOWN_RESULT", "Нет ID запроса Upload-Post");
    const { body } = await httpJson(`${BASE}/uploadposts/status?request_id=${encodeURIComponent(String(state.requestId))}`, {
      headers: { authorization: `Apikey ${key()}` },
    });
    const r = body.results?.tiktok ?? body.result ?? body;
    const url: string | undefined = r?.url ?? r?.post_url;
    if (r?.success === false) throw new AdapterError("MODERATION", `TikTok/Upload-Post: ${JSON.stringify(r).slice(0, 300)}`);
    if (url) return { status: "PUBLISHED", externalId: r.publish_id ?? r.id ?? url, externalUrl: url };
    return { status: "PROCESSING", recheckInSec: 300 };
  },

  async cancel() {
    throw new AdapterError("INVALID", "Отмена через Upload-Post не поддерживается: удалите пост в их кабинете");
  },
};

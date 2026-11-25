import type { AssetVersion, Asset, PublicationJob, SocialAccount } from "@prisma/client";

export type JobCtx = PublicationJob & {
  account: SocialAccount;
  assetVersion: (AssetVersion & { asset: Asset }) | null;
};

export type ErrorKind =
  | "TRANSIENT" // network, 5xx: retry with backoff
  | "RATE_LIMIT" // 429/quota: retry after Retry-After
  | "AUTH" // token revoked/expired: pause account, notify
  | "INVALID" // bad format/metadata: exception, no retry
  | "MODERATION" // rejected by platform
  | "UNKNOWN_RESULT"; // sent, but we can't tell whether it posted: never auto-repost

export class AdapterError extends Error {
  constructor(public kind: ErrorKind, message: string, public httpStatus?: number, public retryAfterSec?: number) {
    super(message);
  }
}

export type Outcome = {
  status: "SENT" | "PROCESSING" | "PUBLISHED" | "ACTION_REQUIRED";
  externalId?: string;
  externalUrl?: string;
  /// adapter-specific state persisted in job.meta.adapter (upload session, container id, …)
  state?: Record<string, unknown>;
  /// when the worker should look at this job again
  recheckInSec?: number;
  note?: string;
};

export type Capabilities = { nativeSchedule: boolean; reschedule: boolean; cancel: boolean; autoPublish: boolean };

export interface PlatformAdapter {
  capabilities: Capabilities;
  /// minutes before scheduledAt the worker should start working on the job
  leadMinutes(job: PublicationJob): number;
  checkAccount(account: SocialAccount): Promise<{ ok: boolean; error?: string }>;
  /// prepare + send/schedule. Must be safe to call again with the saved state.
  publish(job: JobCtx, state: Record<string, unknown>): Promise<Outcome>;
  /// look up the result by external id / saved state
  reconcile(job: JobCtx, state: Record<string, unknown>): Promise<Outcome>;
  cancel(job: JobCtx, state: Record<string, unknown>): Promise<void>;
  reschedule?(job: JobCtx, state: Record<string, unknown>, at: Date): Promise<void>;
}

export async function httpJson(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 60_000) });
  } catch (e) {
    throw new AdapterError("TRANSIENT", `Сеть: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw classifyHttp(res, body);
  return { res, body: body as Record<string, any> };
}

export function classifyHttp(res: Response, body: unknown): AdapterError {
  const msg = typeof body === "object" && body ? JSON.stringify(body).slice(0, 400) : String(body).slice(0, 400);
  const ra = Number(res.headers.get("retry-after")) || undefined;
  if (res.status === 429) return new AdapterError("RATE_LIMIT", `429: ${msg}`, 429, ra ?? 60);
  // YouTube's per-channel daily upload cap: wait it out instead of failing the job.
  if (res.status === 400 && /uploadLimitExceeded|exceeded the number of videos/i.test(msg)) return new AdapterError("RATE_LIMIT", `Дневной лимит загрузок канала: ${msg}`, 400, 4 * 3600);
  if (res.status === 401) return new AdapterError("AUTH", `401: ${msg}`, 401);
  if (res.status === 403 && /quota/i.test(msg)) return new AdapterError("RATE_LIMIT", `Квота: ${msg}`, 403, 3600);
  if (res.status === 403) return new AdapterError("AUTH", `403: ${msg}`, 403);
  if (res.status >= 500) return new AdapterError("TRANSIENT", `${res.status}: ${msg}`, res.status, ra);
  return new AdapterError("INVALID", `${res.status}: ${msg}`, res.status);
}

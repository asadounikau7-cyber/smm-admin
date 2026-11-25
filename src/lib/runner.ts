import type { PublicationJob } from "@prisma/client";
import { db } from "./db";
import { adapterFor } from "./adapters";
import { AdapterError, type Outcome } from "./adapters/types";
import { validate } from "./validators";
import { checkOutage, notify, resolveNotification } from "./notify";
import { audit } from "./audit";

const LEASE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 6;

function backoffSec(attempt: number, retryAfter?: number) {
  if (retryAfter) return retryAfter;
  const base = Math.min(30 * 2 ** attempt, 30 * 60);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

const adapterState = (j: PublicationJob) => (((j.meta ?? {}) as Record<string, any>).adapter ?? {}) as Record<string, unknown>;

/** Atomically takes a job for this worker; returns false if someone else holds it. */
export async function claim(jobId: string, statuses: PublicationJob["status"][]) {
  const now = new Date();
  const r = await db.publicationJob.updateMany({
    where: { id: jobId, status: { in: statuses }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
  });
  return r.count === 1;
}

async function loadCtx(jobId: string) {
  return db.publicationJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { account: true, assetVersion: { include: { asset: true } } },
  });
}

/** Runs one step of a job: first send (QUEUED) or a follow-up check (SENT/PROCESSING). */
export async function runJob(jobId: string) {
  const job = await loadCtx(jobId);
  const adapter = adapterFor(job.account);
  if (!adapter) {
    await db.publicationJob.update({ where: { id: job.id }, data: { leaseUntil: null } });
    return;
  }
  const state = adapterState(job);
  const first = job.status === "QUEUED";
  const attempt = await db.publicationAttempt.create({ data: { jobId: job.id, step: first ? "publish" : "reconcile" } });

  try {
    if (first) {
      // Pre-send re-check with the current account status and file.
      const reasons = validate({
        format: job.format,
        account: job.account,
        version: job.assetVersion ? { ...job.assetVersion, deleted: Boolean(job.assetVersion.asset.deletedAt) } : null,
        caption: job.caption,
        title: job.title,
      });
      if (reasons.length) throw new AdapterError(job.account.status === "NEEDS_RECONNECT" ? "AUTH" : "INVALID", reasons.join("; "));
    }
    const out: Outcome = first ? await adapter.publish(job, state) : await adapter.reconcile(job, state);
    await applyOutcome(job, out);
    await db.publicationAttempt.update({ where: { id: attempt.id }, data: { finishedAt: new Date(), ok: true, message: out.note ?? out.status, state: (out.state ?? undefined) as object | undefined } });
  } catch (e) {
    const err = e instanceof AdapterError ? e : new AdapterError("TRANSIENT", (e as Error).message);
    await db.publicationAttempt.update({
      where: { id: attempt.id },
      data: { finishedAt: new Date(), ok: false, errorCode: err.kind, httpStatus: err.httpStatus, message: err.message.slice(0, 1000) },
    });
    await applyError(job, err);
  }
}

async function applyOutcome(job: PublicationJob, out: Outcome) {
  const meta = (job.meta ?? {}) as Record<string, any>;
  const status = out.status === "PUBLISHED" ? "PUBLISHED" : out.status === "SENT" ? "SENT" : out.status === "ACTION_REQUIRED" ? "ACTION_REQUIRED" : "PROCESSING";
  await db.publicationJob.update({
    where: { id: job.id },
    data: {
      status,
      externalId: out.externalId ?? job.externalId,
      externalUrl: out.externalUrl ?? job.externalUrl,
      meta: { ...meta, adapter: { ...(meta.adapter ?? {}), ...(out.state ?? {}) } },
      leaseUntil: null,
      nextAttemptAt: out.recheckInSec ? new Date(Date.now() + out.recheckInSec * 1000) : null,
      errorCode: null,
      errorMessage: out.note ?? null,
    },
  });
  if (status === "PUBLISHED") {
    await resolveNotification(`job:${job.id}`);
    await audit("job.published", "PublicationJob", job.id, null, { url: out.externalUrl ?? null });
  }
}

async function applyError(job: PublicationJob, err: AdapterError) {
  const attempts = job.attemptCount + 1;
  const base = { leaseUntil: null, attemptCount: attempts, errorCode: err.kind, errorMessage: err.message.slice(0, 1000) };
  const link = `/publications?job=${job.id}`;
  const outage = () => (err.kind === "MODERATION" || err.kind === "RATE_LIMIT" ? null : checkOutage(job.platform, err.message).catch((e) => console.warn(`[outage] ${(e as Error).message}`)));

  if ((err.kind === "TRANSIENT" || err.kind === "RATE_LIMIT") && attempts < MAX_ATTEMPTS) {
    await db.publicationJob.update({ where: { id: job.id }, data: { ...base, nextAttemptAt: new Date(Date.now() + backoffSec(attempts, err.retryAfterSec) * 1000) } });
    await outage();
    return;
  }
  if (err.kind === "AUTH") {
    await db.socialAccount.update({ where: { id: job.accountId }, data: { status: "NEEDS_RECONNECT", lastError: err.message.slice(0, 500) } });
    // Pause everything else waiting on this account.
    await db.publicationJob.updateMany({
      where: { accountId: job.accountId, status: "QUEUED", id: { not: job.id } },
      data: { status: "ACTION_REQUIRED", errorCode: "AUTH", errorMessage: "Пауза: нет доступа к аккаунту" },
    });
    await db.publicationJob.update({ where: { id: job.id }, data: { ...base, status: "ACTION_REQUIRED" } });
    await notify(`account:${job.accountId}`, "auth", `Потерян доступ к аккаунту. Задачи на паузе до переподключения.`, `/accounts`);
    return;
  }
  const status = err.kind === "UNKNOWN_RESULT" ? "UNKNOWN" : err.kind === "MODERATION" ? "ACTION_REQUIRED" : "FAILED";
  await db.publicationJob.update({ where: { id: job.id }, data: { ...base, status } });
  await outage();
  if (err.kind === "MODERATION" && job.platform === "YOUTUBE" && /не найден/i.test(err.message)) {
    const { stopSeriesAfterRemoval } = await import("./seriesTest");
    await stopSeriesAfterRemoval(job.id, err.message).catch((e) => console.warn(`[removal] ${job.id}: ${(e as Error).message}`));
  }
  const label = status === "UNKNOWN" ? "Результат публикации неизвестен, проверьте вручную" : status === "FAILED" ? "Ошибка публикации" : "Отклонено площадкой";
  await notify(`job:${job.id}`, err.kind.toLowerCase(), `${label}: ${err.message.slice(0, 200)}`, link);
}

/** Cancel/reschedule for jobs already handed to the platform. */
export async function runCancel(jobId: string) {
  const job = await loadCtx(jobId);
  const adapter = adapterFor(job.account);
  try {
    if (adapter && job.externalId) await adapter.cancel(job, adapterState(job));
    await db.publicationJob.update({ where: { id: job.id }, data: { status: "CANCELLED", leaseUntil: null, errorMessage: null } });
    await audit("job.cancelled", "PublicationJob", job.id, null);
  } catch (e) {
    const err = e instanceof AdapterError ? e : new AdapterError("TRANSIENT", (e as Error).message);
    if (err.kind === "TRANSIENT" || err.kind === "RATE_LIMIT") {
      await db.publicationJob.update({ where: { id: job.id }, data: { leaseUntil: null, nextAttemptAt: new Date(Date.now() + backoffSec(1, err.retryAfterSec) * 1000), errorMessage: err.message } });
      return;
    }
    await db.publicationJob.update({ where: { id: job.id }, data: { leaseUntil: null, status: "ACTION_REQUIRED", errorCode: err.kind, errorMessage: `Отмена не подтверждена: ${err.message}` } });
    await notify(`job:${job.id}`, "cancel", `Отмена не подтверждена площадкой: ${err.message.slice(0, 150)}`, `/publications?job=${job.id}`);
  }
}

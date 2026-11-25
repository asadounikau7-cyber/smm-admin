import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { env } from "./env";
import { toLocal } from "./time";

/** Failures on our side (key, token, network, quota): nothing the platform said about the video itself. */
const OUR_SIDE = ["TRANSIENT", "AUTH", "RATE_LIMIT"];
const FAR = 30 * 86400_000;

export type Recovered = { reconcile: number; mainLine: number; retests: number; retried: number; notes: number };

/** Jobs «Перезапустить упавшие» would pick up. */
export const recoverableWhere: Prisma.PublicationJobWhereInput = {
  OR: [
    { status: "FAILED", errorCode: { in: OUR_SIDE } },
    { status: "ACTION_REQUIRED", errorCode: "AUTH" },
    // YouTube's daily upload cap (counted as INVALID before 2026-11-25).
    { status: "FAILED", errorMessage: { contains: "exceeded the number of videos" } },
  ],
};

/**
 * After an outage (2026-11-24: a broken Google key failed every YouTube call for 15 hours) the failed jobs
 * go back without duplicates and without a burst:
 * - already uploaded (has a video id): only checked again, never uploaded twice;
 * - an episode of a main channel's line: back in the line, the conveyor puts it on the next free slot in order;
 * - a test: the series goes back to the front of the test queue and is tested again in the usual slots,
 *   so the test channels stay within YouTube's daily upload limit;
 * - anything else: sent again at its time, or a few minutes apart if that time has passed.
 */
export async function recoverFailedJobs(now = new Date()): Promise<Recovered> {
  const jobs = await db.publicationJob.findMany({ where: recoverableWhere, orderBy: { scheduledAt: "asc" } });
  const out: Recovered = { reconcile: 0, mainLine: 0, retests: 0, retried: 0, notes: 0 };
  const inLine = new Set(
    (await db.channelQueueItem.findMany({ where: { jobId: { in: jobs.map((j) => j.id) } }, select: { jobId: true } })).map((i) => i.jobId),
  );
  const clean = { errorCode: null, errorMessage: null, attemptCount: 0, leaseUntil: null, rowVersion: { increment: 1 } } as const;
  const retests = new Map<string, Date>();
  let gap = 0;
  for (const job of jobs) {
    const meta = (job.meta ?? {}) as Record<string, unknown> & { purpose?: string; seriesId?: string };
    if (job.externalId) {
      await db.publicationJob.update({ where: { id: job.id }, data: { ...clean, status: "PROCESSING", nextAttemptAt: now } });
      out.reconcile++;
    } else if (inLine.has(job.id)) {
      // Far ahead = "not sent yet" for the conveyor, which moves it to the first free slot of the line.
      const at = new Date(now.getTime() + FAR);
      await db.publicationJob.update({
        where: { id: job.id },
        data: { ...clean, status: "QUEUED", nextAttemptAt: null, scheduledAt: at, localTime: toLocal(at, job.timezone), deadlineAt: new Date(at.getTime() + env().CATCHUP_WINDOW_MIN * 60_000), meta: { ...meta, adapter: {} } as Prisma.InputJsonValue },
      });
      out.mainLine++;
    } else if (meta.purpose === "test" && meta.seriesId) {
      const first = retests.get(meta.seriesId);
      if (!first || job.scheduledAt < first) retests.set(meta.seriesId, job.scheduledAt);
    } else {
      const due = new Date(now.getTime() + (2 + 3 * gap) * 60_000);
      const at = job.scheduledAt.getTime() < due.getTime() ? (gap++, due) : job.scheduledAt;
      await db.publicationJob.update({
        where: { id: job.id },
        data: { ...clean, status: "QUEUED", nextAttemptAt: null, scheduledAt: at, localTime: toLocal(at, job.timezone), deadlineAt: new Date(at.getTime() + env().CATCHUP_WINDOW_MIN * 60_000), meta: { ...meta, adapter: {} } as Prisma.InputJsonValue },
      });
      out.retried++;
    }
  }
  for (const [seriesId, since] of retests) {
    const series = await db.series.findUnique({ where: { id: seriesId } });
    // Unfinished test uploads of this series are dropped; what is already on the test channel stays.
    await db.publicationJob.updateMany({
      where: { status: { in: ["FAILED", "QUEUED", "ACTION_REQUIRED"] }, externalId: null, AND: [{ meta: { path: ["seriesId"], equals: seriesId } }, { meta: { path: ["purpose"], equals: "test" } }] },
      data: { status: "CANCELLED", nextAttemptAt: null },
    });
    if (series && ["TESTING", "NEW"].includes(series.stage) && !series.bannedAt)
      await db.series.update({
        where: { id: seriesId },
        // An early date puts it at the front of the test queue.
        data: { stage: "NEW", testJobId: null, testLiveAt: null, testCheckedAt: null, testQueuedAt: since, testNote: "Тест перезапущен после сбоя ключа Google" },
      });
    out.retests++;
  }
  const active = await db.socialAccount.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  const r = await db.notification.updateMany({
    where: {
      resolved: false,
      OR: [{ dedupKey: { in: [...jobs.map((j) => `job:${j.id}`), ...active.map((a) => `account:${a.id}`)] } }, { message: { contains: "invalid_client" } }],
    },
    data: { resolved: true },
  });
  out.notes = r.count;
  return out;
}

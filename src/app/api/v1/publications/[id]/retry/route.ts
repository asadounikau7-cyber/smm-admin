import { DateTime } from "luxon";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { apiUser, json } from "@/lib/apiAuth";

/** POST { confirmRepost?: boolean } — re-queues FAILED/UNKNOWN/ACTION_REQUIRED. UNKNOWN needs confirmRepost. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await apiUser(true);
  if (error) return error;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const job = await db.publicationJob.findUnique({ where: { id } });
  if (!job) return json({ error: "not found" }, 404);
  if (!["FAILED", "UNKNOWN", "ACTION_REQUIRED"].includes(job.status)) return json({ error: `cannot retry from ${job.status}` }, 409);
  if (job.status === "UNKNOWN" && !body.confirmRepost) return json({ error: "result of the last attempt is unknown; pass confirmRepost: true after checking" }, 409);
  const at = job.scheduledAt.getTime() < Date.now() ? new Date(Date.now() + 2 * 60_000) : job.scheduledAt;
  const meta = (job.meta ?? {}) as Record<string, unknown>;
  await db.publicationJob.update({
    where: { id },
    data: {
      status: "QUEUED", attemptCount: 0, nextAttemptAt: null, errorCode: null, errorMessage: null, externalId: null, externalUrl: null,
      scheduledAt: at, localTime: DateTime.fromJSDate(at, { zone: job.timezone }).toFormat("yyyy-LL-dd HH:mm"), deadlineAt: new Date(at.getTime() + env().CATCHUP_WINDOW_MIN * 60_000), meta: { ...meta, adapter: {} }, rowVersion: { increment: 1 },
    },
  });
  await audit("job.retry", "PublicationJob", id, user.id);
  return json({ ok: true });
}

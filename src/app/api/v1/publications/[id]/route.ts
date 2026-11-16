import { DateTime } from "luxon";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { adapterFor } from "@/lib/adapters";
import { audit } from "@/lib/audit";
import { apiUser, json } from "@/lib/apiAuth";

/**
 * PATCH { rowVersion, scheduledAt?, caption?, title?, action?: "cancel" }
 * Optimistic concurrency: rowVersion must match, otherwise 409.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await apiUser(true);
  if (error) return error;
  const { id } = await params;
  const body = await req.json();
  const job = await db.publicationJob.findUnique({ where: { id }, include: { account: true, assetVersion: { include: { asset: true } } } });
  if (!job) return json({ error: "not found" }, 404);
  if (body.rowVersion !== job.rowVersion) return json({ error: "conflict", rowVersion: job.rowVersion }, 409);

  const data: Record<string, unknown> = {};
  if (body.action === "cancel") {
    data.status = job.externalId || ["SENT", "PROCESSING"].includes(job.status) ? "CANCEL_PENDING" : "CANCELLED";
  } else {
    if (body.scheduledAt) {
      const at = new Date(body.scheduledAt);
      if (job.externalId) {
        const ad = adapterFor(job.account);
        if (!ad?.reschedule) return json({ error: "platform does not support rescheduling a handed-over post" }, 422);
        await ad.reschedule(job, ((job.meta as any)?.adapter ?? {}) as Record<string, unknown>, at);
      }
      data.scheduledAt = at;
      data.localTime = DateTime.fromJSDate(at, { zone: job.timezone }).toFormat("yyyy-LL-dd HH:mm");
      data.deadlineAt = new Date(at.getTime() + env().CATCHUP_WINDOW_MIN * 60_000);
    }
    if (!job.externalId) {
      if (typeof body.caption === "string") data.caption = body.caption;
      if (typeof body.title === "string") data.title = body.title;
    }
  }
  const r = await db.publicationJob.updateMany({ where: { id, rowVersion: job.rowVersion }, data: { ...data, rowVersion: { increment: 1 } } });
  if (!r.count) return json({ error: "conflict" }, 409);
  await audit(body.action === "cancel" ? "job.cancel" : "job.update", "PublicationJob", id, user.id, data as object);
  return json(await db.publicationJob.findUnique({ where: { id } }));
}

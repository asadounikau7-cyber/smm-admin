import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/** For an external uptime monitor: 503 when the worker heartbeat is stale or overdue jobs pile up. */
export async function GET() {
  const hb = await db.setting.findUnique({ where: { key: "workerHeartbeat" } });
  const at = hb ? new Date((hb.value as { at: string }).at) : null;
  const workerOk = Boolean(at && Date.now() - at.getTime() < 2 * 60_000);
  const overdue = await db.publicationJob.count({ where: { status: "QUEUED", deadlineAt: { lt: new Date() } } });
  const ok = workerOk && overdue === 0;
  return NextResponse.json({ ok, worker: workerOk ? "up" : "down", workerHeartbeat: at, overdue }, { status: ok ? 200 : 503 });
}

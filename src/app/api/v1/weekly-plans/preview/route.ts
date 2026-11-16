import { DateTime } from "luxon";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { buildWeek } from "@/lib/planner";
import { apiUser, json } from "@/lib/apiAuth";

/** POST { week: "2026-11-23" } → builds/refreshes the draft and returns its rows. */
export async function POST(req: Request) {
  const { user, error } = await apiUser();
  if (error) return error;
  const body = await req.json().catch(() => ({}));
  const tz = env().BASE_TIMEZONE;
  const monday = (body.week ? DateTime.fromISO(body.week, { zone: tz }) : DateTime.now().setZone(tz)).startOf("week");
  const planId = await buildWeek(monday.toUTC().toJSDate(), user.id);
  const plan = await db.weeklyPlan.findUnique({ where: { id: planId }, include: { jobs: { include: { account: true }, orderBy: { scheduledAt: "asc" } } } });
  return json({
    id: plan!.id,
    weekStart: plan!.weekStart,
    status: plan!.status,
    rows: plan!.jobs.map((j) => ({
      id: j.id, status: j.status, excluded: j.excluded, platform: j.platform, account: `@${j.account.handle}`, format: j.format,
      scheduledAt: j.scheduledAt, localTime: j.localTime, timezone: j.timezone, visibility: j.visibility, caption: j.caption, title: j.title,
      assetVersionId: j.assetVersionId, blockReasons: j.blockReasons, rowVersion: j.rowVersion,
    })),
  });
}

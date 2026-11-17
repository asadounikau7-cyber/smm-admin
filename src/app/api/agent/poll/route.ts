import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentAuthorized } from "@/lib/agentAuth";
import { env } from "@/lib/env";
import { claimRender, getRenderMode, renderTask, failRender } from "@/lib/renderJobs";

/**
 * The agent on the owner's computer calls this every few seconds (outbound HTTPS, no open ports).
 * Body: { hostname, octo: { reachable, apiAvailable, username? }, running?: string[] (octo uuids),
 *         render?: { enabled: boolean, busy: boolean } }.
 * Returns commands to execute (each handed out once) and, when the agent renders, at most one render task.
 */
export async function POST(req: Request) {
  if (!agentAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const value = { at: new Date().toISOString(), hostname: String(body.hostname ?? ""), octo: body.octo ?? null, version: String(body.version ?? ""), render: Boolean(body.render?.enabled) };
  await db.setting.upsert({ where: { key: "agentHeartbeat" }, update: { value }, create: { key: "agentHeartbeat", value } });

  if (!body.octo?.apiAvailable) {
    // Without the profile API we can't know what is running.
    await db.octoProfile.updateMany({ where: { running: true }, data: { running: false } });
  } else if (Array.isArray(body.running)) {
    const running = body.running.map(String);
    await db.octoProfile.updateMany({ where: { octoUuid: { in: running } }, data: { running: true, lastSeenAt: new Date() } });
    await db.octoProfile.updateMany({ where: { OR: [{ octoUuid: null }, { octoUuid: { notIn: running } }] }, data: { running: false } });
  }

  // Commands older than 10 minutes are stale (the owner clicked while the computer was off).
  await db.agentCommand.updateMany({
    where: { status: "PENDING", createdAt: { lt: new Date(Date.now() - 10 * 60_000) } },
    data: { status: "FAILED", error: "Агент не забрал команду за 10 минут" },
  });
  const pending = await db.agentCommand.findMany({ where: { status: "PENDING" }, include: { profile: true }, orderBy: { createdAt: "asc" }, take: 5 });
  if (pending.length)
    await db.agentCommand.updateMany({ where: { id: { in: pending.map((c) => c.id) }, status: "PENDING" }, data: { status: "TAKEN", takenAt: new Date() } });
  let render = null;
  if (body.render?.enabled && !body.render?.busy && (await getRenderMode()) !== "server") {
    const id = await claimRender(`agent:${value.hostname || "pc"}`);
    if (id) {
      try {
        render = await renderTask(id, env().APP_URL);
      } catch (e) {
        await failRender(id, (e as Error).message);
      }
    }
  }
  return NextResponse.json({
    render,
    commands: pending.map((c) => ({ id: c.id, type: c.type, octoUuid: c.profile?.octoUuid ?? null, title: c.profile?.title ?? null, url: c.url })),
  });
}

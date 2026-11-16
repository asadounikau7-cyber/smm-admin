import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentAuthorized } from "@/lib/agentAuth";

/** Body: { id, ok, error?, result? }. For LIST_PROFILES, result.profiles = [{ uuid, title }] fills the registry. */
export async function POST(req: Request) {
  if (!agentAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  const cmd = await db.agentCommand.findUnique({ where: { id: String(body.id) } });
  if (!cmd) return NextResponse.json({ error: "not found" }, { status: 404 });
  await db.agentCommand.update({
    where: { id: cmd.id },
    data: { status: body.ok ? "DONE" : "FAILED", error: body.ok ? null : String(body.error ?? "ошибка").slice(0, 500), result: body.result ?? undefined, doneAt: new Date() },
  });
  if (body.ok && cmd.profileId && (cmd.type === "START_PROFILE" || cmd.type === "STOP_PROFILE"))
    await db.octoProfile.update({ where: { id: cmd.profileId }, data: { running: cmd.type === "START_PROFILE", lastSeenAt: new Date() } });
  if (body.ok && cmd.type === "LIST_PROFILES" && Array.isArray(body.result?.profiles)) {
    for (const p of body.result.profiles as { uuid: string; title: string }[]) {
      if (!p.uuid) continue;
      const byUuid = await db.octoProfile.findUnique({ where: { octoUuid: p.uuid } });
      if (byUuid) await db.octoProfile.update({ where: { id: byUuid.id }, data: { title: p.title || byUuid.title } });
      else {
        // Attach the uuid to a manually created profile with the same title, otherwise create one.
        const byTitle = await db.octoProfile.findFirst({ where: { title: p.title, octoUuid: null } });
        if (byTitle) await db.octoProfile.update({ where: { id: byTitle.id }, data: { octoUuid: p.uuid } });
        else await db.octoProfile.create({ data: { title: p.title || p.uuid.slice(0, 8), octoUuid: p.uuid } });
      }
    }
  }
  return NextResponse.json({ ok: true });
}

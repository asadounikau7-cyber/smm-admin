import path from "node:path";
import { tmpdir } from "node:os";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentAuthorized } from "@/lib/agentAuth";
import { storeRender } from "@/lib/renderStore";
import { failRender } from "@/lib/renderJobs";

const MAX_BYTES = 1024 * 1024 * 1024;

async function taken(id: string) {
  const v = await db.videoVariant.findUnique({ where: { id } });
  return v && v.status === "RENDERING" ? v : null;
}

/** The agent uploads the finished MP4 (raw body). */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!agentAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const v = await taken(id);
  if (!v) return NextResponse.json({ error: "версия не ожидает файла" }, { status: 409 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) return NextResponse.json({ error: "слишком большой файл" }, { status: 413 });
  if (!req.body) return NextResponse.json({ error: "пустое тело" }, { status: 400 });
  const tmp = path.join(tmpdir(), `upload-${id}-${Date.now()}.mp4`);
  try {
    await pipeline(Readable.fromWeb(req.body as never), createWriteStream(tmp));
    const r = await storeRender(id, tmp, v.renderer ?? "agent");
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    await rm(tmp, { force: true });
    await failRender(id, `Загрузка с компьютера: ${(e as Error).message}`);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** The agent reports a failed render. Body: { error }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!agentAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!(await taken(id))) return NextResponse.json({ ok: true });
  const body = await req.json().catch(() => ({}));
  await failRender(id, `Компьютер: ${String(body.error ?? "ошибка").slice(0, 400)}`);
  return NextResponse.json({ ok: true });
}

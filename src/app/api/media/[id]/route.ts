import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { mediaUrl } from "@/lib/mediaSource";

/** Preview: redirects to a short-lived signed URL (or the public URL). Auth is enforced by middleware. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = await db.assetVersion.findUnique({ where: { id }, include: { asset: true } });
  if (!v) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.redirect(await mediaUrl(v.asset, v, 900));
}

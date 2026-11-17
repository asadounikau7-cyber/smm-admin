import { NextResponse } from "next/server";
import { renderFrame } from "@/lib/renderJobs";

/** Exact frame of the output for the editor. Body: { versionId, recipe, t }. Session auth via middleware. */
export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  if (!b?.versionId) return NextResponse.json({ error: "нет исходника" }, { status: 400 });
  try {
    const jpg = await renderFrame(String(b.versionId), b.recipe, Math.max(0, Number(b.t) || 0));
    return new Response(new Uint8Array(jpg), { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

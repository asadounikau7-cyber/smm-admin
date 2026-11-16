import { readCover, verifyCoverSig } from "@/lib/covers";

/** Signed, expiring cover URL so Instagram can fetch it. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const k = u.searchParams.get("k") ?? "";
  if (!verifyCoverSig(k, u.searchParams.get("e") ?? "", u.searchParams.get("s") ?? "")) return new Response("forbidden", { status: 403 });
  const buf = await readCover(k);
  return new Response(new Uint8Array(buf), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=600" } });
}

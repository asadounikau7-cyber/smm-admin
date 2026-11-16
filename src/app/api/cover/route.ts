import { readCover } from "@/lib/covers";

/** Cover preview inside the admin (auth via middleware). */
export async function GET(req: Request) {
  const k = new URL(req.url).searchParams.get("k") ?? "";
  const buf = await readCover(k);
  return new Response(new Uint8Array(buf), { headers: { "content-type": "image/jpeg" } });
}

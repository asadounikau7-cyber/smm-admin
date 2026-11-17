import { verifyRenderSig } from "@/lib/renderStore";
import { serveFile } from "@/lib/serveFile";
import { renderPath } from "@/lib/renderStore";

/** Signed, expiring link to a rendered version (platforms fetch the video by URL). Supports Range. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const k = u.searchParams.get("k") ?? "";
  if (!verifyRenderSig(k, u.searchParams.get("e") ?? "", u.searchParams.get("s") ?? "")) return new Response("forbidden", { status: 403 });
  return serveFile(req, renderPath(k), "video/mp4");
}

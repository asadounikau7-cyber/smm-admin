import { db } from "@/lib/db";
import { renderPath } from "@/lib/renderStore";
import { serveFile } from "@/lib/serveFile";

/** The current render of a version (player and download). Session auth via middleware. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = await db.videoVariant.findUnique({ where: { id }, include: { output: { include: { versions: { where: { isCurrent: true } } } } } });
  const file = v?.output?.versions[0]?.versionKey;
  if (!v || !file) return new Response("not found", { status: 404 });
  const dl = new URL(req.url).searchParams.has("download") ? `${v.code}.mp4` : undefined;
  return serveFile(req, renderPath(file), "video/mp4", dl);
}

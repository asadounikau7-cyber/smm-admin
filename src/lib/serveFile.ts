import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

/** Streams a file with HTTP Range support (video players seek with it). */
export async function serveFile(req: Request, filePath: string, contentType: string, download?: string) {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return new Response("not found", { status: 404 });
  }
  const headers: Record<string, string> = { "content-type": contentType, "accept-ranges": "bytes", "cache-control": "private, max-age=3600" };
  if (download) headers["content-disposition"] = `attachment; filename="${download}"`;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") ?? "");
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const body = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
    return new Response(body, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, { headers: { ...headers, "content-length": String(size) } });
}

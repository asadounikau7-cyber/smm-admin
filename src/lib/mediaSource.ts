import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Asset, AssetVersion } from "@prisma/client";
import { b2Configured } from "./env";
import { openRange, openStream, presign } from "./b2";
import { isLocalKey, renderPath, renderPublicUrl } from "./renderStore";
import { b2Fetch, b2KeySet, b2Reason, b2SignedUrl, ensureB2Keys, isB2Download } from "./b2auth";
import { cacheFile, cached } from "./b2cache";

/**
 * One place that knows where video bytes come from: a private bucket via S3 key (signed URLs),
 * the public download URL recorded from the catalog registry, or a rendered version on the app's disk.
 */
type A = Pick<Asset, "objectKey" | "publicUrl">;
type V = Pick<AssetVersion, "versionKey">;

const viaB2Link = (asset: A) => Boolean(asset.publicUrl && isB2Download(asset.publicUrl) && b2KeySet());

/** Streams the whole file from the B2 link (no cache). */
async function fetchB2(asset: A, offset = 0) {
  const res = await b2Fetch(asset.publicUrl!, { headers: offset ? { range: `bytes=${offset}-` } : {} });
  if (!res.ok || !res.body) throw new Error(`Скачивание файла: HTTP ${res.status} ${await b2Reason(res)}`.trim());
  return { stream: Readable.fromWeb(res.body as never), size: Number(res.headers.get("content-length") ?? 0) };
}

/**
 * URL a third party (Instagram, the agent) can fetch. With internal=true, a local path is returned when
 * there is one (a rendered file, or a B2 episode already on this server), for ffmpeg/ffprobe here.
 * download=true (a full read: render, cover, film) first copies a B2 episode to the server, once.
 */
export async function mediaUrl(asset: A, version: V, ttlSec = 3600, opts: { internal?: boolean; download?: boolean } = {}): Promise<string> {
  await ensureB2Keys();
  if (isLocalKey(asset.objectKey)) return opts.internal ? renderPath(version.versionKey) : renderPublicUrl(version.versionKey, ttlSec);
  if (opts.internal && viaB2Link(asset)) {
    if (opts.download) return cacheFile(asset.objectKey, version.versionKey, async () => (await fetchB2(asset)).stream);
    const hit = await cached(asset.objectKey, version.versionKey);
    if (hit) return hit;
  }
  // Catalog links (b2_download_file_by_id) with an application key: the same link, with a token.
  if (asset.publicUrl && isB2Download(asset.publicUrl) && b2KeySet()) return b2SignedUrl(asset.publicUrl, asset.objectKey);
  if (b2Configured()) return presign(asset.objectKey, version.versionKey, ttlSec);
  if (asset.publicUrl) return asset.publicUrl;
  throw new Error("Нет доступа к файлу: не настроен ключ B2 и нет публичной ссылки");
}

export async function mediaStream(asset: A, version: V, offset = 0): Promise<{ stream: Readable; size: number }> {
  await ensureB2Keys();
  if (isLocalKey(asset.objectKey)) {
    const p = renderPath(version.versionKey);
    const size = (await stat(p)).size;
    return { stream: createReadStream(p, { start: offset }), size: size - offset };
  }
  const viaLink = viaB2Link(asset);
  if (b2Configured() && !viaLink) return offset ? openRange(asset.objectKey, version.versionKey, offset) : openStream(asset.objectKey, version.versionKey);
  if (!asset.publicUrl) throw new Error("Нет публичной ссылки на файл");
  if (viaLink) {
    // Uploads (and their resumes) read the server's copy: one download from B2 per file.
    const p = await cacheFile(asset.objectKey, version.versionKey, async () => (await fetchB2(asset)).stream);
    const size = (await stat(p)).size;
    return { stream: createReadStream(p, { start: offset }), size: size - offset };
  }
  return fetchB2(asset, offset);
}

export async function mediaBuffer(asset: A, version: V): Promise<Buffer> {
  const { stream } = await mediaStream(asset, version);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Asset, AssetVersion } from "@prisma/client";
import { b2Configured } from "./env";
import { openRange, openStream, presign } from "./b2";
import { isLocalKey, renderPath, renderPublicUrl } from "./renderStore";

/**
 * One place that knows where video bytes come from: a private bucket via S3 key (signed URLs),
 * the public download URL recorded from the catalog registry, or a rendered version on the app's disk.
 */
type A = Pick<Asset, "objectKey" | "publicUrl">;
type V = Pick<AssetVersion, "versionKey">;

/**
 * URL a third party (Instagram, the agent) can fetch. With internal=true, a rendered file is
 * returned as a local path instead, for ffmpeg/ffprobe running on this server.
 */
export async function mediaUrl(asset: A, version: V, ttlSec = 3600, opts: { internal?: boolean } = {}): Promise<string> {
  if (isLocalKey(asset.objectKey)) return opts.internal ? renderPath(version.versionKey) : renderPublicUrl(version.versionKey, ttlSec);
  if (b2Configured()) return presign(asset.objectKey, version.versionKey, ttlSec);
  if (asset.publicUrl) return asset.publicUrl;
  throw new Error("Нет доступа к файлу: не настроен ключ B2 и нет публичной ссылки");
}

export async function mediaStream(asset: A, version: V, offset = 0): Promise<{ stream: Readable; size: number }> {
  if (isLocalKey(asset.objectKey)) {
    const p = renderPath(version.versionKey);
    const size = (await stat(p)).size;
    return { stream: createReadStream(p, { start: offset }), size: size - offset };
  }
  if (b2Configured()) return offset ? openRange(asset.objectKey, version.versionKey, offset) : openStream(asset.objectKey, version.versionKey);
  if (!asset.publicUrl) throw new Error("Нет публичной ссылки на файл");
  const res = await fetch(asset.publicUrl, { headers: offset ? { range: `bytes=${offset}-` } : {} });
  if (!res.ok || !res.body) throw new Error(`Скачивание файла: HTTP ${res.status}`);
  return { stream: Readable.fromWeb(res.body as never), size: Number(res.headers.get("content-length") ?? 0) };
}

export async function mediaBuffer(asset: A, version: V): Promise<Buffer> {
  const { stream } = await mediaStream(asset, version);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

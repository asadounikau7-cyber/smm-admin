import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, copyFile, rm, stat } from "node:fs/promises";
import { db } from "./db";
import { env } from "./env";
import { probe } from "./media";

/**
 * Rendered versions live on the app's disk (shared volume of web + worker): the B2 key is read-only
 * and the pilot volume (hundreds of 10–20 MB files) fits easily. Asset.objectKey = "local:renders/<code>",
 * AssetVersion.versionKey = file name, so an older render stays readable for jobs pinned to it.
 */
export const RENDERS_DIR = process.env.RENDERS_DIR ?? path.join(process.cwd(), "data", "renders");
export const FONT_FILE = process.env.FONT_FILE ?? "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

export const isLocalKey = (objectKey: string) => objectKey.startsWith("local:");
export const renderPath = (file: string) => path.join(RENDERS_DIR, path.basename(file));

function sign(k: string, exp: number) {
  return createHmac("sha256", env().SESSION_SECRET).update(`render|${k}|${exp}`).digest("hex").slice(0, 32);
}

/** Public, signed, time-limited link (Instagram / Upload-Post fetch the video by URL). */
export function renderPublicUrl(file: string, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${env().APP_URL}/api/public/render?k=${encodeURIComponent(file)}&e=${exp}&s=${sign(file, exp)}`;
}

export function verifyRenderSig(k: string, e: string, s: string) {
  return Number(e) >= Date.now() / 1000 && sign(k, Number(e)) === s;
}

async function sha1File(p: string) {
  const h = createHash("sha1");
  for await (const c of createReadStream(p)) h.update(c);
  return h.digest("hex");
}

/** Takes a finished render (any path), files it under RENDERS_DIR and makes it publishable. */
export async function storeRender(variantId: string, tmpFile: string, renderer: string) {
  const v = await db.videoVariant.findUniqueOrThrow({ where: { id: variantId }, include: { sourceAsset: true, output: true } });
  const sha1 = await sha1File(tmpFile);
  const file = `${v.code}-${sha1.slice(0, 8)}.mp4`;
  await mkdir(RENDERS_DIR, { recursive: true });
  const dest = renderPath(file);
  await rename(tmpFile, dest).catch(async () => {
    await copyFile(tmpFile, dest);
    await rm(tmpFile, { force: true });
  });
  const size = (await stat(dest)).size;
  const p = await probe(dest);
  if (!p.durationSec || !p.width) throw new Error("Готовый файл не читается (ffprobe)");

  await db.$transaction(async (tx) => {
    const asset =
      v.output ??
      (await tx.asset.create({
        data: {
          objectKey: `local:renders/${v.code}`,
          seriesId: v.seriesId,
          episodeId: v.episodeId,
          kind: v.sourceAsset.kind,
          language: v.language,
          variant: v.code,
          needsMapping: false,
          rightsConfirmed: v.sourceAsset.rightsConfirmed,
          renderOfId: v.id,
        },
      }));
    await tx.assetVersion.updateMany({ where: { assetId: asset.id, isCurrent: true }, data: { isCurrent: false } });
    await tx.assetVersion.upsert({
      where: { assetId_versionKey: { assetId: asset.id, versionKey: file } },
      update: { isCurrent: true },
      create: {
        assetId: asset.id, versionKey: file, etag: sha1, size: BigInt(size), lastModified: new Date(), isCurrent: true,
        probedAt: new Date(), durationSec: p.durationSec, width: p.width, height: p.height, videoCodec: p.videoCodec, audioCodec: p.audioCodec,
      },
    });
    await tx.videoVariant.update({
      where: { id: v.id },
      data: { status: "READY", error: null, leaseUntil: null, renderer, renderedAt: new Date() },
    });
  });
  return { file, size, durationSec: p.durationSec };
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHmac } from "node:crypto";
import { generateCover } from "./media";
import { readAll } from "./b2";
import { mediaUrl } from "./mediaSource";
import { env } from "./env";

/** Generated covers live on the app's disk (the B2 key is read-only). */
const DIR = process.env.COVERS_DIR ?? path.join(process.cwd(), "data", "covers");

export async function readCover(coverKey: string): Promise<Buffer> {
  if (coverKey.startsWith("b2:")) return readAll(coverKey.slice(3));
  return readFile(path.join(DIR, path.basename(coverKey)));
}

export async function makeCover(asset: { objectKey: string; publicUrl: string | null }, version: { versionKey: string }, title: string, vertical: boolean, atSec = 1) {
  await mkdir(DIR, { recursive: true });
  const url = await mediaUrl(asset, version, 600, { internal: true });
  const buf = await generateCover(url, title, atSec, vertical);
  const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  await writeFile(path.join(DIR, name), buf);
  return `local:${name}`;
}

/** Public, signed, time-limited URL (Instagram needs a URL it can fetch). */
export function coverPublicUrl(coverKey: string, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = createHmac("sha256", env().SESSION_SECRET).update(`${coverKey}|${exp}`).digest("hex").slice(0, 32);
  return `${env().APP_URL}/api/public/cover?k=${encodeURIComponent(coverKey)}&e=${exp}&s=${sig}`;
}

export function verifyCoverSig(k: string, e: string, s: string) {
  if (Number(e) < Date.now() / 1000) return false;
  const sig = createHmac("sha256", env().SESSION_SECRET).update(`${k}|${e}`).digest("hex").slice(0, 32);
  return sig === s;
}

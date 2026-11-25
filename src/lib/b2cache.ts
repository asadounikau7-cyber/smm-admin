import path from "node:path";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RENDERS_DIR } from "./renderStore";

/**
 * Episodes from the private B2 bucket are downloaded to the server once and reused: probing, rendering,
 * covers and the upload itself all read the local copy. Backblaze counts every download (and every
 * range request ffmpeg makes) against the account's daily caps; on 2026-11-25 the cap stopped everything.
 * Oldest files are dropped when the cache passes its size.
 */
export const CACHE_DIR = process.env.B2_CACHE_DIR ?? path.join(RENDERS_DIR, "_b2cache");
const MAX_BYTES = Number(process.env.B2_CACHE_GB ?? 8) * 1024 ** 3;

const inFlight = new Map<string, Promise<string>>();

export const cachePath = (objectKey: string, versionKey: string) =>
  path.join(CACHE_DIR, createHash("sha1").update(`${objectKey}|${versionKey}`).digest("hex") + path.extname(objectKey).slice(0, 8));

/** The local copy if there is one (and marks it used), else null. */
export async function cached(objectKey: string, versionKey: string) {
  const p = cachePath(objectKey, versionKey);
  try {
    if ((await stat(p)).size > 0) {
      const now = new Date();
      await utimes(p, now, now).catch(() => undefined);
      return p;
    }
  } catch {
    /* not cached */
  }
  return null;
}

/** Local copy of the file, downloaded with `open` once (parallel callers wait for the same download). */
export async function cacheFile(objectKey: string, versionKey: string, open: () => Promise<Readable>) {
  const hit = await cached(objectKey, versionKey);
  if (hit) return hit;
  const p = cachePath(objectKey, versionKey);
  const running = inFlight.get(p);
  if (running) return running;
  const job = (async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.part`;
    try {
      await pipeline(await open(), createWriteStream(tmp));
      await rename(tmp, p);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    await prune().catch(() => undefined);
    return p;
  })().finally(() => inFlight.delete(p));
  inFlight.set(p, job);
  return job;
}

/** Drops the least recently used files above the cache size. */
export async function prune(max = MAX_BYTES) {
  const files = await Promise.all(
    (await readdir(CACHE_DIR).catch(() => [] as string[]))
      .filter((f) => !f.endsWith(".part"))
      .map(async (f) => {
        const s = await stat(path.join(CACHE_DIR, f));
        return { f, size: s.size, used: s.mtimeMs };
      }),
  );
  let total = files.reduce((a, x) => a + x.size, 0);
  for (const x of files.sort((a, b) => a.used - b.used)) {
    if (total <= max) break;
    await rm(path.join(CACHE_DIR, x.f), { force: true });
    total -= x.size;
  }
  return total;
}

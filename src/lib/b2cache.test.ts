import { mkdtemp, readFile, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

describe("B2 episodes are downloaded to the server once", () => {
  it("parallel and later reads share one download; the least recently used files go first", async () => {
    process.env.B2_CACHE_DIR = await mkdtemp(path.join(tmpdir(), "b2cache-"));
    const { cacheFile, cached, prune, CACHE_DIR } = await import("./b2cache");
    let downloads = 0;
    const open = async () => {
      downloads++;
      await new Promise((r) => setTimeout(r, 20));
      return Readable.from([Buffer.from("video-bytes")]);
    };
    const [a, b] = await Promise.all([cacheFile("ep/1.mp4", "v1", open), cacheFile("ep/1.mp4", "v1", open)]);
    expect(a).toBe(b);
    expect(await cacheFile("ep/1.mp4", "v1", open)).toBe(a);
    expect(downloads).toBe(1);
    expect(await readFile(a, "utf8")).toBe("video-bytes");
    // Another version of the same file is another copy.
    expect(await cacheFile("ep/1.mp4", "v2", open)).not.toBe(a);
    expect(downloads).toBe(2);
    // A failed download leaves nothing behind.
    await expect(cacheFile("ep/2.mp4", "v1", async () => { throw new Error("HTTP 403"); })).rejects.toThrow("403");
    expect(await cached("ep/2.mp4", "v1")).toBeNull();
    expect((await readdir(CACHE_DIR)).some((f) => f.endsWith(".part"))).toBe(false);
    // Over the size: the copy not used for longest is dropped.
    const old = new Date(Date.now() - 3600_000);
    await utimes(a, old, old);
    await prune(15);
    expect(await cached("ep/1.mp4", "v1")).toBeNull();
    expect(await cached("ep/1.mp4", "v2")).not.toBeNull();
  });
});

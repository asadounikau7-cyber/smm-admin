/** Films: a series glued into one video with chapters, built with the real ffmpeg on tiny generated clips. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./media";

const dir = await mkdtemp(path.join(tmpdir(), "films-"));
process.env.RENDERS_DIR = path.join(dir, "renders");
const { db } = await import("./db");
const { buildFilm, filmMeta, clock, scheduleFilms, settleFilms, testFilms } = await import("./films");
const { encryptJson } = await import("./crypto");
const { DEFAULT_CONVEYOR, saveConveyorSettings } = await import("./conveyor");

const SLUG = "film-test-series";
let seriesId = "";

const EXT = "film_main_test";

async function cleanup() {
  const acc = await db.socialAccount.findUnique({ where: { platform_externalId: { platform: "YOUTUBE", externalId: EXT } } }).catch(() => null);
  if (acc) {
    await db.publicationJob.deleteMany({ where: { accountId: acc.id } });
    await db.socialAccount.delete({ where: { id: acc.id } });
  }
  await db.setting.deleteMany({ where: { key: "ytConveyor" } });
  const s = await db.series.findUnique({ where: { slug: SLUG } });
  if (!s) return;
  await db.asset.deleteMany({ where: { seriesId: s.id } });
  await db.series.delete({ where: { id: s.id } });
}

beforeAll(async () => {
  await cleanup();
  const s = await db.series.create({ data: { slug: SLUG, title: "Film Test", stage: "IN_WORK", mainSkip: "long" } });
  seriesId = s.id;
  for (const n of [1, 2, 3]) {
    const file = path.join(dir, `ep${n}.mp4`);
    const r = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${n === 3 ? "270x480" : "180x320"}:rate=25`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
      "-t", String(n + 1), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
    expect(r.code).toBe(0);
    const ep = await db.episode.create({ data: { seriesId, season: 1, number: n } });
    await db.asset.create({
      data: {
        objectKey: `test/${SLUG}/${n}.mp4`, publicUrl: file, seriesId, episodeId: ep.id, kind: "VERTICAL", language: "en", needsMapping: false,
        versions: { create: { versionKey: `v${n}`, size: BigInt((await stat(file)).size), isCurrent: true, lastModified: new Date() } },
      },
    });
  }
}, 60_000);

afterAll(async () => {
  await cleanup();
  await rm(dir, { recursive: true, force: true });
  await db.$disconnect();
});

describe("films", () => {
  it("without phone verification takes only the parts that fit, and refuses when fewer than 3 fit", async () => {
    const comp = await db.compilation.create({ data: { seriesId } });
    await expect(buildFilm(comp.id, "en", 6)).rejects.toThrow(/15 минут/);
    await db.compilation.delete({ where: { id: comp.id } });
  }, 60_000);

  it("glues every episode into one file (re-encoding when formats differ) and remembers where each part starts", async () => {
    const comp = await db.compilation.create({ data: { seriesId } });
    await buildFilm(comp.id);
    const done = await db.compilation.findUniqueOrThrow({ where: { id: comp.id } });
    expect(done.status).toBe("READY");
    expect(done.episodes).toBe(3);
    const out = await db.assetVersion.findUniqueOrThrow({ where: { id: done.assetVersionId! } });
    expect([out.width, out.height, out.videoCodec]).toEqual([1080, 1920, "h264"]);
    expect(done.durationSec).toBeGreaterThan(8.5);
    expect(done.durationSec).toBeLessThan(9.5);
    const ch = done.chapters as { number: number; at: number }[];
    expect(ch.map((c) => c.number)).toEqual([1, 2, 3]);
    expect(ch[1].at).toBeCloseTo(2, 0);
    expect(ch[2].at).toBeCloseTo(5, 0);
    const v = await db.assetVersion.findUniqueOrThrow({ where: { id: done.assetVersionId! } });
    expect((await stat(path.join(dir, "renders", v.versionKey))).size).toBeGreaterThan(0);
  }, 120_000);

  it("a tested film gets the daily film slot on the film channel, and is marked published once out", async () => {
    const acc = await db.socialAccount.create({ data: { platform: "YOUTUBE", externalId: EXT, handle: EXT, language: "en", credentials: encryptJson({ access_token: "t", refresh_token: "r", expires_at: Date.now() + 3600_000 }), geo: "US", role: "MAIN" } });
    await saveConveyorSettings({ ...DEFAULT_CONVEYOR, filmAccountIds: [acc.id], filmTestAccountId: acc.id, filmSlot: "19:30" });
    await db.compilation.update({ where: { seriesId }, data: { status: "PASSED" } });
    const now = new Date("2026-12-01T15:00:00Z"); // 10:00 in New York
    const planned = await scheduleFilms(now);
    expect(planned).toHaveLength(1);
    const comp = await db.compilation.findUniqueOrThrow({ where: { seriesId } });
    expect(comp.status).toBe("SCHEDULED");
    const job = await db.publicationJob.findUniqueOrThrow({ where: { id: comp.mainJobId! } });
    expect(job.format).toBe("YT_VIDEO");
    expect(job.visibility).toBe("PUBLIC");
    expect(job.scheduledAt.toISOString()).toBe("2026-12-02T00:30:00.000Z"); // 19:30 New York
    expect(job.title).toBe("Film Test | Full Series");
    expect(job.caption).toContain("0:00 Part 1");
    // Nothing else passed: the next days stay free.
    expect(await scheduleFilms(now)).toHaveLength(0);
    await db.publicationJob.update({ where: { id: job.id }, data: { status: "PUBLISHED", externalId: "vid1" } });
    await settleFilms();
    expect((await db.compilation.findUniqueOrThrow({ where: { seriesId } })).status).toBe("PUBLISHED");
  });

  it("without a test channel the film is tested on its own channel and that same upload gets the slot", async () => {
    const acc = await db.socialAccount.findUniqueOrThrow({ where: { platform_externalId: { platform: "YOUTUBE", externalId: EXT } } });
    await saveConveyorSettings({ ...DEFAULT_CONVEYOR, filmAccountIds: [acc.id], filmTestAccountId: null, filmSlot: "19:30" });
    const comp0 = await db.compilation.findUniqueOrThrow({ where: { seriesId } });
    await db.compilation.update({ where: { id: comp0.id }, data: { status: "READY", mainJobId: null, accountId: null, testJobId: null } });
    const now = new Date("2026-12-03T15:00:00Z");
    expect(await testFilms(now)).toEqual([`test Film Test → @${EXT}`]);
    let comp = await db.compilation.findUniqueOrThrow({ where: { id: comp0.id } });
    expect(comp.accountId).toBe(acc.id);
    const test = await db.publicationJob.findUniqueOrThrow({ where: { id: comp.testJobId! } });
    expect(test.visibility).toBe("PRIVATE");
    expect(test.accountId).toBe(acc.id);
    // Uploaded and clean (the verdict itself needs YouTube; here it is given).
    await db.publicationJob.update({ where: { id: test.id }, data: { status: "PUBLISHED", externalId: "vid2" } });
    await db.compilation.update({ where: { id: comp.id }, data: { status: "PASSED" } });
    expect(await scheduleFilms(now)).toHaveLength(1);
    comp = await db.compilation.findUniqueOrThrow({ where: { id: comp0.id } });
    expect(comp.status).toBe("SCHEDULED");
    expect(comp.mainJobId).toBe(test.id);
    const job = await db.publicationJob.findUniqueOrThrow({ where: { id: test.id } });
    expect(job.visibility).toBe("PUBLIC");
    expect(job.status).toBe("PROCESSING");
    expect(job.externalId).toBe("vid2");
    expect(job.scheduledAt.toISOString()).toBe("2026-12-04T00:30:00.000Z");
    expect((job.meta as any).adapter.scheduledNatively).toBe(true);
    // That day is taken now.
    await db.compilation.update({ where: { id: comp.id }, data: { status: "PASSED" } });
    const again = await scheduleFilms(now);
    expect(again.every((t) => !t.includes("2026-12-04T00:30"))).toBe(true);
  });

  it("title says full series and the description carries the chapters", () => {
    const m = filmMeta({ title: "Film Test", synopsis: null, hookTitle: "She married a stranger" }, [
      { season: 1, number: 1, at: 0 },
      { season: 1, number: 2, at: 222 },
      { season: 1, number: 3, at: 3725 },
    ]);
    expect(m.title).toBe("She married a stranger | Full Series");
    expect(m.description).toContain("0:00 Part 1\n3:42 Part 2\n1:02:05 Part 3");
    expect(clock(59.9)).toBe("0:59");
    const part = filmMeta({ title: "Film Test", synopsis: null, hookTitle: null }, [
      { season: 1, number: 1, at: 0 },
      { season: 1, number: 2, at: 90 },
      { season: 1, number: 3, at: 180 },
    ], 60);
    expect(part.title).toBe("Film Test | Parts 1-3");
    expect(part.description).toContain("parts 1-3 of 60");
  });
});

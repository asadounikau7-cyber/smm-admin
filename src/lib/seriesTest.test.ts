/**
 * YouTube series test end to end against the dev database, with YouTube's API answers faked:
 * test upload → verdict → series in work → episode 1 queued on the main channel → planner skips episode 1 there.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { db } from "./db";
import { encryptJson } from "./crypto";
import { importRegistry, type Registry } from "./registry";
import { checkSeriesTests, recheckPassedSeries, saveYtTestSettings, startSeriesTest } from "./seriesTest";
import { buildWeek } from "./planner";

const SLUGS = ["test-st-ok", "test-st-bad"];
const reg: Registry = {
  verified_at_utc: "2026-11-06T18:00:00Z",
  series: SLUGS.map((id) => ({
    id,
    title: `Show ${id}`,
    expected: 2,
    episodes: [1, 2].map((n) => ({ n, bytes: 1000 + n, key: `originals/t/en/${id}/episodes/ep-000${n}.mp4`, url: `http://example.invalid/${id}/${n}.mp4`, sha1: `${id}sha${n}` })),
  })),
};
const TZ = "America/Winnipeg";
const weekStart = DateTime.now().setZone(TZ).plus({ weeks: 4 }).startOf("week").toUTC().toJSDate();
const creds = () => encryptJson({ access_token: "tok", refresh_token: "ref", expires_at: Date.now() + 3600_000 });

async function cleanup() {
  for (const slug of SLUGS) {
    const s = await db.series.findUnique({ where: { slug } });
    if (!s) continue;
    await db.publicationJob.deleteMany({ where: { OR: [{ rule: { seriesId: s.id } }, { meta: { path: ["seriesId"], equals: s.id } }] } });
    await db.releaseRule.deleteMany({ where: { seriesId: s.id } });
    await db.asset.deleteMany({ where: { seriesId: s.id } });
    await db.series.delete({ where: { id: s.id } });
  }
  await db.socialAccount.deleteMany({ where: { externalId: { in: ["st_test", "st_main"] } } });
  await db.weeklyPlan.deleteMany({ where: { weekStart } });
  await db.setting.deleteMany({ where: { key: "ytTest" } });
}

/** Fakes GET videos?id=… with whatever the test wants YouTube to say. */
function fakeYouTube(video: object | null) {
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).includes("/youtube/v3/videos")) return new Response(JSON.stringify({ items: video ? [video] : [] }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected fetch ${url}`);
  });
}

beforeAll(async () => {
  await cleanup();
  await importRegistry(reg);
  for (const slug of SLUGS) {
    const s = await db.series.findUniqueOrThrow({ where: { slug } });
    await db.assetVersion.updateMany({ where: { asset: { seriesId: s.id } }, data: { probedAt: new Date(), durationSec: 60, width: 540, height: 960, videoCodec: "h264", audioCodec: "aac" } });
  }
  await db.socialAccount.create({ data: { platform: "YOUTUBE", externalId: "st_test", handle: "st_test", language: "en", credentials: creds() } });
  await db.socialAccount.create({ data: { platform: "YOUTUBE", externalId: "st_main", handle: "st_main", language: "en", credentials: creds() } });
  await saveYtTestSettings({ testAccountId: null, launchAccountId: null, visibility: "UNLISTED", waitMin: 0 });
}, 60_000);
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

async function uploadedAs(seriesSlug: string, videoId: string) {
  const s = await db.series.findUniqueOrThrow({ where: { slug: seriesSlug } });
  // The runner's part (upload + processing) is covered elsewhere: pretend it finished.
  await db.publicationJob.update({ where: { id: s.testJobId! }, data: { status: "PUBLISHED", externalId: videoId, externalUrl: `https://www.youtube.com/watch?v=${videoId}` } });
  return s;
}

describe("YouTube series test", () => {
  it("clean test → series in work, episode 1 queued on the main channel, planner continues from episode 2", async () => {
    const [t, m] = await Promise.all([db.socialAccount.findFirstOrThrow({ where: { externalId: "st_test" } }), db.socialAccount.findFirstOrThrow({ where: { externalId: "st_main" } })]);
    const s0 = await db.series.findUniqueOrThrow({ where: { slug: SLUGS[0] } });
    const job = await startSeriesTest({ seriesId: s0.id, testAccountId: t.id, launchAccountId: m.id });
    expect(job.status).toBe("QUEUED");
    expect(job.visibility).toBe("UNLISTED");
    expect(job.format).toBe("YT_SHORT");
    await expect(startSeriesTest({ seriesId: s0.id, testAccountId: t.id, launchAccountId: m.id })).rejects.toThrow(/уже идёт/);

    await uploadedAs(SLUGS[0], "vid_ok");
    fakeYouTube({ id: "vid_ok", status: { uploadStatus: "processed", privacyStatus: "unlisted" }, contentDetails: {} });
    await checkSeriesTests();

    const s = await db.series.findUniqueOrThrow({ where: { id: s0.id } });
    expect(s.stage).toBe("IN_WORK");
    expect(s.active).toBe(true);
    const launch = await db.publicationJob.findUniqueOrThrow({ where: { id: s.launchJobId! } });
    expect(launch.accountId).toBe(m.id);
    expect(launch.visibility).toBe("PUBLIC");
    expect(launch.status).toBe("QUEUED");
    expect(launch.title).toContain("Part 1");

    // A weekly rule on the main channel picks up from episode 2.
    await db.releaseRule.create({
      data: { name: "st", seriesId: s0.id, assetKind: "FULL_EPISODE", language: "en", accountId: m.id, format: "YT_SHORT", slots: [{ weekday: 2, time: "19:00" }] },
    });
    await buildWeek(weekStart, null);
    const planned = await db.publicationJob.findMany({ where: { rule: { seriesId: s0.id } } });
    expect(planned).toHaveLength(1);
    expect(planned[0].title).toContain("S01E02");
  });

  it("Content ID block → series marked as failed, nothing goes to the main channel", async () => {
    const [t, m] = await Promise.all([db.socialAccount.findFirstOrThrow({ where: { externalId: "st_test" } }), db.socialAccount.findFirstOrThrow({ where: { externalId: "st_main" } })]);
    const s1 = await db.series.findUniqueOrThrow({ where: { slug: SLUGS[1] } });
    await startSeriesTest({ seriesId: s1.id, testAccountId: t.id, launchAccountId: m.id });
    await uploadedAs(SLUGS[1], "vid_bad");
    fakeYouTube({ id: "vid_bad", status: { uploadStatus: "processed", privacyStatus: "unlisted" }, contentDetails: { regionRestriction: { blocked: ["US", "CA", "GB"] } } });
    await checkSeriesTests();

    const s = await db.series.findUniqueOrThrow({ where: { id: s1.id } });
    expect(s.stage).toBe("TEST_FAILED");
    expect(s.testNote).toMatch(/Заблокирован в 3 странах/);
    expect(s.launchJobId).toBeNull();
    expect(await db.notification.findUnique({ where: { dedupKey: `series-test:${s1.id}` } })).not.toBeNull();
    await db.notification.deleteMany({ where: { dedupKey: { startsWith: "series-test:" } } });
  });
  it("a passed series whose test video later gets 18+ is taken back as failed", async () => {
    const s0 = await db.series.findUniqueOrThrow({ where: { slug: SLUGS[0] } });
    expect(s0.stage).toBe("IN_WORK");
    fakeYouTube({ id: "vid_ok", status: { uploadStatus: "processed", privacyStatus: "unlisted" }, contentDetails: { contentRating: { ytRating: "ytAgeRestricted" } } });
    const out = await recheckPassedSeries();
    expect(out).toHaveLength(1);
    const s = await db.series.findUniqueOrThrow({ where: { id: s0.id } });
    expect(s.stage).toBe("TEST_FAILED");
    expect(s.testNote).toMatch(/^18\+/);
    await db.notification.deleteMany({ where: { dedupKey: { startsWith: "series-test:" } } });
  });
});

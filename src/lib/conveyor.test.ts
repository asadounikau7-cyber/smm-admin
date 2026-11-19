/**
 * YouTube conveyor against the dev database: tests spread over the test channels' local day,
 * a pass lines the series up on the main channels of its geos, and main slots are filled in order.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { db } from "./db";
import { encryptJson } from "./crypto";
import { importRegistry, type Registry } from "./registry";
import { DEFAULT_CONVEYOR, saveConveyorSettings, scheduleMain, scheduleTests } from "./conveyor";
import { checkSeriesTests, markTestPassed, saveYtTestSettings } from "./seriesTest";

const SLUGS = ["conv-a", "conv-b", "conv-c", "conv-d", "conv-e"];
const EXT = ["cv_t_us1", "cv_t_us2", "cv_m_us", "cv_m_uk"];
const reg: Registry = {
  verified_at_utc: "2026-11-06T18:00:00Z",
  series: SLUGS.map((id) => ({
    id,
    title: `Conv ${id}`,
    expected: 3,
    episodes: [1, 2, 3, 4].map((n) => ({ n, bytes: 1000 + n, key: `originals/t/en/${id}/episodes/ep-000${n}.mp4`, url: `http://example.invalid/${id}/${n}.mp4`, sha1: `${id}sha${n}` })),
  })),
};
const NY = "America/New_York";
// A morning a month ahead in New York, so nothing collides with real data.
const now = DateTime.now().setZone(NY).plus({ days: 35 }).set({ hour: 8, minute: 0, second: 0, millisecond: 0 }).toJSDate();
const creds = () => encryptJson({ access_token: "tok", refresh_token: "ref", expires_at: Date.now() + 3600_000 });
const ids: Record<string, string> = {};

async function cleanup() {
  const series = await db.series.findMany({ where: { slug: { in: SLUGS } } });
  const accounts = await db.socialAccount.findMany({ where: { externalId: { in: EXT } } });
  await db.publicationJob.deleteMany({ where: { OR: [{ accountId: { in: accounts.map((a) => a.id) } }, ...series.map((s) => ({ meta: { path: ["seriesId"], equals: s.id } }))] } });
  for (const s of series) {
    await db.asset.deleteMany({ where: { seriesId: s.id } });
    await db.series.delete({ where: { id: s.id } });
  }
  await db.socialAccount.deleteMany({ where: { externalId: { in: EXT } } });
  await db.setting.deleteMany({ where: { key: { in: ["ytConveyor", "ytTest"] } } });
}

beforeAll(async () => {
  await cleanup();
  await importRegistry(reg);
  for (const slug of SLUGS) {
    const s = await db.series.findUniqueOrThrow({ where: { slug } });
    ids[slug] = s.id;
    await db.assetVersion.updateMany({ where: { asset: { seriesId: s.id } }, data: { probedAt: new Date(), durationSec: 60, width: 540, height: 960, videoCodec: "h264", audioCodec: "aac" } });
  }
  const mk = (externalId: string, geo: string, role: "TEST" | "MAIN") =>
    db.socialAccount.create({ data: { platform: "YOUTUBE", externalId, handle: externalId, language: "en", credentials: creds(), geo, role } });
  for (const [ext, geo, role] of [["cv_t_us1", "US", "TEST"], ["cv_t_us2", "US", "TEST"], ["cv_m_us", "US", "MAIN"], ["cv_m_uk", "UK", "MAIN"]] as const) ids[ext] = (await mk(ext, geo, role)).id;
  await saveYtTestSettings({ testAccountId: null, launchAccountId: null, visibility: "PRIVATE", waitMin: 0 });
  await saveConveyorSettings({ ...DEFAULT_CONVEYOR, enabled: true });
  // Queue four series for testing, a-d in this order; e stays untested.
  for (const [i, slug] of SLUGS.slice(0, 4).entries()) await db.series.update({ where: { id: ids[slug] }, data: { testQueuedAt: new Date(Date.now() + i * 1000) } });
}, 60_000);
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

const local = (d: Date, tz = NY) => DateTime.fromJSDate(d, { zone: tz });

describe("YouTube conveyor", () => {
  it("spreads queued series over the test channels in the local window, once per slot", async () => {
    const created = await scheduleTests(now);
    expect(created).toHaveLength(4); // 4 queued series, 6 free slots; autoPick is off
    expect(new Set(created.map((c) => c.series)).size).toBe(4);
    for (const c of created) {
      const h = local(c.at).hour + local(c.at).minute / 60;
      expect(h).toBeGreaterThanOrEqual(10);
      expect(h).toBeLessThan(21);
    }
    const times = created.map((c) => c.at.getTime()).sort();
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(30 * 60_000);
    const one = created.filter((c) => c.account === "cv_t_us1").map((c) => c.at.getTime()).sort();
    for (let i = 1; i < one.length; i++) expect(one[i] - one[i - 1]).toBeGreaterThanOrEqual(3 * 3600_000);
    // In order: the first queued series takes the first slot.
    expect(created.sort((a, b) => a.at.getTime() - b.at.getTime())[0].series).toBe("Conv conv-a");
    expect(await scheduleTests(now)).toHaveLength(0);
    const a = await db.series.findUniqueOrThrow({ where: { id: ids["conv-a"] } });
    expect(a.stage).toBe("TESTING");
    expect(a.testQueuedAt).toBeNull();
  });

  it("blocked in the UK only → passes for the US, lines up on the US main channel", async () => {
    const s = await db.series.findUniqueOrThrow({ where: { id: ids["conv-a"] } });
    await db.publicationJob.update({ where: { id: s.testJobId! }, data: { status: "PUBLISHED", externalId: "vid_conv_a" } });
    vi.stubGlobal("fetch", async () =>
      Response.json({ items: [{ id: "vid_conv_a", status: { uploadStatus: "processed", privacyStatus: "private" }, contentDetails: { regionRestriction: { blocked: ["GB", "DE"] } } }] }),
    );
    await checkSeriesTests();
    const after = await db.series.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.stage).toBe("IN_WORK");
    expect(after.allowedGeos).toEqual(["US"]);
    const items = await db.channelQueueItem.findMany({ where: { seriesId: s.id } });
    expect(items).toHaveLength(3);
    expect(new Set(items.map((i) => i.accountId))).toEqual(new Set([ids.cv_m_us]));
  });

  it("fills free main slots in order and skips a slot the channel already uses", async () => {
    await markTestPassed(ids["conv-b"], "ok", null, ["US", "UK"]);
    // Something already planned at 10:05 on the US main channel: the 10:00 slot is taken.
    const day = local(now).startOf("day");
    const plan = await db.weeklyPlan.findFirstOrThrow();
    await db.publicationJob.create({
      data: {
        planId: plan.id, accountId: ids.cv_m_us, platform: "YOUTUBE", format: "YT_SHORT", visibility: "PUBLIC", instanceKey: "conv-busy", idempotencyKey: "conv-busy",
        status: "QUEUED", scheduledAt: day.set({ hour: 10, minute: 5 }).toJSDate(), localTime: "x", timezone: NY, deadlineAt: now, caption: "x",
      },
    });
    const created = await scheduleMain(now);
    const us = created.filter((c) => c.account === "cv_m_us");
    const uk = created.filter((c) => c.account === "cv_m_uk");
    // US: conv-a's three episodes, then conv-b's; first free slot is 14:00 New York.
    expect(us[0].episode).toBe("Conv conv-a S1E1");
    expect(local(us[0].at).toFormat("HH:mm")).toBe("14:00");
    expect(us.slice(0, 4).map((c) => c.episode)).toEqual(["Conv conv-a S1E1", "Conv conv-a S1E2", "Conv conv-a S1E3", "Conv conv-b S1E1"]);
    // UK gets only conv-b (conv-a is blocked there), at London times.
    expect(uk.map((c) => c.episode)).toEqual(["Conv conv-b S1E1", "Conv conv-b S1E2", "Conv conv-b S1E3"]);
    expect(local(uk[0].at, "Europe/London").toFormat("HH:mm")).toBe("14:00");
    expect(await scheduleMain(now)).toHaveLength(0); // remaining slots already given out
  });
});

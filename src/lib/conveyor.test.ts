/**
 * YouTube conveyor against the dev database: tests spread over the test channels' local day,
 * a pass lines the series up on the main channels of its geos, and main slots are filled in order.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { db } from "./db";
import { encryptJson } from "./crypto";
import { importRegistry, type Registry } from "./registry";
import { DEFAULT_CONVEYOR, dropLongMain, dropMainDuplicates, enqueueMain, prepareChannelVersions, rebalanceMain, releaseTestsOnMainChannels, saveConveyorSettings, scheduleMain, scheduleTests, testTimes } from "./conveyor";
import { checkSeriesTests, guardMainUploads, markTestPassed, saveYtTestSettings, startSeriesTest, stopSeriesAfterRemoval } from "./seriesTest";

const SLUGS = ["conv-a", "conv-b", "conv-c", "conv-d", "conv-e"];
const EXT = ["cv_t_us1", "cv_t_us2", "cv_m_us", "cv_m_uk", "cv_m_us2"];
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
    // The conveyor tests episodes 1–3 together; all three are up.
    const first = await db.publicationJob.findUniqueOrThrow({ where: { id: s.testJobId! } });
    const run = (first.meta as { testRun: string }).testRun;
    const runJobs = await db.publicationJob.findMany({ where: { meta: { path: ["testRun"], equals: run } } });
    expect(runJobs).toHaveLength(3);
    for (const [n, j] of runJobs.entries()) await db.publicationJob.update({ where: { id: j.id }, data: { status: "PUBLISHED", externalId: `vid_conv_a${n}` } });
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
    // US: conv-a's three episodes; first free slot is 14:00 New York.
    expect(us[0].episode).toBe("Conv conv-a S1E1");
    expect(local(us[0].at).toFormat("HH:mm")).toBe("14:00");
    expect(us.map((c) => c.episode)).toEqual(["Conv conv-a S1E1", "Conv conv-a S1E2", "Conv conv-a S1E3"]);
    // conv-b goes to ONE main channel, the less busy UK one, at London times; no copy on the US channel.
    expect(uk.map((c) => c.episode)).toEqual(["Conv conv-b S1E1", "Conv conv-b S1E2", "Conv conv-b S1E3"]);
    expect(local(uk[0].at, "Europe/London").toFormat("HH:mm")).toBe("14:00");
    expect(await scheduleMain(now)).toHaveLength(0); // remaining slots already given out
  });

  it("a test channel in a geo with no main channel still tests (for the other geos)", async () => {
    // UK has only a test channel now; the US test channels are switched off for this check.
    await db.socialAccount.update({ where: { id: ids.cv_m_uk }, data: { role: "TEST" } });
    await db.socialAccount.updateMany({ where: { id: { in: [ids.cv_t_us1, ids.cv_t_us2] } }, data: { status: "DISABLED" } });
    await db.series.update({ where: { id: ids["conv-e"] }, data: { testQueuedAt: new Date() } });
    const created = await scheduleTests(DateTime.fromJSDate(now).plus({ days: 1 }).toJSDate());
    expect(created.map((c) => [c.account, c.series])).toEqual([["cv_m_uk", "Conv conv-e"]]);
  });

  it("a passed series that no main channel could take goes to one once a fitting channel appears", async () => {
    await db.socialAccount.update({ where: { id: ids.cv_m_uk }, data: { role: "TEST" } });
    await markTestPassed(ids["conv-e"], "ok", null, ["UK"]); // only the UK, which has no main channel right now
    const items = () => db.channelQueueItem.findMany({ where: { seriesId: ids["conv-e"] } });
    expect(await items()).toHaveLength(0);
    await db.socialAccount.update({ where: { id: ids.cv_m_uk }, data: { role: "MAIN" } });
    await scheduleMain(now);
    const after = await items();
    expect(after).toHaveLength(3);
    expect(new Set(after.map((i) => i.accountId))).toEqual(new Set([ids.cv_m_uk]));
  });

  it("after the main slots change, episodes not yet picked up move to the new slots in the same order", async () => {
    await saveConveyorSettings({ ...DEFAULT_CONVEYOR, enabled: true, mainSlots: ["09:00", "12:00"] });
    await scheduleMain(now);
    const items = await db.channelQueueItem.findMany({ where: { accountId: ids.cv_m_us, jobId: { not: null } }, orderBy: { position: "asc" } });
    const jobs = await db.publicationJob.findMany({ where: { id: { in: items.map((i) => i.jobId!) } } });
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const later = items.map((i) => byId.get(i.jobId!)!).filter((j) => j.scheduledAt.getTime() > now.getTime() + 7 * 3600_000);
    expect(later.length).toBeGreaterThan(0);
    for (const j of later) {
      expect(j.status).toBe("QUEUED");
      expect(["09:00", "12:00"]).toContain(local(j.scheduledAt).toFormat("HH:mm"));
    }
    const times = items.map((i) => byId.get(i.jobId!)!.scheduledAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times); // queue order kept
    // Out of order (a later episode moved ahead of an earlier one): put back in order.
    const [first, second] = later;
    await db.publicationJob.update({ where: { id: first.id }, data: { scheduledAt: new Date(second.scheduledAt.getTime() + 86_400_000) } });
    await scheduleMain(now);
    const again = await db.publicationJob.findMany({ where: { id: { in: items.map((i) => i.jobId!) } } });
    const t2 = items.map((i) => again.find((j) => j.id === (i.jobId as string))!.scheduledAt.getTime());
    expect([...t2].sort((a, b) => a - b)).toEqual(t2);
    // Stable once in order.
    await scheduleMain(now);
    const t3 = (await db.publicationJob.findMany({ where: { id: { in: items.map((i) => i.jobId!) } } }));
    expect(items.map((i) => t3.find((j) => j.id === i.jobId)!.scheduledAt.getTime())).toEqual(t2);
  });

  it("an uploaded video that slipped ahead of its turn is moved on YouTube to its place in the order", async () => {
    const items = await db.channelQueueItem.findMany({ where: { accountId: ids.cv_m_us, jobId: { not: null } }, orderBy: { position: "asc" } });
    const lastItem = items[items.length - 1];
    const early = new Date(now.getTime() + 3 * 3600_000);
    await db.publicationJob.update({
      where: { id: lastItem.jobId! },
      data: { status: "PROCESSING", externalId: "vid_slip", scheduledAt: early, meta: { purpose: "launch", conveyor: true, adapter: { videoId: "vid_slip", scheduledNatively: true } } },
    });
    const calls: { url: string; body?: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body as string | undefined });
      return Response.json({ items: [] });
    });
    await scheduleMain(now);
    const moved = await db.publicationJob.findUniqueOrThrow({ where: { id: lastItem.jobId! } });
    expect(moved.scheduledAt.getTime()).toBeGreaterThan(early.getTime());
    const put = calls.find((c) => c.body?.includes("vid_slip"));
    expect(JSON.parse(put!.body!).status.publishAt).toBe(moved.scheduledAt.toISOString());
    const all = await db.publicationJob.findMany({ where: { id: { in: items.map((i) => i.jobId!) } } });
    const t = items.map((i) => all.find((j) => j.id === i.jobId)!.scheduledAt.getTime());
    expect([...t].sort((a, b) => a - b)).toEqual(t);
  });

  it("a new main channel takes whole waiting series off the busy one", async () => {
    await db.channelQueueItem.deleteMany({ where: { accountId: ids.cv_m_us } });
    let pos = 1;
    for (const slug of SLUGS) {
      const eps = await db.episode.findMany({ where: { seriesId: ids[slug] }, orderBy: { number: "asc" }, take: 3 });
      for (const ep of eps) await db.channelQueueItem.create({ data: { accountId: ids.cv_m_us, seriesId: ids[slug], episodeId: ep.id, position: pos++ } });
    }
    // Only the two US main channels take part here.
    await db.channelQueueItem.deleteMany({ where: { accountId: ids.cv_m_uk } });
    await db.socialAccount.update({ where: { id: ids.cv_m_uk }, data: { role: "TEST" } });
    ids.cv_m_us2 = (await db.socialAccount.create({ data: { platform: "YOUTUBE", externalId: "cv_m_us2", handle: "cv_m_us2", language: "en", credentials: creds(), geo: "US", role: "MAIN" } })).id;
    await db.series.updateMany({ where: { id: { in: SLUGS.map((x) => ids[x]) } }, data: { allowedGeos: ["US", "UK"] } });
    expect(await rebalanceMain()).toBe(6);
    const a = await db.channelQueueItem.findMany({ where: { accountId: ids.cv_m_us }, orderBy: { position: "asc" } });
    const b = await db.channelQueueItem.findMany({ where: { accountId: ids.cv_m_us2 }, orderBy: { position: "asc" } });
    expect([a.length, b.length]).toEqual([9, 6]);
    // Series stay whole and in episode order on each channel.
    for (const line of [a, b]) {
      const seen: string[] = [];
      for (const i of line) if (seen[seen.length - 1] !== i.seriesId) seen.push(i.seriesId);
      expect(new Set(seen).size).toBe(seen.length);
    }
    expect(new Set(b.map((i) => i.seriesId))).toEqual(new Set([ids["conv-d"], ids["conv-e"]]));
    expect(await rebalanceMain()).toBe(0);
  });

  it("a test channel switched to main drops its planned tests and frees the series", async () => {
    const job = await db.publicationJob.findFirstOrThrow({ where: { accountId: ids.cv_t_us1, status: "QUEUED", externalId: null, meta: { path: ["conveyorSlot"], string_starts_with: "2" } } });
    await db.series.update({ where: { id: ids["conv-e"] }, data: { stage: "TESTING", testJobId: job.id } });
    await db.socialAccount.update({ where: { id: ids.cv_t_us1 }, data: { role: "MAIN" } });
    expect(await releaseTestsOnMainChannels()).toBeGreaterThan(0);
    expect((await db.publicationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("CANCELLED");
    expect((await db.series.findUniqueOrThrow({ where: { id: ids["conv-e"] } })).stage).toBe("NEW");
    await db.socialAccount.update({ where: { id: ids.cv_t_us1 }, data: { role: "TEST" } });
  });

  it("a series already out on one main channel is dropped from another one's line", async () => {
    await db.socialAccount.update({ where: { id: ids.cv_m_uk }, data: { role: "MAIN" } });
    const plan = await db.weeklyPlan.findFirstOrThrow();
    await db.publicationJob.create({
      data: {
        planId: plan.id, accountId: ids.cv_m_us2, platform: "YOUTUBE", format: "YT_SHORT", visibility: "PUBLIC", instanceKey: "conv-dup", idempotencyKey: "conv-dup",
        status: "PUBLISHED", scheduledAt: now, localTime: "x", timezone: NY, deadlineAt: now, caption: "x", externalId: "vid_dup", meta: { seriesId: ids["conv-c"] },
      },
    });
    await db.channelQueueItem.deleteMany({ where: { seriesId: ids["conv-c"] } });
    const eps = await db.episode.findMany({ where: { seriesId: ids["conv-c"] }, orderBy: { number: "asc" }, take: 3 });
    for (const [n, ep] of eps.entries()) await db.channelQueueItem.create({ data: { accountId: ids.cv_m_uk, seriesId: ids["conv-c"], episodeId: ep.id, position: 900 + n } });
    expect(await dropMainDuplicates()).toEqual(["Conv conv-c"]);
    expect(await db.channelQueueItem.count({ where: { seriesId: ids["conv-c"] } })).toBe(0);
    await db.socialAccount.update({ where: { id: ids.cv_m_uk }, data: { role: "TEST" } });
  });

  it("a main channel with a template gets its own version of every episode in its line", async () => {
    const tpl = await db.editTemplate.create({ data: { name: "conv-tpl", recipe: { preset: "warm", zoom: 1.05 }, variation: { zoom: [1.04, 1.06] } } });
    await db.socialAccount.update({ where: { id: ids.cv_m_us }, data: { editTemplateId: tpl.id } });
    const line = await db.channelQueueItem.findMany({ where: { accountId: ids.cv_m_us } });
    expect(line.length).toBeGreaterThan(0);
    const r = await prepareChannelVersions();
    expect(r.made).toBeGreaterThan(0);
    const vs = await db.videoVariant.findMany({ where: { accountId: ids.cv_m_us } });
    expect(vs.every((v) => v.templateId === tpl.id && v.status === "PENDING")).toBe(true);
    expect((await prepareChannelVersions()).made).toBe(0); // one version per episode and channel
    await db.videoVariant.deleteMany({ where: { accountId: ids.cv_m_us } });
    await db.socialAccount.update({ where: { id: ids.cv_m_us }, data: { editTemplateId: null } });
    await db.editTemplate.delete({ where: { id: tpl.id } });
  });

  it("a series with an episode over 3 min (not a Short) stays off main channels", async () => {
    const e = ids["conv-e"];
    await db.series.update({ where: { id: e }, data: { allowedGeos: ["US"], mainSkip: null } });
    const ep2 = await db.episode.findFirstOrThrow({ where: { seriesId: e, number: 2 } });
    await db.assetVersion.updateMany({ where: { asset: { episodeId: ep2.id } }, data: { durationSec: 222 } });
    await db.channelQueueItem.deleteMany({ where: { seriesId: e } });
    expect(await enqueueMain(e)).toEqual([]);
    expect((await db.series.findUniqueOrThrow({ where: { id: e } })).mainSkip).toContain("3:42");
    // Already lined up before the check existed: taken off while nothing has been uploaded.
    await db.series.update({ where: { id: e }, data: { mainSkip: null } });
    const eps = await db.episode.findMany({ where: { seriesId: e }, orderBy: { number: "asc" }, take: 3 });
    for (const [n, ep] of eps.entries()) await db.channelQueueItem.create({ data: { accountId: ids.cv_m_us, seriesId: e, episodeId: ep.id, position: 950 + n } });
    expect((await dropLongMain()).some((t) => t.startsWith("Conv conv-e"))).toBe(true);
    expect(await db.channelQueueItem.count({ where: { seriesId: e } })).toBe(0);
    expect((await db.series.findUniqueOrThrow({ where: { id: e } })).mainSkip).toContain("Серия 2");
    await db.assetVersion.updateMany({ where: { asset: { episodeId: ep2.id } }, data: { durationSec: 60 } });
  });

  it("a block on episode 2 fails the test even though episode 1 is clean, and unsent episodes are dropped", async () => {
    const e = ids["conv-e"];
    await db.series.update({ where: { id: e }, data: { stage: "NEW", testJobId: null, testLiveAt: null, testCheckedAt: null } });
    await db.socialAccount.update({ where: { id: ids.cv_t_us1 }, data: { status: "ACTIVE", role: "TEST" } });
    const first = await startSeriesTest({ seriesId: e, testAccountId: ids.cv_t_us1, launchAccountId: null, at: new Date(now.getTime() + 3600_000), tz: NY });
    const run = (first.meta as { testRun: string }).testRun;
    const jobs = await db.publicationJob.findMany({ where: { meta: { path: ["testRun"], equals: run } }, orderBy: { scheduledAt: "asc" } });
    expect(jobs).toHaveLength(3);
    await db.publicationJob.update({ where: { id: jobs[0].id }, data: { status: "PUBLISHED", externalId: "e_ok" } });
    await db.publicationJob.update({ where: { id: jobs[1].id }, data: { status: "PUBLISHED", externalId: "e_bad" } });
    vi.stubGlobal("fetch", async (url: string) => {
      const bad = String(url).includes("e_bad");
      return Response.json({ items: [{ id: bad ? "e_bad" : "e_ok", status: { uploadStatus: "processed", privacyStatus: "private" }, contentDetails: bad ? { regionRestriction: { blocked: ["US", "GB", "FR"] } } : {} }] });
    });
    await checkSeriesTests();
    const after = await db.series.findUniqueOrThrow({ where: { id: e } });
    expect(after.stage).toBe("TEST_FAILED");
    expect(after.testNote).toContain("серия 2");
    expect((await db.publicationJob.findUniqueOrThrow({ where: { id: jobs[2].id } })).status).toBe("CANCELLED");
  });

  it("a main upload blocked before its slot is not opened, and the series' later episodes on that channel are dropped", async () => {
    const d = ids["conv-d"];
    await db.series.update({ where: { id: d }, data: { stage: "IN_WORK" } });
    await db.channelQueueItem.deleteMany({ where: { seriesId: d } });
    const plan = await db.weeklyPlan.findFirstOrThrow();
    const eps = await db.episode.findMany({ where: { seriesId: d }, orderBy: { number: "asc" }, take: 3 });
    const mk = (n: number, status: "PUBLISHED" | "PROCESSING" | "QUEUED", externalId: string | null) =>
      db.publicationJob.create({
        data: {
          planId: plan.id, accountId: ids.cv_m_us, platform: "YOUTUBE", format: "YT_SHORT", visibility: "PUBLIC", instanceKey: `guard-${n}`, idempotencyKey: `guard-${n}`,
          status, scheduledAt: new Date(Date.now() + n * 3600_000), localTime: "x", timezone: NY, deadlineAt: now, caption: "x", externalId,
          meta: { seriesId: d, episodeId: eps[n].id },
        },
      });
    // Part 1 is at its slot (still "processing" here while it opens): it must be left alone.
    const j = [await mk(0, "PROCESSING", "g_ok"), await mk(1, "PROCESSING", "g_bad"), await mk(2, "QUEUED", null)];
    for (const [n, job] of j.entries()) await db.channelQueueItem.create({ data: { accountId: ids.cv_m_us, seriesId: d, episodeId: eps[n].id, position: 970 + n, jobId: job.id } });
    vi.stubGlobal("fetch", async (url: string) => {
      const bad = String(url).includes("g_bad");
      return Response.json({ items: [{ id: "x", status: { uploadStatus: "processed", privacyStatus: bad ? "private" : "public" }, contentDetails: bad ? { regionRestriction: { blocked: ["US"] } } : {} }] });
    });
    const stopped = await guardMainUploads();
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toContain("серия 2");
    const st = await db.publicationJob.findMany({ where: { id: { in: j.map((x) => x.id) } }, orderBy: { scheduledAt: "asc" } });
    expect(st.map((x) => x.status)).toEqual(["PROCESSING", "CANCEL_PENDING", "CANCELLED"]);
    expect(await db.channelQueueItem.count({ where: { seriesId: d } })).toBe(1); // Part 1 stays in the line
    expect((await db.series.findUniqueOrThrow({ where: { id: d } })).stage).toBe("TEST_FAILED");
    await db.publicationJob.deleteMany({ where: { id: { in: j.map((x) => x.id) } } });
  });

  it("a main episode YouTube removed stops the whole series on every channel", async () => {
    const d = ids["conv-d"];
    await db.series.update({ where: { id: d }, data: { stage: "IN_WORK", testNote: null } });
    const plan = await db.weeklyPlan.findFirstOrThrow();
    const eps = await db.episode.findMany({ where: { seriesId: d }, orderBy: { number: "asc" }, take: 3 });
    const mk = (n: number, acc: string, status: "PUBLISHED" | "PROCESSING" | "QUEUED", externalId: string | null, inH: number) =>
      db.publicationJob.create({
        data: {
          planId: plan.id, accountId: acc, platform: "YOUTUBE", format: "YT_SHORT", visibility: "PUBLIC", instanceKey: `rm-${n}-${acc}`, idempotencyKey: `rm-${n}-${acc}`,
          status, scheduledAt: new Date(Date.now() + inH * 3600_000), localTime: "x", timezone: NY, deadlineAt: now, caption: "x", externalId,
          meta: { seriesId: d, episodeId: eps[n].id },
        },
      });
    const removed = await mk(0, ids.cv_m_us, "PROCESSING", "r_gone", 0);
    const later = [await mk(1, ids.cv_m_us, "PROCESSING", "r_up", 3), await mk(2, ids.cv_m_us, "QUEUED", null, 6), await mk(1, ids.cv_m_uk, "QUEUED", null, 4)];
    await db.channelQueueItem.create({ data: { accountId: ids.cv_m_uk, seriesId: d, episodeId: eps[2].id, position: 990 } });
    const r = await stopSeriesAfterRemoval(removed.id, "Ролик не найден на YouTube");
    expect(r?.cancelled).toBe(3);
    const st = await db.publicationJob.findMany({ where: { id: { in: later.map((x) => x.id) } }, orderBy: { scheduledAt: "asc" } });
    expect(st.map((x) => x.status)).toEqual(["CANCEL_PENDING", "CANCELLED", "CANCELLED"]);
    expect(await db.channelQueueItem.count({ where: { seriesId: d } })).toBe(0);
    const s = await db.series.findUniqueOrThrow({ where: { id: d } });
    expect(s.stage).toBe("TEST_FAILED");
    expect(s.testNote).toContain("правил сообщества");
    await db.publicationJob.deleteMany({ where: { id: { in: [removed.id, ...later.map((x) => x.id)] } } });
  });

  it("jitter never puts a test before 09:00", () => {
    const day = local(now).startOf("day");
    for (let i = 0; i < 50; i++) {
      const [first] = testTimes({ id: `acc${i}` }, 0, day, { ...DEFAULT_CONVEYOR, testSlots: ["09:00"], jitterMin: 10 }, NY);
      expect(local(first.at).toFormat("HH:mm") >= "09:00").toBe(true);
    }
  });
});

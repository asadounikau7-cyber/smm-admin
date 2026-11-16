/**
 * Integration test against the dev database (DATABASE_URL). Covers AC-02: re-import of the same
 * file creates no duplicate, two concurrent approvals give one job per publication–account pair.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { db } from "./db";
import { importRegistry, type Registry } from "./registry";
import { approveWeek, buildWeek } from "./planner";

const reg: Registry = {
  verified_at_utc: "2026-11-06T18:00:00Z",
  series: [{ id: "test-900", title: "Test Show", expected: 3, episodes: [1, 2, 3].map((n) => ({ n, bytes: 1000 + n, key: `originals/t/en/test-900/episodes/ep-000${n}.mp4`, url: `https://example.invalid/${n}`, sha1: `sha${n}` })) }],
};
const TZ = "America/Winnipeg";
const weekStart = DateTime.now().setZone(TZ).plus({ weeks: 2 }).startOf("week").toUTC().toJSDate();
let userId = "";

async function cleanup() {
  const s = await db.series.findUnique({ where: { slug: "test-900" } });
  if (s) {
    await db.publicationJob.deleteMany({ where: { rule: { seriesId: s.id } } });
    await db.releaseRule.deleteMany({ where: { seriesId: s.id } });
    await db.asset.deleteMany({ where: { seriesId: s.id } });
    await db.series.delete({ where: { id: s.id } });
  }
  await db.socialAccount.deleteMany({ where: { externalId: "test_tt" } });
  await db.weeklyPlan.deleteMany({ where: { weekStart } });
}

beforeAll(async () => {
  await cleanup();
  userId = (await db.user.upsert({ where: { email: "test@example.invalid" }, update: {}, create: { email: "test@example.invalid", passwordHash: "x" } })).id;
});
afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe("planner", () => {
  it("re-import keeps one version per file", async () => {
    await importRegistry(reg);
    await importRegistry(reg);
    const versions = await db.assetVersion.count({ where: { asset: { objectKey: { startsWith: "originals/t/en/test-900/" } } } });
    expect(versions).toBe(3);
  });

  it("builds, blocks missing order, and approves idempotently under concurrency", async () => {
    await db.assetVersion.updateMany({ where: { asset: { objectKey: { startsWith: "originals/t/en/test-900/" } } }, data: { probedAt: new Date(), durationSec: 60, width: 1080, height: 1920 } });
    // Remove episode 2's file: strict order must stop the queue at E2.
    await db.asset.update({ where: { objectKey: "originals/t/en/test-900/episodes/ep-0002.mp4" }, data: { deletedAt: new Date() } });
    const series = await db.series.findUniqueOrThrow({ where: { slug: "test-900" } });
    const acc = await db.socialAccount.create({ data: { platform: "TIKTOK", externalId: "test_tt", handle: "test_tt", tiktokMode: "MANUAL" } });
    await db.releaseRule.create({
      data: { name: "t", seriesId: series.id, assetKind: "FULL_EPISODE", language: "en", accountId: acc.id, format: "TT_VIDEO", slots: [{ weekday: 2, time: "19:00" }, { weekday: 4, time: "19:00" }, { weekday: 6, time: "19:00" }] },
    });
    const planId = await buildWeek(weekStart, userId);
    const jobs = await db.publicationJob.findMany({ where: { planId, accountId: acc.id }, orderBy: { scheduledAt: "asc" } });
    expect(jobs.map((j) => j.status)).toEqual(["DRAFT", "BLOCKED"]);

    const [a, b] = await Promise.all([approveWeek(planId, userId, "k1", true), approveWeek(planId, userId, "k1", true)]);
    expect(a.ok && b.ok).toBe(true);
    const after = await db.publicationJob.findMany({ where: { planId, accountId: acc.id } });
    expect(after.filter((j) => j.status === "ACTION_REQUIRED")).toHaveLength(1); // manual TikTok package
    expect(after).toHaveLength(2);

    // Rebuild doesn't touch the approved row and doesn't duplicate.
    await buildWeek(weekStart, userId);
    const again = await db.publicationJob.findMany({ where: { planId, accountId: acc.id } });
    expect(again).toHaveLength(2);
  });
});

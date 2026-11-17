/**
 * Versions end to end against the dev database: generate per account, render on the server with ffmpeg,
 * and the planner publishes each account's own version.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { db } from "./db";
import { importRegistry, type Registry } from "./registry";
import { createVariants } from "./variants";
import { claimRender, renderOnServer } from "./renderJobs";
import { buildWeek } from "./planner";

const SLUG = "test-901";
const dir = mkdtempSync(path.join(tmpdir(), "vt-"));
const src = path.join(dir, "src.mp4");
const reg: Registry = {
  verified_at_utc: "2026-11-06T18:00:00Z",
  series: [{ id: SLUG, title: "Variant Show", expected: 2, episodes: [1, 2].map((n) => ({ n, bytes: 1000 + n, key: `originals/t/en/${SLUG}/episodes/ep-000${n}.mp4`, url: src, sha1: `vsha${n}` })) }],
};
const TZ = "America/Winnipeg";
const weekStart = DateTime.now().setZone(TZ).plus({ weeks: 3 }).startOf("week").toUTC().toJSDate();

async function cleanup() {
  const s = await db.series.findUnique({ where: { slug: SLUG } });
  if (s) {
    await db.publicationJob.deleteMany({ where: { rule: { seriesId: s.id } } });
    await db.releaseRule.deleteMany({ where: { seriesId: s.id } });
    await db.videoVariant.deleteMany({ where: { seriesId: s.id } });
    await db.asset.deleteMany({ where: { seriesId: s.id } });
    await db.series.delete({ where: { id: s.id } });
  }
  await db.socialAccount.deleteMany({ where: { externalId: { in: ["vt_a", "vt_b"] } } });
  await db.editTemplate.deleteMany({ where: { name: "vt-template" } });
  await db.weeklyPlan.deleteMany({ where: { weekStart } });
}

beforeAll(async () => {
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=540x960:rate=30:duration=6", "-f", "lavfi", "-i", "sine=duration=6", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", src]);
  await cleanup();
  await importRegistry(reg);
  await db.assetVersion.updateMany({ where: { asset: { seriesId: (await db.series.findUniqueOrThrow({ where: { slug: SLUG } })).id } }, data: { probedAt: new Date(), durationSec: 6, width: 540, height: 960, videoCodec: "h264", audioCodec: "aac" } });
}, 60_000);
afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe("versions", () => {
  it("gives every account its own distinct version, renders it, and the plan uses it", async () => {
    const series = await db.series.findUniqueOrThrow({ where: { slug: SLUG } });
    const [a, b] = await Promise.all([
      db.socialAccount.create({ data: { platform: "TIKTOK", externalId: "vt_a", handle: "vt_a", tiktokMode: "MANUAL", language: "en" } }),
      db.socialAccount.create({ data: { platform: "TIKTOK", externalId: "vt_b", handle: "vt_b", tiktokMode: "MANUAL", language: "en" } }),
    ]);
    const tpl = await db.editTemplate.create({
      data: { name: "vt-template", recipe: { texts: [{ text: "@{handle}", from: 0, to: null, pos: "bottom", size: 40 }] }, variation: { zoom: [1, 1.2], presets: ["none", "warm", "cool"], hookTexts: ["Wait for it", "No way"] } },
    });

    const r = await createVariants({ templateId: tpl.id, seriesId: series.id, episodes: [], accountIds: [a.id, b.id], pool: 1 });
    expect(r.created).toBe(6);
    const again = await createVariants({ templateId: tpl.id, seriesId: series.id, episodes: ["1"], accountIds: [a.id, b.id], pool: 0 });
    expect(again.created).toBe(0);
    expect(again.alreadyHad).toBe(2);

    const all = await db.videoVariant.findMany({ where: { seriesId: series.id }, orderBy: { code: "asc" } });
    expect(all.map((v) => v.code)).toContain(`${SLUG}-S01E01-EN-V001`);
    for (const ep of new Set(all.map((v) => v.episodeId))) {
      const sigs = all.filter((v) => v.episodeId === ep).map((v) => v.signature);
      expect(new Set(sigs).size).toBe(sigs.length);
    }

    // Render the two versions of account A on the server.
    const mine = all.filter((v) => v.accountId === a.id);
    for (let i = 0; i < all.length; i++) {
      const id = await claimRender("server");
      if (!id) break;
      if (mine.some((m) => m.id === id)) await renderOnServer(id);
      else await db.videoVariant.update({ where: { id }, data: { status: "PENDING", leaseUntil: null, createdAt: new Date(Date.now() + 3600_000) } });
    }
    const done = await db.videoVariant.findMany({ where: { accountId: a.id }, include: { output: { include: { versions: true } } } });
    for (const v of done) {
      expect(v.status, v.error ?? "").toBe("READY");
      expect(v.output?.versions[0].height).toBe(1920);
    }

    const ruleA = await db.releaseRule.create({ data: { name: "va", seriesId: series.id, assetKind: "FULL_EPISODE", language: "en", accountId: a.id, format: "TT_VIDEO", slots: [{ weekday: 2, time: "19:00" }] } });
    await db.releaseRule.create({ data: { name: "vb", seriesId: series.id, assetKind: "FULL_EPISODE", language: "en", accountId: b.id, format: "TT_VIDEO", slots: [{ weekday: 2, time: "20:00" }] } });
    const planId = await buildWeek(weekStart, null);
    const jobA = await db.publicationJob.findFirstOrThrow({ where: { planId, ruleId: ruleA.id }, include: { assetVersion: { include: { asset: true } } } });
    expect(done.map((v) => v.id)).toContain(jobA.assetVersion?.asset.renderOfId);
    expect(jobA.assetVersion?.asset.objectKey.startsWith("local:renders/")).toBe(true);
    expect(jobA.status).toBe("DRAFT");
    const jobB = await db.publicationJob.findFirstOrThrow({ where: { planId, accountId: b.id } });
    expect(jobB.status).toBe("BLOCKED"); // B's version isn't rendered yet
    expect(JSON.stringify(jobB.blockReasons)).toContain("ещё не собрана");
  }, 180_000);
});

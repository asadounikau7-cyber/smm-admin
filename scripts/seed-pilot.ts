/**
 * Imports the pilot series from data/seed/pilot-registry.json (a snapshot of the catalog registry)
 * and fills in video parameters measured from the files, so the plan can be built before
 * the worker has probed anything. Safe to re-run.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../src/lib/db";
import { importRegistry, type Registry } from "../src/lib/registry";

async function main() {
  const raw = JSON.parse(await readFile(path.join(process.cwd(), "data/seed/pilot-registry.json"), "utf8")) as Registry & {
    probe: Record<string, [number, number, number]>;
  };
  const r = await importRegistry(raw);
  for (const s of raw.series) {
    await db.series.update({ where: { slug: s.id }, data: { active: true } });
    for (const e of s.episodes) {
      const p = raw.probe[String(e.n)];
      if (!p) continue;
      await db.assetVersion.updateMany({
        where: { asset: { objectKey: e.key }, isCurrent: true, probedAt: null },
        data: { width: p[0], height: p[1], durationSec: p[2], probedAt: new Date() },
      });
    }
  }
  console.log("Pilot imported:", r);
  await db.$disconnect();
}
main();

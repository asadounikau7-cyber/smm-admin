import { b2Fetch, b2Reason, ensureB2Keys } from "./b2auth";
import { db } from "./db";
import { parseObjectKey } from "./pathParse";

/** Shape of the catalog page's embedded `<script id="data">` JSON. */
export type Registry = {
  verified_at_utc?: string;
  series: {
    id: string;
    title: string;
    expected?: number;
    episodes: { n: number; bytes: number; key: string; url: string; sha1?: string }[];
  }[];
};

export function extractRegistry(body: string): Registry {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const m = body.match(/<script[^>]*id=["']data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error("В странице каталога нет блока с данными (script#data)");
  return JSON.parse(m[1]);
}

export async function fetchRegistry(url: string): Promise<Registry> {
  await ensureB2Keys();
  const res = await b2Fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Каталог: HTTP ${res.status} ${await b2Reason(res)}`.trim());
  return extractRegistry(await res.text());
}

export type ImportResult = { series: number; seen: number; created: number; newVersions: number };

/**
 * Imports series titles and episode files. Re-import of the same file version (same sha1)
 * changes nothing; a new sha1 becomes a new current version.
 */
export async function importRegistry(reg: Registry): Promise<ImportResult> {
  const res: ImportResult = { series: 0, seen: 0, created: 0, newVersions: 0 };
  for (const s of reg.series) {
    const slug = String(s.id).toLowerCase();
    const series = await db.series.upsert({
      where: { slug },
      update: { title: s.title, expectedEpisodes: s.expected ?? null },
      create: { slug, title: s.title, expectedEpisodes: s.expected ?? null },
    });
    res.series++;

    const parsed = s.episodes.map((e) => ({ e, p: parseObjectKey(e.key) }));
    await db.episode.createMany({
      data: parsed.map(({ e, p }) => ({ seriesId: series.id, season: p.season ?? 1, number: p.episode ?? e.n })),
      skipDuplicates: true,
    });
    const episodes = await db.episode.findMany({ where: { seriesId: series.id } });
    const epId = (season: number, number: number) => episodes.find((x) => x.season === season && x.number === number)?.id ?? null;

    const existing = await db.asset.findMany({ where: { objectKey: { in: s.episodes.map((e) => e.key) } }, include: { versions: { where: { isCurrent: true } } } });
    const byKey = new Map(existing.map((a) => [a.objectKey, a]));

    for (const { e, p } of parsed) {
      res.seen++;
      let asset = byKey.get(e.key);
      if (!asset) {
        const created = await db.asset.create({
          data: {
            objectKey: e.key,
            publicUrl: e.url,
            seriesId: series.id,
            episodeId: epId(p.season ?? 1, p.episode ?? e.n),
            kind: p.kind ?? "FULL_EPISODE",
            language: p.language,
            variant: p.variant,
            needsMapping: !(p.language && (p.kind ?? "FULL_EPISODE")),
          },
        });
        asset = { ...created, versions: [] };
        res.created++;
      } else if (asset.publicUrl !== e.url || asset.deletedAt) {
        await db.asset.update({ where: { id: asset.id }, data: { publicUrl: e.url, deletedAt: null } });
      }
      const versionKey = e.sha1 ? `sha1:${e.sha1}` : `size:${e.bytes}`;
      if (asset.versions[0]?.versionKey === versionKey) continue;
      await db.$transaction([
        db.assetVersion.updateMany({ where: { assetId: asset.id, isCurrent: true }, data: { isCurrent: false } }),
        db.assetVersion.upsert({
          where: { assetId_versionKey: { assetId: asset.id, versionKey } },
          update: { isCurrent: true },
          create: { assetId: asset.id, versionKey, etag: e.sha1 ?? null, size: BigInt(e.bytes), lastModified: new Date(reg.verified_at_utc ?? Date.now()), isCurrent: true },
        }),
      ]);
      res.newVersions++;
    }
  }
  return res;
}

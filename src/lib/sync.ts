import { db } from "./db";
import { env } from "./env";
import { listObjects, type RemoteObject } from "./b2";
import { mediaUrl } from "./mediaSource";
import { fetchRegistry, importRegistry } from "./registry";
import { b2Configured } from "./env";
import { parseObjectKey } from "./pathParse";
import { probe } from "./media";
import { notify } from "./notify";

export type SyncResult = { seen: number; created: number; newVersions: number; deleted: number; needsMapping: number };

function versionKeyOf(o: RemoteObject) {
  return o.versionId ?? `etag:${o.etag ?? o.lastModified.toISOString()}`;
}

async function ensureSeries(slug: string) {
  return db.series.upsert({
    where: { slug },
    update: {},
    create: { slug, title: slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) },
  });
}

async function ensureEpisode(seriesId: string, season: number, number: number) {
  return db.episode.upsert({
    where: { seriesId_season_number: { seriesId, season, number } },
    update: {},
    create: { seriesId, season, number },
  });
}

/** Imports the bucket listing. Re-importing the same version updates the card without a duplicate. */
export async function syncCatalog(): Promise<SyncResult> {
  let fromRegistry: SyncResult | null = null;
  if (env().B2_REGISTRY_URL) {
    const r = await importRegistry(await fetchRegistry(env().B2_REGISTRY_URL!));
    fromRegistry = { seen: r.seen, created: r.created, newVersions: r.newVersions, deleted: 0, needsMapping: 0 };
    if (!b2Configured()) {
      await saveLastSync(fromRegistry);
      return fromRegistry;
    }
  }
  const objects = await listObjects();
  const res: SyncResult = { seen: objects.length, created: 0, newVersions: 0, deleted: 0, needsMapping: 0 };
  const seenKeys = new Set<string>();

  for (const o of objects) {
    seenKeys.add(o.key);
    const p = parseObjectKey(o.key, env().B2_PREFIX);
    if (!p.kind) continue; // not a media file we know

    let asset = await db.asset.findUnique({ where: { objectKey: o.key } });
    if (!asset) {
      const series = p.seriesSlug ? await ensureSeries(p.seriesSlug) : null;
      const episode =
        series && p.season !== null && p.episode !== null ? await ensureEpisode(series.id, p.season, p.episode) : null;
      asset = await db.asset.create({
        data: {
          objectKey: o.key,
          seriesId: series?.id,
          episodeId: episode?.id,
          kind: p.kind,
          language: p.language,
          variant: p.variant,
          needsMapping: !p.complete,
        },
      });
      res.created++;
    } else if (asset.deletedAt) {
      await db.asset.update({ where: { id: asset.id }, data: { deletedAt: null } });
    }

    const vk = versionKeyOf(o);
    const existing = await db.assetVersion.findUnique({ where: { assetId_versionKey: { assetId: asset.id, versionKey: vk } } });
    if (!existing) {
      const prev = await db.assetVersion.findFirst({ where: { assetId: asset.id, isCurrent: true } });
      await db.$transaction([
        db.assetVersion.updateMany({ where: { assetId: asset.id, isCurrent: true }, data: { isCurrent: false } }),
        db.assetVersion.create({
          data: {
            assetId: asset.id,
            versionKey: vk,
            etag: o.etag,
            size: BigInt(o.size),
            lastModified: o.lastModified,
            isCurrent: true,
          },
        }),
      ]);
      res.newVersions++;
      if (prev) {
        // Source replaced: approved jobs stay pinned to their version, but the owner must know.
        const pinned = await db.publicationJob.count({
          where: { assetVersionId: prev.id, status: { in: ["QUEUED", "MANUALLY_SCHEDULED"] } },
        });
        if (pinned > 0)
          await notify("asset-replaced:" + asset.id, "asset_replaced", `Файл ${o.key} заменён в B2. ${pinned} утверждённых задач закреплены за старой версией.`, `/catalog?asset=${asset.id}`);
      }
    }
    if (asset.needsMapping) res.needsMapping++;
  }

  // Mark removed objects.
  const live = await db.asset.findMany({ where: { deletedAt: null }, select: { id: true, objectKey: true } });
  for (const a of live) {
    if (!seenKeys.has(a.objectKey) && a.objectKey.startsWith(env().B2_PREFIX)) {
      await db.asset.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
      res.deleted++;
    }
  }

  await saveLastSync(res);
  return res;
}

async function saveLastSync(res: SyncResult) {
  const value = { at: new Date().toISOString(), ...res };
  await db.setting.upsert({ where: { key: "lastSync" }, update: { value }, create: { key: "lastSync", value } });
}

/** ffprobe every video version that hasn't been probed yet. */
export async function probePending(limit = 20) {
  const pending = await db.assetVersion.findMany({
    where: { probedAt: null, asset: { kind: { in: ["FULL_EPISODE", "VERTICAL", "TEASER"] }, deletedAt: null } },
    include: { asset: true },
    take: limit,
  });
  for (const v of pending) {
    try {
      const url = await mediaUrl(v.asset, v, 600);
      const r = await probe(url);
      await db.assetVersion.update({ where: { id: v.id }, data: { ...r, probedAt: new Date(), probeError: null } });
    } catch (e) {
      await db.assetVersion.update({
        where: { id: v.id },
        data: { probedAt: new Date(), probeError: String((e as Error).message).slice(0, 500) },
      });
    }
  }
  return pending.length;
}

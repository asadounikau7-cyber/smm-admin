import { db } from "./db";
import type { EditorSource } from "@/components/editor";

/** Episodes of active series that have a source file, for the template editor's preview. */
export async function editorSources(limit = 300): Promise<EditorSource[]> {
  const assets = await db.asset.findMany({
    where: { deletedAt: null, renderOfId: null, kind: { in: ["VERTICAL", "FULL_EPISODE"] }, episodeId: { not: null }, series: { active: true } },
    include: { series: true, episode: true, versions: { where: { isCurrent: true } } },
    orderBy: [{ seriesId: "asc" }, { objectKey: "asc" }],
    take: limit,
  });
  return assets
    .filter((a) => a.versions[0] && a.episode && a.series)
    .map((a) => ({
      versionId: a.versions[0].id,
      label: `${a.series!.title} · S${a.episode!.season}E${a.episode!.number}`,
      durationSec: a.versions[0].durationSec,
    }));
}

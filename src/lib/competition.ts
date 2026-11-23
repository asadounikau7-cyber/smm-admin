import type { Series } from "@prisma/client";
import { db } from "./db";
import { ytBiggestNamesake } from "./adapters/youtube";

/**
 * Looks the series up on YouTube and stores the views of the biggest video with its name.
 * Uses a working main channel's access (search reads public data only). Null when no channel can search.
 */
export async function checkCompetition(series: Pick<Series, "id" | "title">) {
  const account = await db.socialAccount.findFirst({ where: { platform: "YOUTUBE", role: "MAIN", status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  if (!account) return null;
  const { views, top } = await ytBiggestNamesake(account, series.title);
  await db.series.update({ where: { id: series.id }, data: { ytCompetition: views, ytCompetitionAt: new Date(), ytCompetitionTop: top } });
  return views;
}

import { db } from "./db";

/**
 * YouTube removes dramas that show children being mistreated (child safety policy) the moment they go
 * public: private tests don't catch it, and each removal is a warning, then strikes, per channel.
 * Since 2026-11-26 (3 removals in a day) series with children in the story stay off public YouTube.
 */
const CHILD = /\b(bab(y|ies)|son|sons|daughters?|dadd(y|ies)|dads?|mommy|mummy|kids?|child(ren)?|toddlers?|tots?|twins|triplets|quadruplets|quintuplets|little ones?|single (father|dad|mom|mother)|orphans?|newborns?|infants?|boy|schoolgirls?|schoolboys?)\b/i;

export const CHILD_SKIP = "Дети в сюжете";

/** The word that puts a series at risk, or null. */
export function childRisk(s: { title: string; synopsis?: string | null; hookTitle?: string | null }) {
  const m = [s.title, s.hookTitle ?? "", s.synopsis ?? ""].join(" \n ").replace(/['’]s\b/g, "").match(CHILD);
  return m ? m[0].toLowerCase() : null;
}

export const isChildSkip = (mainSkip: string | null | undefined) => Boolean(mainSkip?.startsWith(CHILD_SKIP));

/**
 * Takes child-themed series off the main channels and the film line: not-yet-public episodes are called off
 * (uploaded ones are kept private), queue items dropped, films in the works stopped. Already public videos stay.
 */
export async function dropChildSeries(now = new Date()) {
  const series = await db.series.findMany({
    where: { stage: "IN_WORK", NOT: { mainSkip: { startsWith: CHILD_SKIP } } },
    select: { id: true, title: true, synopsis: true, hookTitle: true },
  });
  const out: string[] = [];
  for (const s of series) {
    const word = childRisk(s);
    if (!word) continue;
    const jobs = await db.publicationJob.findMany({
      where: {
        platform: "YOUTUBE", visibility: "PUBLIC", status: { in: ["QUEUED", "SENT", "PROCESSING"] },
        meta: { path: ["seriesId"], equals: s.id }, scheduledAt: { gt: new Date(now.getTime() + 2 * 60_000) },
      },
    });
    for (const j of jobs) await db.publicationJob.update({ where: { id: j.id }, data: { status: j.externalId ? "CANCEL_PENDING" : "CANCELLED", nextAttemptAt: null } });
    await db.channelQueueItem.deleteMany({ where: { seriesId: s.id, account: { platform: "YOUTUBE" } } });
    await db.compilation.updateMany({
      where: { seriesId: s.id, status: { in: ["QUEUED", "BUILDING", "READY", "TESTING", "PASSED"] } },
      data: { status: "FAILED", note: `${CHILD_SKIP} («${word}»): фильм не выпускается` },
    });
    await db.series.update({ where: { id: s.id }, data: { mainSkip: `${CHILD_SKIP} («${word}»): правила YouTube о безопасности детей` } });
    out.push(`${s.title} («${word}», ${jobs.length} публикаций снято)`);
  }
  return out;
}

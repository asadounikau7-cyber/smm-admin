import type { Episode, Series } from "@prisma/client";

/** Version of the title/description format; jobs uploaded with an older one get their YouTube snippet refreshed. */
export const YT_META_VERSION = 2;

const BASE_TAGS = ["short drama", "mini drama", "drama", "drama shorts", "shorts", "romance drama", "movie clips", "drama series"];
const BASE_HASHTAGS = ["#shorts", "#drama", "#shortdrama", "#minidrama", "#dramashorts"];

const clean = (s: string) => s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();

/**
 * Title, description and tags for a YouTube upload of one episode.
 * A viewer who lands on a Short has never seen the series: "Part N" instead of "S01E02",
 * and a description that tells them the next part is on the channel.
 */
export function youtubeMeta(series: Pick<Series, "title" | "synopsis" | "hashtags">, ep: Pick<Episode, "season" | "number">) {
  const name = clean(series.title);
  const part = ep.season > 1 ? `Season ${ep.season} Part ${ep.number}` : `Part ${ep.number}`;
  let title = `${name} | ${part} #shortdrama`;
  if (title.length > 100) title = `${name.slice(0, 100 - part.length - 4).trimEnd()}… | ${part}`;

  const own = (series.hashtags ?? "").split(/\s+/).filter((h) => /^#\w+/.test(h));
  const hashtags = [...new Set([...BASE_HASHTAGS, ...own.map((h) => h.toLowerCase())])].join(" ");
  const next =
    ep.number === 1
      ? "Part 2 is already on the channel. Subscribe so you don't miss what happens next!"
      : `Missed the start? Part 1 is on the channel. Subscribe for a new drama every day!`;
  const description = [`${name} | ${part}`, series.synopsis ? clean(series.synopsis) : null, "", next, "", hashtags]
    .filter((l) => l !== null)
    .join("\n")
    .slice(0, 4900);

  const tags: string[] = [];
  let len = 0;
  for (const t of [name, `${name} ${part.toLowerCase()}`, ...BASE_TAGS]) {
    const tt = clean(t).slice(0, 100);
    if (len + tt.length + 3 > 480) break;
    tags.push(tt);
    len += tt.length + 3;
  }
  return { title, description, tags };
}

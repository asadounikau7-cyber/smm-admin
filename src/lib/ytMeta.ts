import type { Episode, Series } from "@prisma/client";

/** Version of the title/description format; jobs uploaded with an older one get their YouTube snippet refreshed. */
export const YT_META_VERSION = 4;

const BASE_TAGS = ["short drama", "mini drama", "drama", "drama shorts", "shorts", "romance drama", "movie clips", "drama series"];
const BASE_HASHTAGS = ["#shorts", "#drama", "#shortdrama", "#minidrama", "#dramashorts"];

const clean = (s: string) => s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();

/**
 * Title, description and tags for a YouTube upload of one episode.
 * A viewer who lands on a Short has never seen the series: "Part N" instead of "S01E02",
 * and a description that tells them the next part is on the channel.
 */
export function youtubeMeta(series: Pick<Series, "title" | "synopsis" | "hashtags"> & { hookTitle?: string | null }, ep: Pick<Episode, "season" | "number">) {
  const name = clean(series.title);
  const part = ep.season > 1 ? `Season ${ep.season} Part ${ep.number}` : `Part ${ep.number}`;
  // The plot hook sells better than the series name; the name stays in the description and tags.
  const head = series.hookTitle ? clean(series.hookTitle) : name;
  let title = `${head} | ${part} #shortdrama`;
  if (title.length > 100) title = `${head} | ${part}`;
  if (title.length > 100) title = `${head.slice(0, 100 - part.length - 4).trimEnd()}… | ${part}`;

  const own = (series.hashtags ?? "").split(/\s+/).filter((h) => /^#\w+/.test(h));
  const hashtags = [...new Set([...BASE_HASHTAGS, ...own.map((h) => h.toLowerCase())])].join(" ");
  const next =
    ep.number === 1
      ? "Part 2 is coming next on the channel. Subscribe so you don't miss what happens next!"
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

const SOCIAL_HASHTAGS: Record<"TIKTOK" | "INSTAGRAM", string[]> = {
  TIKTOK: ["#drama", "#shortdrama", "#minidrama", "#dramatok", "#fyp"],
  INSTAGRAM: ["#drama", "#shortdrama", "#minidrama", "#reels", "#dramaseries"],
};

/**
 * Caption for a TikTok post or an Instagram Reel of one episode: the hook (or the series name) with
 * "Part N", the series name, where the next part is, and hashtags. No title field on these platforms.
 */
export function socialCaption(
  platform: "TIKTOK" | "INSTAGRAM",
  series: Pick<Series, "title" | "hashtags"> & { hookTitle?: string | null },
  ep: Pick<Episode, "season" | "number">,
) {
  const name = clean(series.title);
  const part = ep.season > 1 ? `Season ${ep.season} Part ${ep.number}` : `Part ${ep.number}`;
  const head = series.hookTitle ? clean(series.hookTitle) : name;
  const next = ep.number === 1 ? "Follow for Part 2 👀" : "Part 1 is on the profile. Follow for more!";
  const own = (series.hashtags ?? "").split(/\s+/).filter((h) => /^#\w+/.test(h)).map((h) => h.toLowerCase());
  const tags = [...new Set([...SOCIAL_HASHTAGS[platform], ...own])].slice(0, platform === "INSTAGRAM" ? 30 : 8).join(" ");
  const lines = [`${head} | ${part}`, series.hookTitle ? name : null, next, "", tags].filter((l): l is string => l !== null);
  return lines.join("\n").slice(0, 2100);
}

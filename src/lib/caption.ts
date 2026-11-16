export type CaptionVars = {
  title?: string | null;
  series?: string | null;
  season?: number | null;
  episode?: number | null;
  cta?: string | null;
  hashtags?: string | null;
};

const pad = (n: number | null | undefined) => (n == null ? "" : String(n).padStart(2, "0"));

/** Substitutes {title} {series} {season} {episode} {cta} {hashtags}; drops empty lines left behind. */
export function renderCaption(template: string, v: CaptionVars): string {
  const map: Record<string, string> = {
    title: v.title ?? v.series ?? "",
    series: v.series ?? "",
    season: pad(v.season),
    episode: pad(v.episode),
    cta: v.cta ?? "",
    hashtags: v.hashtags ?? "",
  };
  let t = template;
  // A series-level teaser has no episode: drop the "— S{season}E{episode}" marker entirely.
  if (v.season == null || v.episode == null) t = t.replace(/\s*[—-]?\s*S\{season\}E\{episode\}/g, "");
  // A line that only held placeholders which came out empty is dropped; blank lines written in the template stay.
  return t
    .split("\n")
    .flatMap((line) => {
      const out = line.replace(/\{(\w+)\}/g, (_, k) => (k in map ? map[k] : `{${k}}`)).trimEnd();
      return out === "" && /\{\w+\}/.test(line) ? [] : [out];
    })
    .join("\n")
    .trim();
}

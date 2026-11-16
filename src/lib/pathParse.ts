import type { AssetKind } from "@prisma/client";

export type ParsedKey = {
  seriesSlug: string | null;
  season: number | null;
  episode: number | null;
  language: string | null;
  kind: AssetKind | null;
  variant: string | null;
  /// true when every field needed for publishing was recognized
  complete: boolean;
};

const LANG_RE = /^[a-z]{2}(-[A-Za-z]{2,4})?$/;
const VIDEO_EXT = ["mp4", "mov", "m4v", "webm"];
const IMAGE_EXT = ["jpg", "jpeg", "png", "webp"];
const SUB_EXT = ["srt", "vtt"];

export function kindFromFilename(name: string): AssetKind | null {
  const lower = name.toLowerCase();
  const ext = lower.split(".").pop() ?? "";
  if (SUB_EXT.includes(ext)) return "SUBTITLES";
  if (IMAGE_EXT.includes(ext)) return "COVER";
  if (!VIDEO_EXT.includes(ext)) return null;
  if (/(teaser|trailer|promo|anons|анонс)/.test(lower)) return "TEASER";
  if (/(vertical|vert|9x16|short|reel)/.test(lower)) return "VERTICAL";
  if (/(full|episode|ep|серия)/.test(lower)) return "FULL_EPISODE";
  return null;
}

/**
 * Parses keys like `releases/show-a/s01/e03/en/teaser-01.mp4`.
 * The path only speeds up import; anything can be fixed by hand afterwards.
 */
const FOLDER_KIND: Record<string, AssetKind> = {
  episodes: "FULL_EPISODE",
  vertical: "VERTICAL",
  teasers: "TEASER",
  covers: "COVER",
  subtitles: "SUBTITLES",
};

export function parseObjectKey(key: string, prefix = ""): ParsedKey {
  let rest = key;
  if (prefix && rest.startsWith(prefix)) rest = rest.slice(prefix.length);

  // Layout used in the production bucket: originals/<source>/<lang>/<seriesId>/episodes/ep-0001.mp4
  const lay = rest.match(/(?:^|\/)([a-z]{2}(?:-[A-Za-z]{2,4})?)\/([^/]+)\/(episodes|vertical|teasers|covers|subtitles)\/([^/]+)$/);
  if (lay) {
    const [, language, seriesSlug, folder, file] = lay;
    const kind = FOLDER_KIND[folder];
    const num = file.match(/(?:ep|e|episode)[-_ ]?0*(\d{1,4})/i) ?? file.match(/^0*(\d{1,4})\b/);
    const se = file.match(/s(\d{1,3})e(\d{1,4})/i);
    const season = se ? Number(se[1]) : num || kind === "FULL_EPISODE" || kind === "VERTICAL" ? 1 : null;
    const episode = se ? Number(se[2]) : num ? Number(num[1]) : null;
    const vm = file.replace(/\.[^.]+$/, "").match(/[-_]([a-z]|v\d+)$/i);
    const episodeBound = kind === "TEASER" || kind === "COVER" ? true : season !== null && episode !== null;
    return { seriesSlug: seriesSlug.toLowerCase(), season, episode, language: language.toLowerCase(), kind, variant: vm ? vm[1] : null, complete: episodeBound };
  }
  const parts = rest.split("/").filter(Boolean);
  const file = parts.pop() ?? "";
  if (parts[0] === "releases") parts.shift();

  let seriesSlug: string | null = null;
  let season: number | null = null;
  let episode: number | null = null;
  let language: string | null = null;

  for (const seg of parts) {
    const s = seg.match(/^s(\d{1,3})$/i);
    const e = seg.match(/^e(\d{1,4})$/i);
    const se = seg.match(/^s(\d{1,3})e(\d{1,4})$/i);
    if (se) {
      season = Number(se[1]);
      episode = Number(se[2]);
    } else if (s) season = Number(s[1]);
    else if (e) episode = Number(e[1]);
    else if (LANG_RE.test(seg) && seriesSlug) language = seg.toLowerCase();
    else if (!seriesSlug) seriesSlug = seg.toLowerCase();
  }

  // S01E03 inside the filename also counts.
  const fse = file.match(/s(\d{1,3})e(\d{1,4})/i);
  if (fse && season === null) season = Number(fse[1]);
  if (fse && episode === null) episode = Number(fse[2]);

  const kind = kindFromFilename(file);
  const base = file.replace(/\.[^.]+$/, "");
  const vm = base.match(/[-_](\d{1,3}|[a-z])$/i);
  const variant = vm ? vm[1] : null;

  const episodeBound = kind === "TEASER" || kind === "COVER" ? true : season !== null && episode !== null;
  const complete = Boolean(seriesSlug && kind && language && episodeBound);
  return { seriesSlug, season, episode, language, kind, variant, complete };
}

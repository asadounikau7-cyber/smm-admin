/**
 * Edit recipes: how one version of an episode is cut and styled. Pure code (no Node APIs),
 * shared by the server, the browser editor and (as ready-made ffmpeg arguments) the agent.
 *
 * Output is always 1080x1920, 30 fps, H.264/AAC, metadata stripped.
 */

export const PRESETS = {
  none: "Без фильтра",
  warm: "Тёплый",
  cool: "Холодный",
  vivid: "Сочный",
  contrast: "Контраст",
  vintage: "Винтаж",
  fade: "Выцветший",
  bw: "Ч/б",
} as const;
export type Preset = keyof typeof PRESETS;

export type TextPos = "top" | "center" | "bottom";
export type TextOverlay = {
  text: string;
  /** Seconds on the output timeline */
  from: number;
  /** null = until the end */
  to: number | null;
  pos: TextPos;
  /** px at 1080 width */
  size: number;
  color: string;
  box: boolean;
};

export type Recipe = {
  trimStart: number;
  trimEnd: number | null;
  /** Output length cap in seconds (null = no cap) */
  maxDuration: number | null;
  /** A short clip from later in the episode played first, as a hook */
  hook: { from: number; length: number } | null;
  zoom: number;
  panX: number;
  panY: number;
  speed: number;
  preset: Preset;
  brightness: number;
  contrast: number;
  saturation: number;
  sharpen: boolean;
  grain: number;
  vignette: boolean;
  fadeIn: number;
  fadeOut: number;
  volume: number;
  texts: TextOverlay[];
  coverTime: number;
};

export type Range = [number, number];
/** What changes from one generated version to the next. Empty = that parameter stays as in the base recipe. */
export type Variation = {
  trimStart?: Range;
  zoom?: Range;
  panX?: Range;
  panY?: Range;
  speed?: Range;
  brightness?: Range;
  contrast?: Range;
  saturation?: Range;
  grain?: Range;
  presets?: Preset[];
  /** One of these lines goes on top for the first seconds */
  hookTexts?: string[];
  hookTextSeconds?: number;
  /** Clip from this range of the source is played first */
  hookFrom?: Range;
  hookLength?: number;
  /** Share of versions that get the hook clip, 0..1 */
  hookChance?: number;
  coverTime?: Range;
};

export const DEFAULT_RECIPE: Recipe = {
  trimStart: 0,
  trimEnd: null,
  maxDuration: null,
  hook: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  speed: 1,
  preset: "none",
  brightness: 0,
  contrast: 1,
  saturation: 1,
  sharpen: false,
  grain: 0,
  vignette: false,
  fadeIn: 0,
  fadeOut: 0,
  volume: 1,
  texts: [],
  coverTime: 1,
};

export const DEFAULT_VARIATION: Variation = {
  trimStart: [0, 1.5],
  zoom: [1, 1.1],
  panX: [-0.4, 0.4],
  panY: [-0.3, 0.3],
  speed: [1, 1],
  brightness: [-0.03, 0.03],
  saturation: [0.95, 1.15],
  presets: ["none", "warm", "cool", "vivid", "contrast"],
  hookTexts: [],
  hookTextSeconds: 3,
  hookChance: 0,
  hookLength: 2.5,
};

const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const optNum = (v: unknown, lo: number, hi: number) => (v === null || v === undefined || v === "" ? null : clamp(v, lo, hi, lo));

/** Brings any JSON (form input, DB) to a valid recipe with rounded numbers. */
export function normalizeRecipe(input: unknown): Recipe {
  const x = (input ?? {}) as Partial<Recipe> & Record<string, unknown>;
  const d = DEFAULT_RECIPE;
  const hook = x.hook && typeof x.hook === "object" ? { from: r1(clamp(x.hook.from, 0, 36000, 0)), length: r1(clamp(x.hook.length, 0.5, 10, 2.5)) } : null;
  const trimStart = r1(clamp(x.trimStart, 0, 36000, 0));
  let trimEnd = optNum(x.trimEnd, 0, 36000);
  if (trimEnd !== null) trimEnd = r1(trimEnd);
  if (trimEnd !== null && trimEnd <= trimStart + 0.5) trimEnd = null;
  const maxDuration = optNum(x.maxDuration, 1, 36000);
  return {
    trimStart,
    trimEnd,
    maxDuration: maxDuration === null ? null : r1(maxDuration),
    hook,
    zoom: r2(clamp(x.zoom, 1, 2, d.zoom)),
    panX: r2(clamp(x.panX, -1, 1, 0)),
    panY: r2(clamp(x.panY, -1, 1, 0)),
    speed: r2(clamp(x.speed, 0.5, 2, 1)),
    preset: (x.preset && x.preset in PRESETS ? x.preset : "none") as Preset,
    brightness: r2(clamp(x.brightness, -0.5, 0.5, 0)),
    contrast: r2(clamp(x.contrast, 0.5, 2, 1)),
    saturation: r2(clamp(x.saturation, 0, 3, 1)),
    sharpen: Boolean(x.sharpen),
    grain: Math.round(clamp(x.grain, 0, 40, 0)),
    vignette: Boolean(x.vignette),
    fadeIn: r1(clamp(x.fadeIn, 0, 3, 0)),
    fadeOut: r1(clamp(x.fadeOut, 0, 3, 0)),
    volume: r2(clamp(x.volume, 0, 3, 1)),
    texts: (Array.isArray(x.texts) ? x.texts : [])
      .slice(0, 6)
      .map((t: Partial<TextOverlay>) => ({
        text: String(t?.text ?? "").slice(0, 200),
        from: r1(clamp(t?.from, 0, 36000, 0)),
        to: optNum(t?.to, 0, 36000),
        pos: (["top", "center", "bottom"].includes(String(t?.pos)) ? t!.pos : "top") as TextPos,
        size: Math.round(clamp(t?.size, 24, 160, 64)),
        color: /^(#[0-9a-fA-F]{6}|white|yellow|black|red|cyan)$/.test(String(t?.color)) ? String(t!.color) : "white",
        box: Boolean(t?.box),
      }))
      .filter((t) => t.text.trim()),
    coverTime: r1(clamp(x.coverTime, 0, 36000, 1)),
  };
}

export function normalizeVariation(input: unknown): Variation {
  const x = (input ?? {}) as Record<string, unknown>;
  const range = (v: unknown, lo: number, hi: number): Range | undefined => {
    if (!Array.isArray(v) || v.length !== 2) return undefined;
    const a = clamp(v[0], lo, hi, lo);
    const b = clamp(v[1], lo, hi, lo);
    return [r2(Math.min(a, b)), r2(Math.max(a, b))];
  };
  return {
    trimStart: range(x.trimStart, 0, 60),
    zoom: range(x.zoom, 1, 2),
    panX: range(x.panX, -1, 1),
    panY: range(x.panY, -1, 1),
    speed: range(x.speed, 0.5, 2),
    brightness: range(x.brightness, -0.5, 0.5),
    contrast: range(x.contrast, 0.5, 2),
    saturation: range(x.saturation, 0, 3),
    grain: range(x.grain, 0, 40),
    presets: Array.isArray(x.presets) ? (x.presets.filter((p) => typeof p === "string" && p in PRESETS) as Preset[]) : undefined,
    hookTexts: Array.isArray(x.hookTexts) ? x.hookTexts.map((t) => String(t).trim().slice(0, 200)).filter(Boolean).slice(0, 200) : undefined,
    hookTextSeconds: x.hookTextSeconds === undefined ? undefined : r1(clamp(x.hookTextSeconds, 0.5, 15, 3)),
    hookFrom: range(x.hookFrom, 0, 36000),
    hookLength: x.hookLength === undefined ? undefined : r1(clamp(x.hookLength, 0.5, 10, 2.5)),
    hookChance: x.hookChance === undefined ? undefined : r2(clamp(x.hookChance, 0, 1, 0)),
    coverTime: range(x.coverTime, 0, 36000),
  };
}

/** Stable short hash (FNV-1a, 2×32 bit) — same in Node and the browser. */
export function hashString(s: string) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** Identity of the visible result: two recipes with the same signature render the same video. */
export function recipeSignature(r: Recipe) {
  const { coverTime: _c, ...visible } = normalizeRecipe(r);
  return hashString(JSON.stringify(visible));
}

/** Seeded RNG so a template + seed always gives the same versions. */
export function rng(seed: string) {
  let a = parseInt(hashString(seed).slice(0, 8), 16) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One random recipe within the template's ranges. */
export function sampleRecipe(base: Recipe, v: Variation, rand: () => number): Recipe {
  const pick = (rg: Range | undefined, cur: number) => (rg ? rg[0] + (rg[1] - rg[0]) * rand() : cur);
  const r: Recipe = { ...base, texts: [...base.texts] };
  r.trimStart = pick(v.trimStart, base.trimStart);
  r.zoom = pick(v.zoom, base.zoom);
  r.panX = pick(v.panX, base.panX);
  r.panY = pick(v.panY, base.panY);
  r.speed = pick(v.speed, base.speed);
  r.brightness = pick(v.brightness, base.brightness);
  r.contrast = pick(v.contrast, base.contrast);
  r.saturation = pick(v.saturation, base.saturation);
  r.grain = pick(v.grain, base.grain);
  r.coverTime = pick(v.coverTime, base.coverTime);
  if (v.presets?.length) r.preset = v.presets[Math.floor(rand() * v.presets.length)];
  if (v.hookChance && v.hookFrom && rand() < v.hookChance) r.hook = { from: pick(v.hookFrom, 0), length: v.hookLength ?? 2.5 };
  if (v.hookTexts?.length) {
    const text = v.hookTexts[Math.floor(rand() * v.hookTexts.length)];
    r.texts = [{ text, from: 0, to: v.hookTextSeconds ?? 3, pos: "top", size: 68, color: "white", box: true }, ...r.texts];
  }
  return normalizeRecipe(r);
}

/** n different recipes, none of which has a signature in `taken`. */
export function generateRecipes(base: Recipe, v: Variation, n: number, seed: string, taken: Set<string> = new Set()) {
  const rand = rng(seed);
  const out: { recipe: Recipe; signature: string }[] = [];
  const seen = new Set(taken);
  for (let tries = 0; out.length < n && tries < n * 50 + 50; tries++) {
    const recipe = sampleRecipe(normalizeRecipe(base), v, rand);
    const signature = recipeSignature(recipe);
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push({ recipe, signature });
  }
  return out;
}

/** Output length for a source of `sourceDuration` seconds. */
export function outputDuration(r: Recipe, sourceDuration: number | null) {
  const { start, end } = segment(r, sourceDuration);
  return (end - start + (r.hook ? r.hook.length : 0)) / r.speed;
}

function segment(r: Recipe, sourceDuration: number | null) {
  const srcEnd = sourceDuration ?? 36000;
  const start = Math.min(r.trimStart, Math.max(0, srcEnd - 1));
  let end = Math.min(r.trimEnd ?? srcEnd, srcEnd);
  if (r.maxDuration) end = Math.min(end, start + r.maxDuration * r.speed - (r.hook ? r.hook.length : 0));
  if (end <= start) end = Math.min(srcEnd, start + 1);
  return { start, end };
}

const COLORS: Record<string, string> = { white: "white", yellow: "yellow", black: "black", red: "red", cyan: "cyan" };
const ffColor = (c: string) => COLORS[c] ?? `0x${c.replace("#", "")}`;
const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** Splits long lines so drawtext (which doesn't wrap) stays inside the frame. */
export function wrapText(text: string, size: number) {
  const max = Math.max(8, Math.floor(1000 / (size * 0.55)));
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (const w of para.split(/\s+/).filter(Boolean)) {
      if ((line + " " + w).trim().length > max && line) {
        out.push(line);
        line = w;
      } else line = (line + " " + w).trim();
    }
    out.push(line);
  }
  return out.join("\n");
}

function colorFilters(r: Recipe): string[] {
  const f: string[] = [];
  switch (r.preset) {
    case "warm": f.push("colorbalance=rs=0.08:gs=0.02:bs=-0.08:rm=0.05:bm=-0.05"); break;
    case "cool": f.push("colorbalance=rs=-0.07:bs=0.08:rm=-0.04:bm=0.05"); break;
    case "vivid": f.push("eq=saturation=1.3:contrast=1.06"); break;
    case "contrast": f.push("curves=preset=increase_contrast"); break;
    case "vintage": f.push("curves=preset=vintage"); break;
    case "fade": f.push("curves=all='0/0.08 1/0.92'", "eq=saturation=0.85"); break;
    case "bw": f.push("hue=s=0"); break;
  }
  if (r.brightness !== 0 || r.contrast !== 1 || r.saturation !== 1) f.push(`eq=brightness=${n(r.brightness)}:contrast=${n(r.contrast)}:saturation=${n(r.saturation)}`);
  if (r.sharpen) f.push("unsharp=5:5:0.6");
  if (r.vignette) f.push("vignette=PI/5");
  if (r.grain > 0) f.push(`noise=alls=${r.grain}:allf=t`);
  return f;
}

function textFilter(t: TextOverlay, file: string, timed: boolean) {
  const y = t.pos === "top" ? "h*0.1" : t.pos === "center" ? "(h-text_h)/2" : "h*0.8-text_h";
  const parts = [
    `drawtext=fontfile=font.ttf`,
    `textfile=${file}`,
    `expansion=none`,
    `fontsize=${t.size}`,
    `fontcolor=${ffColor(t.color)}`,
    `line_spacing=${Math.round(t.size * 0.2)}`,
    `borderw=${Math.max(2, Math.round(t.size / 14))}`,
    `bordercolor=black@0.85`,
    `x=(w-text_w)/2`,
    `y=${y}`,
  ];
  if (t.box) parts.push("box=1", "boxcolor=black@0.45", `boxborderw=${Math.round(t.size * 0.35)}`);
  if (timed) parts.push(`enable='between(t,${n(t.from)},${n(t.to ?? 36000)})'`);
  return parts.join(":");
}

export type RenderPlan = {
  /** ffmpeg arguments; paths are relative to a working folder holding in0.mp4, font.ttf and the text files */
  args: string[];
  /** Text files to write into the working folder */
  files: Record<string, string>;
  output: string;
  durationSec: number;
};

/** Full render: in0.mp4 → out.mp4 in the working folder. */
export function buildRender(r0: Recipe, src: { durationSec: number | null; hasAudio: boolean }, preset = "veryfast"): RenderPlan {
  const r = normalizeRecipe(r0);
  const { start, end } = segment(r, src.durationSec);
  const dur = (end - start + (r.hook ? r.hook.length : 0)) / r.speed;
  const files: Record<string, string> = {};
  const g: string[] = [];
  const A = src.hasAudio;

  if (r.hook) {
    const hs = r.hook.from;
    const he = src.durationSec ? Math.min(src.durationSec, hs + r.hook.length) : hs + r.hook.length;
    g.push(`[0:v]split=2[vs0][vs1]`);
    if (A) g.push(`[0:a]asplit=2[as0][as1]`);
    g.push(`[vs0]trim=start=${n(hs)}:end=${n(he)},setpts=PTS-STARTPTS[vh]`);
    g.push(`[vs1]trim=start=${n(start)}:end=${n(end)},setpts=PTS-STARTPTS[vm]`);
    if (A) {
      g.push(`[as0]atrim=start=${n(hs)}:end=${n(he)},asetpts=PTS-STARTPTS[ah]`);
      g.push(`[as1]atrim=start=${n(start)}:end=${n(end)},asetpts=PTS-STARTPTS[am]`);
      g.push(`[vh][ah][vm][am]concat=n=2:v=1:a=1[vc][ac]`);
    } else g.push(`[vh][vm]concat=n=2:v=1:a=0[vc]`);
  } else {
    g.push(`[0:v]trim=start=${n(start)}:end=${n(end)},setpts=PTS-STARTPTS[vc]`);
    if (A) g.push(`[0:a]atrim=start=${n(start)}:end=${n(end)},asetpts=PTS-STARTPTS[ac]`);
  }

  const v: string[] = [];
  if (r.speed !== 1) v.push(`setpts=PTS/${n(r.speed)}`);
  v.push(...frameFilters(r));
  r.texts.forEach((t, i) => {
    files[`t${i}.txt`] = wrapText(t.text, t.size);
    v.push(textFilter(t, `t${i}.txt`, true));
  });
  if (r.fadeIn > 0) v.push(`fade=t=in:st=0:d=${n(r.fadeIn)}`);
  if (r.fadeOut > 0) v.push(`fade=t=out:st=${n(Math.max(0, dur - r.fadeOut))}:d=${n(r.fadeOut)}`);
  g.push(`[vc]${v.join(",")}[vout]`);

  if (A) {
    const a: string[] = [];
    if (r.speed !== 1) a.push(`atempo=${n(r.speed)}`);
    if (r.volume !== 1) a.push(`volume=${n(r.volume)}`);
    if (r.fadeIn > 0) a.push(`afade=t=in:st=0:d=${n(r.fadeIn)}`);
    if (r.fadeOut > 0) a.push(`afade=t=out:st=${n(Math.max(0, dur - r.fadeOut))}:d=${n(r.fadeOut)}`);
    a.push("aresample=48000");
    g.push(`[ac]${a.join(",")}[aout]`);
  }

  const args = [
    "-hide_banner", "-y", "-i", "in0.mp4",
    "-filter_complex", g.join(";"),
    "-map", "[vout]",
    ...(A ? ["-map", "[aout]", "-c:a", "aac", "-b:a", "128k"] : ["-an"]),
    "-c:v", "libx264", "-preset", preset, "-crf", "20", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-map_metadata", "-1", "-map_chapters", "-1",
    "-movflags", "+faststart",
    "out.mp4",
  ];
  return { args, files, output: "out.mp4", durationSec: dur };
}

/** Framing and color, shared by the full render and the single-frame preview. */
function frameFilters(r: Recipe) {
  const z = r.zoom;
  return [
    `scale=w=${Math.ceil((1080 * z) / 2) * 2}:h=${Math.ceil((1920 * z) / 2) * 2}:force_original_aspect_ratio=increase`,
    `crop=1080:1920:(iw-ow)*${n((r.panX + 1) / 2)}:(ih-oh)*${n((r.panY + 1) / 2)}`,
    "setsar=1",
    "fps=30",
    ...colorFilters(r),
  ];
}

/** Where on the source a moment of the output comes from. */
export function sourceTimeAt(r: Recipe, outT: number, sourceDuration: number | null) {
  const { start } = segment(r, sourceDuration);
  const srcOffset = outT * r.speed;
  if (r.hook && srcOffset < r.hook.length) return r.hook.from + srcOffset;
  return start + srcOffset - (r.hook ? r.hook.length : 0);
}

/** One exact frame of the output at `outT` seconds, as JPEG (frame.jpg). Fast: seeks the source directly. */
export function buildFrame(r0: Recipe, outT: number, sourceDuration: number | null): RenderPlan {
  const r = normalizeRecipe(r0);
  const files: Record<string, string> = {};
  const v = frameFilters(r).filter((f) => !f.startsWith("fps=") && !f.startsWith("noise="));
  r.texts.forEach((t, i) => {
    if (outT < t.from || (t.to !== null && outT > t.to)) return;
    files[`t${i}.txt`] = wrapText(t.text, t.size);
    v.push(textFilter(t, `t${i}.txt`, false));
  });
  if (r.grain > 0) v.push(`noise=alls=${r.grain}`);
  const at = Math.max(0, sourceTimeAt(r, outT, sourceDuration));
  return {
    args: ["-hide_banner", "-y", "-ss", n(at), "-i", "in0.mp4", "-frames:v", "1", "-vf", v.join(","), "-q:v", "4", "frame.jpg"],
    files,
    output: "frame.jpg",
    durationSec: 0,
  };
}

/** CSS approximation of a preset for the live preview in the browser. */
export function cssFilter(r: Recipe) {
  const f: string[] = [];
  switch (r.preset) {
    case "warm": f.push("sepia(0.18) saturate(1.1)"); break;
    case "cool": f.push("hue-rotate(-10deg) saturate(0.95)"); break;
    case "vivid": f.push("saturate(1.3) contrast(1.06)"); break;
    case "contrast": f.push("contrast(1.2)"); break;
    case "vintage": f.push("sepia(0.35) contrast(0.95)"); break;
    case "fade": f.push("contrast(0.85) saturate(0.85) brightness(1.05)"); break;
    case "bw": f.push("grayscale(1)"); break;
  }
  f.push(`brightness(${1 + r.brightness}) contrast(${r.contrast}) saturate(${r.saturation})`);
  return f.join(" ");
}

export function variantCode(seriesSlug: string, season: number, episode: number, lang: string, num: number) {
  const p = (x: number, w = 2) => String(x).padStart(w, "0");
  return `${seriesSlug}-S${p(season)}E${p(episode)}-${lang.toUpperCase()}-V${p(num, 3)}`;
}

import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { DateTime } from "luxon";
import type { Compilation, Episode, Series, SocialAccount } from "@prisma/client";
import { db } from "./db";
import { probe, run } from "./media";
import { mediaUrl } from "./mediaSource";
import { sourceFor } from "./variants";
import { getOrCreatePlan } from "./planner";
import { toLocal, weekStartFor } from "./time";
import { RENDERS_DIR, renderPath } from "./renderStore";
import { ytVideoHealth } from "./adapters/youtube";
import { GEOS, getConveyorSettings, isGeo } from "./conveyor";
import { notify } from "./notify";
import { audit } from "./audit";

/**
 * Films: a whole series as one long vertical video (episodes back to back, chapters in the description).
 * For series whose episodes don't fit Shorts. Built on the server without re-encoding, tested privately
 * on a test channel (Content ID checks every minute of it), then published as a regular video on the
 * film channels, one a day each.
 */

/** Minutes a private film must stay clean after YouTube processed it. */
const FILM_WAIT_MIN = 60;
/** Films waiting (built, in test or passed) per film channel beyond what's scheduled; building pauses above this. */
const FILM_PIPELINE_PER_CHANNEL = 2;
/** Films planned ahead per channel. */
const FILM_DAYS_AHEAD = 2;
const BUILD_TIMEOUT_MS = 3 * 3600_000;

export type Chapter = { season: number; number: number; at: number };

const clean = (s: string) => s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
export const clock = (sec: number) => {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

/** Title, description (with chapters YouTube turns into a timeline) and tags of a film. */
export function filmMeta(series: Pick<Series, "title" | "synopsis"> & { hookTitle?: string | null }, chapters: Chapter[]) {
  const name = clean(series.title);
  const head = series.hookTitle ? clean(series.hookTitle) : name;
  const suffix = " | Full Series";
  const title = head.length + suffix.length <= 100 ? `${head}${suffix}` : `${head.slice(0, 100 - suffix.length - 1).trimEnd()}…${suffix}`;
  const multiSeason = new Set(chapters.map((c) => c.season)).size > 1;
  const lines = chapters.map((c) => `${clock(c.at)} ${multiSeason ? `Season ${c.season} ` : ""}Part ${c.number}`);
  const description = [
    `${name}: the full series, all ${chapters.length} parts in one video.`,
    series.synopsis ? clean(series.synopsis) : null,
    "",
    ...lines,
    "",
    "Subscribe for a new drama every day!",
    "",
    "#drama #shortdrama #fullseries #minidrama #dramaseries",
  ]
    .filter((l) => l !== null)
    .join("\n")
    .slice(0, 4900);
  const tags = [name, `${name} full series`, "drama full series", "short drama full", "full movie drama", "mini drama", "drama series"].map((t) => t.slice(0, 100));
  return { title, description, tags };
}

export async function filmAccounts() {
  const s = await getConveyorSettings();
  const [test, mains] = await Promise.all([
    s.filmTestAccountId ? db.socialAccount.findUnique({ where: { id: s.filmTestAccountId } }) : null,
    db.socialAccount.findMany({ where: { id: { in: s.filmAccountIds }, status: "ACTIVE" } }),
  ]);
  return { s, test: test?.status === "ACTIVE" ? test : null, mains };
}

/** Series that need a film: in work, kept off Shorts channels because an episode is too long. */
export async function queueFilms() {
  const { mains } = await filmAccounts();
  if (!mains.length) return 0;
  const max = FILM_PIPELINE_PER_CHANNEL * mains.length;
  const active = await db.compilation.count({ where: { status: { in: ["QUEUED", "BUILDING", "READY", "TESTING", "PASSED"] } } });
  if (active >= max) return 0;
  const next = await db.series.findMany({
    where: { stage: "IN_WORK", bannedAt: null, mainSkip: { not: null }, compilation: null },
    orderBy: { inWorkAt: "asc" },
    take: max - active,
    select: { id: true },
  });
  for (const s of next) await db.compilation.create({ data: { seriesId: s.id } });
  return next.length;
}

async function source(ep: Episode, language: string) {
  const src = await sourceFor(ep.id, language);
  if (!src) return null;
  let version = src.version;
  if (!version.probedAt) {
    try {
      const p = await probe(await mediaUrl(src.asset, version, 600, { internal: true }));
      version = await db.assetVersion.update({ where: { id: version.id }, data: { ...p, probedAt: new Date(), probeError: null } });
    } catch (e) {
      version = await db.assetVersion.update({ where: { id: version.id }, data: { probedAt: new Date(), probeError: (e as Error).message.slice(0, 500) } });
    }
  }
  return { asset: src.asset, version };
}

class FilmError extends Error {}

/** Concatenates every episode into one file without re-encoding; all episodes must share one format. */
export async function buildFilm(id: string, language = "en") {
  const comp = await db.compilation.findUniqueOrThrow({
    where: { id },
    include: { series: { include: { episodes: { orderBy: [{ season: "asc" }, { number: "asc" }] } } } },
  });
  const eps = comp.series.episodes;
  if (eps.length < 3) throw new FilmError(`Мало серий для фильма: ${eps.length}`);
  const files: { ep: Episode; asset: NonNullable<Awaited<ReturnType<typeof source>>>["asset"]; version: NonNullable<Awaited<ReturnType<typeof source>>>["version"] }[] = [];
  for (const ep of eps) {
    const f = await source(ep, language);
    if (!f) throw new FilmError(`Нет файла серии ${ep.number}`);
    if (f.version.probeError || !f.version.durationSec) throw new FilmError(`Серия ${ep.number} не читается`);
    if (!f.version.audioCodec) throw new FilmError(`В серии ${ep.number} нет звука`);
    files.push({ ep, ...f });
  }
  const sig = (v: (typeof files)[number]["version"]) => `${v.videoCodec}|${v.width}x${v.height}|${v.audioCodec}`;
  const odd = files.find((f) => sig(f.version) !== sig(files[0].version));
  if (odd) throw new FilmError(`Серии в разном формате (серия ${odd.ep.number}: ${sig(odd.version)}, серия 1: ${sig(files[0].version)}); без перекодирования не склеить`);

  const bytes = files.reduce((n, f) => n + Number(f.version.size), 0);
  await mkdir(RENDERS_DIR, { recursive: true });
  const fs = await statfs(RENDERS_DIR);
  if (fs.bavail * fs.bsize < bytes * 1.5 + 2 * 1024 ** 3) throw new Error(`Мало места на сервере для фильма (${(bytes / 1024 ** 3).toFixed(1)} ГБ)`);

  let at = 0;
  const chapters: Chapter[] = [];
  const list: string[] = [];
  for (const f of files) {
    chapters.push({ season: f.ep.season, number: f.ep.number, at });
    at += f.version.durationSec!;
    const url = await mediaUrl(f.asset, f.version, 6 * 3600, { internal: true, download: true });
    list.push(`file '${url.replace(/'/g, "'\\''")}'`);
  }
  const base = `film-${comp.series.slug}-${comp.id.slice(-6)}`;
  const listFile = renderPath(`${base}.txt`);
  const tmp = renderPath(`${base}.part.mp4`);
  await writeFile(listFile, list.join("\n") + "\n", "utf8");
  try {
    const r = await run(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file,http,https,tcp,tls,crypto", "-f", "concat", "-safe", "0", "-i", listFile,
        "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart", tmp],
      BUILD_TIMEOUT_MS,
    );
    if (r.code !== 0) throw new Error(`ffmpeg: ${r.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  } finally {
    await rm(listFile, { force: true });
  }
  const p = await probe(tmp);
  if (!p.durationSec || Math.abs(p.durationSec - at) > Math.max(5, at * 0.02)) {
    await rm(tmp, { force: true });
    throw new FilmError(`Склейка вышла неполной: ${Math.round(p.durationSec ?? 0)} с из ${Math.round(at)}`);
  }
  const file = `${base}.mp4`;
  await rename(tmp, renderPath(file));
  const size = (await stat(renderPath(file))).size;
  const rights = files.every((f) => f.asset.rightsConfirmed);
  const asset = await db.asset.upsert({
    where: { objectKey: `local:renders/${base}` },
    update: {},
    create: { objectKey: `local:renders/${base}`, seriesId: comp.seriesId, kind: "VERTICAL", language, variant: "film", needsMapping: false, rightsConfirmed: rights },
  });
  await db.assetVersion.updateMany({ where: { assetId: asset.id, isCurrent: true }, data: { isCurrent: false } });
  const version = await db.assetVersion.create({
    data: {
      assetId: asset.id, versionKey: file, etag: createHash("sha1").update(`${file}|${size}`).digest("hex"), size: BigInt(size), lastModified: new Date(), isCurrent: true,
      probedAt: new Date(), durationSec: p.durationSec, width: p.width, height: p.height, videoCodec: p.videoCodec, audioCodec: p.audioCodec,
    },
  });
  await db.compilation.update({
    where: { id },
    data: { status: "READY", assetVersionId: version.id, durationSec: p.durationSec, episodes: files.length, chapters, note: `Собран: ${files.length} серий, ${clock(p.durationSec)}` },
  });
  await audit("film.built", "Compilation", id, null, { series: comp.series.title, episodes: files.length, durationSec: p.durationSec, size });
}

let building: Promise<void> | null = null;

/** Starts building the next queued film in the background (one at a time); a build cut off by a restart starts over. */
export async function maybeBuildFilm() {
  if (building) return null;
  await db.compilation.updateMany({ where: { status: "BUILDING", updatedAt: { lt: new Date(Date.now() - BUILD_TIMEOUT_MS - 10 * 60_000) } }, data: { status: "QUEUED" } });
  if (await db.compilation.findFirst({ where: { status: "BUILDING" } })) return null;
  const next = await db.compilation.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" }, include: { series: { select: { title: true } } } });
  if (!next) return null;
  const { mains } = await filmAccounts();
  await db.compilation.update({ where: { id: next.id }, data: { status: "BUILDING", note: "Собирается" } });
  building = buildFilm(next.id, (mains[0]?.language || "en").toLowerCase())
    .catch(async (e) => {
      const msg = (e as Error).message.slice(0, 500);
      console.error(`[films] build ${next.series.title}: ${msg}`);
      // A lack of disk space is temporary; anything else about the files is not.
      await db.compilation.update({ where: { id: next.id }, data: e instanceof FilmError ? { status: "FAILED", note: msg } : { status: "QUEUED", note: `Повтор: ${msg}` } });
    })
    .finally(() => (building = null));
  return next.series.title;
}

function filmJobData(comp: Compilation & { series: Series }, account: SocialAccount, visibility: "PRIVATE" | "PUBLIC", scheduledAt: Date, tz: string) {
  const { title, description, tags } = filmMeta(comp.series, (comp.chapters ?? []) as Chapter[]);
  return {
    accountId: account.id,
    assetVersionId: comp.assetVersionId!,
    platform: "YOUTUBE" as const,
    format: "YT_VIDEO" as const,
    visibility,
    status: "QUEUED" as const,
    scheduledAt,
    localTime: toLocal(scheduledAt, tz),
    timezone: tz,
    deadlineAt: new Date(scheduledAt.getTime() + 12 * 3600_000),
    caption: description,
    title,
  };
}

async function createJob(comp: Compilation & { series: Series }, account: SocialAccount, visibility: "PRIVATE" | "PUBLIC", at: Date, purpose: "film-test" | "film") {
  const tz = isGeo(account.geo) ? GEOS[account.geo].tz : "America/New_York";
  const plan = await getOrCreatePlan(weekStartFor(at, tz));
  const instanceKey = `${purpose}:${comp.id}:${Date.now()}`;
  const data = filmJobData(comp, account, visibility, at, tz);
  const { tags } = filmMeta(comp.series, (comp.chapters ?? []) as Chapter[]);
  return db.publicationJob.create({
    data: {
      ...data,
      planId: plan.id,
      instanceKey,
      idempotencyKey: createHash("sha1").update(`${account.id}|${instanceKey}|${Date.now()}`).digest("hex"),
      meta: { purpose, compilationId: comp.id, seriesId: comp.seriesId, tags },
    },
  });
}

/** Built films go to the test channel privately; tested ones get a verdict after the wait. */
export async function testFilms(now = new Date()) {
  const { test, mains } = await filmAccounts();
  const events: string[] = [];
  for (const comp of await db.compilation.findMany({ where: { status: "READY" }, include: { series: true } })) {
    // Without a test channel the film is checked privately on the film channel it will come out on,
    // and that same upload is published after the check (no second upload).
    const target = test ?? (await leastBusy(mains));
    if (!target) break;
    const job = await createJob(comp, target, "PRIVATE", new Date(now.getTime() + 60_000), "film-test");
    await db.compilation.update({
      where: { id: comp.id },
      data: { status: "TESTING", testJobId: job.id, accountId: test ? null : target.id, note: `Закрытый тест на @${target.handle}` },
    });
    events.push(`test ${comp.series.title} → @${target.handle}`);
  }
  for (const comp of await db.compilation.findMany({ where: { status: "TESTING" }, include: { series: true } })) {
    const job = comp.testJobId ? await db.publicationJob.findUnique({ where: { id: comp.testJobId }, include: { account: true } }) : null;
    if (!job || ["FAILED", "CANCELLED", "BLOCKED"].includes(job.status)) {
      await fail(comp, `Тестовая загрузка не удалась: ${job?.errorMessage ?? job?.status ?? "нет задания"}`);
      continue;
    }
    if (job.status !== "PUBLISHED" || !job.externalId) {
      if (now.getTime() - comp.updatedAt.getTime() > 24 * 3600_000 && now.getTime() - job.createdAt.getTime() > 24 * 3600_000) await fail(comp, "Тест не завершился за сутки");
      continue;
    }
    if (now.getTime() - job.updatedAt.getTime() < FILM_WAIT_MIN * 60_000) continue;
    const h = await ytVideoHealth(job.account, job.externalId, "private");
    if (h.state === "pending") continue;
    if (h.state === "bad") {
      await fail(comp, h.note);
      events.push(`failed ${comp.series.title}: ${h.note}`);
      continue;
    }
    await db.compilation.update({ where: { id: comp.id }, data: { status: "PASSED", note: `Тест пройден: ${h.note}` } });
    events.push(`passed ${comp.series.title}`);
  }
  return events;
}

/** The film channel with the fewest films in the works. */
async function leastBusy(mains: SocialAccount[]) {
  const load = await Promise.all(
    mains.map(async (m) => ({ m, n: await db.compilation.count({ where: { accountId: m.id, status: { in: ["TESTING", "PASSED", "SCHEDULED"] } } }) })),
  );
  return load.sort((a, b) => a.n - b.n)[0]?.m ?? null;
}

async function fail(comp: Compilation & { series: Series }, note: string) {
  await db.compilation.update({ where: { id: comp.id }, data: { status: "FAILED", note } });
  await notify(`film:${comp.id}`, "film", `Фильм «${comp.series.title}» не прошёл тест: ${note.slice(0, 200)}`, "/films");
  await removeFile(comp);
}

async function removeFile(comp: Compilation) {
  if (!comp.assetVersionId) return;
  const v = await db.assetVersion.findUnique({ where: { id: comp.assetVersionId } });
  if (v) await rm(renderPath(v.versionKey), { force: true });
}

/** Passed films get the film slot on the film channels, one a day each, a couple of days ahead. */
export async function scheduleFilms(now = new Date()) {
  const { s, mains } = await filmAccounts();
  const planned: string[] = [];
  for (const account of mains) {
    const tz = isGeo(account.geo) ? GEOS[account.geo].tz : "America/New_York";
    const today = DateTime.fromJSDate(now, { zone: tz }).startOf("day");
    // As soon as possible: today only; the days after are planned when they come.
    for (let d = 0; d <= (s.filmAsap ? 0 : FILM_DAYS_AHEAD); d++) {
      const day = today.plus({ days: d });
      const taken = await db.publicationJob.findFirst({
        where: { accountId: account.id, status: { not: "CANCELLED" }, visibility: "PUBLIC", instanceKey: { startsWith: "film" }, scheduledAt: { gte: day.toJSDate(), lt: day.plus({ days: 1 }).toJSDate() } },
      });
      if (taken) continue;
      const comp = await db.compilation.findFirst({
        where: { status: "PASSED", OR: [{ accountId: null }, { accountId: account.id }] },
        orderBy: { updatedAt: "asc" },
        include: { series: true },
      });
      if (!comp) break;
      // A film already uploaded on this channel (checked in place) only needs YouTube to open it;
      // one still to upload needs time for a big file.
      const lead = comp.accountId === account.id ? 15 * 60_000 : 3 * 3600_000;
      let slot: Date;
      if (s.filmAsap) slot = new Date(now.getTime() + lead);
      else {
        const [h, m] = s.filmSlot.split(":").map(Number);
        slot = day.set({ hour: h, minute: m }).toJSDate();
        if (slot.getTime() < now.getTime() + lead) continue;
      }
      const job = comp.accountId ? await publishTested(comp, slot, tz) : await createJob(comp, account, "PUBLIC", slot, "film");
      await db.compilation.update({ where: { id: comp.id }, data: { status: "SCHEDULED", mainJobId: job.id, accountId: account.id, note: `Выйдет на @${account.handle} ${toLocal(slot, tz, "dd.MM HH:mm")}` } });
      planned.push(`${comp.series.title} → @${account.handle} ${slot.toISOString()}`);
    }
  }
  return planned;
}

/**
 * A film tested privately on its own channel: the same video gets the slot. The job turns public and
 * the YouTube step sets publishAt on the video, then follows it until it is open, like any main upload.
 */
async function publishTested(comp: Compilation, slot: Date, tz: string) {
  const job = await db.publicationJob.findUniqueOrThrow({ where: { id: comp.testJobId! } });
  const meta = (job.meta ?? {}) as Record<string, any>;
  return db.publicationJob.update({
    where: { id: job.id },
    data: {
      visibility: "PUBLIC",
      status: "PROCESSING",
      scheduledAt: slot,
      localTime: toLocal(slot, tz),
      timezone: tz,
      deadlineAt: new Date(slot.getTime() + 12 * 3600_000),
      nextAttemptAt: new Date(),
      meta: { ...meta, purpose: "film", adapter: { ...(meta.adapter ?? {}), scheduledNatively: true } },
    },
  });
}

/** Scheduled films whose video went out are marked published and their file is freed. */
export async function settleFilms() {
  for (const comp of await db.compilation.findMany({ where: { status: "SCHEDULED" }, include: { series: true } })) {
    const job = comp.mainJobId ? await db.publicationJob.findUnique({ where: { id: comp.mainJobId } }) : null;
    if (job?.status === "PUBLISHED") {
      await db.compilation.update({ where: { id: comp.id }, data: { status: "PUBLISHED", note: `Опубликован: ${job.externalUrl ?? job.externalId}` } });
      await removeFile(comp);
    } else if (!job || ["FAILED", "CANCELLED", "BLOCKED"].includes(job.status)) {
      // The slot is lost; the film goes back to the line for the next free one.
      await db.compilation.update({ where: { id: comp.id }, data: { status: "PASSED", mainJobId: null, accountId: null, note: `Выкладка не удалась (${job?.errorMessage ?? job?.status ?? "нет задания"}), ждёт нового слота` } });
    }
  }
}

export async function runFilms(now = new Date()) {
  const { mains } = await filmAccounts();
  if (!mains.length) return [];
  const out: string[] = [];
  const q = await queueFilms();
  if (q) out.push(`queued ${q}`);
  const b = await maybeBuildFilm();
  if (b) out.push(`building ${b}`);
  out.push(...(await testFilms(now)));
  out.push(...(await scheduleFilms(now)));
  await settleFilms();
  return out;
}

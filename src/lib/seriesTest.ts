import { youtubeMeta, YT_META_VERSION } from "./ytMeta";
import { createHash } from "node:crypto";
import type { AssetVersion, Episode, PostFormat, Series, SocialAccount, Visibility } from "@prisma/client";
import { db } from "./db";
import { env } from "./env";
import { probe } from "./media";
import { mediaUrl } from "./mediaSource";
import { sourceFor } from "./variants";
import { getOrCreatePlan } from "./planner";
import { toLocal, weekStartFor } from "./time";
import { VALIDATORS } from "./validators";
import { ytVideoHealth } from "./adapters/youtube";
import { notify, resolveNotification } from "./notify";
import { audit } from "./audit";
import { GEOS, enqueueMain, getConveyorSettings, geoCountries } from "./conveyor";

/**
 * YouTube test of a series: one episode goes to the test channel; if YouTube lets it live through the check window
 * (no rejection, no Content ID block), the whole series becomes "in work" and episode 1 goes to the main channel.
 */

export type YtTestSettings = {
  testAccountId: string | null;
  launchAccountId: string | null;
  /** How the test video is published on the test channel */
  visibility: "UNLISTED" | "PUBLIC" | "PRIVATE";
  /** Minutes the test video must stay clean after YouTube finished processing it */
  waitMin: number;
};

/** Private by default: an API project without Google's audit can only upload private videos anyway. */
export const DEFAULT_YT_TEST: YtTestSettings = { testAccountId: null, launchAccountId: null, visibility: "PRIVATE", waitMin: 30 };
const RECHECK_MS = 3 * 60_000;

export async function getYtTestSettings(): Promise<YtTestSettings> {
  const s = await db.setting.findUnique({ where: { key: "ytTest" } });
  return { ...DEFAULT_YT_TEST, ...((s?.value as Partial<YtTestSettings>) ?? {}) };
}

export async function saveYtTestSettings(v: YtTestSettings) {
  await db.setting.upsert({ where: { key: "ytTest" }, update: { value: v }, create: { key: "ytTest", value: v } });
}

/** The file an account should publish for an episode: its own ready edited version, else the original. */
async function fileFor(ep: Episode, account: SocialAccount) {
  const variant = await db.videoVariant.findUnique({
    where: { episodeId_accountId: { episodeId: ep.id, accountId: account.id } },
    include: { output: { include: { versions: { where: { isCurrent: true } } } } },
  });
  if (variant?.status === "READY" && variant.output?.versions[0]) {
    return { asset: variant.output, version: variant.output.versions[0], variant };
  }
  const src = await sourceFor(ep.id, (account.language || "en").toLowerCase());
  if (!src) return null;
  let version: AssetVersion = src.version;
  if (!version.probedAt) {
    try {
      const p = await probe(await mediaUrl(src.asset, version, 600, { internal: true }));
      version = await db.assetVersion.update({ where: { id: version.id }, data: { ...p, probedAt: new Date(), probeError: null } });
    } catch (e) {
      version = await db.assetVersion.update({ where: { id: version.id }, data: { probedAt: new Date(), probeError: (e as Error).message.slice(0, 500) } });
    }
  }
  return { asset: src.asset, version, variant: null };
}

function ytFormat(v: AssetVersion): PostFormat {
  const vertical = !v.width || !v.height || v.width <= v.height;
  return vertical && (v.durationSec ?? 0) <= VALIDATORS.YT_SHORT.maxSec ? "YT_SHORT" : "YT_VIDEO";
}

/** Seconds of the episode's file for this channel when it can't be a Short (over 3 min or horizontal); null when it can. */
export async function notAShort(ep: Episode, account: SocialAccount): Promise<number | null> {
  const file = await fileFor(ep, account);
  if (!file || file.version.probeError) return null;
  return ytFormat(file.version) === "YT_VIDEO" ? Math.round(file.version.durationSec ?? 0) : null;
}

export const fmtLen = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

const epLabel = (ep: Episode) => `S${String(ep.season).padStart(2, "0")}E${String(ep.number).padStart(2, "0")}`;

export type JobInput = {
  series: Series;
  ep: Episode;
  account: SocialAccount;
  visibility: Visibility;
  instanceKey: string;
  meta: Record<string, unknown>;
};

/** Creates (or re-arms a cancelled/failed) publication: right away, or at `at` (shown in time zone `tz`). */
export async function queueAt(i: JobInput, at?: Date, tz: string = env().BASE_TIMEZONE) {
  if (i.account.platform !== "YOUTUBE") throw new Error(`@${i.account.handle} — не YouTube-канал`);
  if (i.account.status !== "ACTIVE") throw new Error(`Канал @${i.account.handle} не подключён (нужно переподключить на странице «Аккаунты»)`);
  const file = await fileFor(i.ep, i.account);
  if (!file) throw new Error(`Нет файла для ${epLabel(i.ep)}`);
  if (file.version.probeError) throw new Error(`Файл ${epLabel(i.ep)} не читается: ${file.version.probeError.slice(0, 150)}`);

  const now = new Date();
  const scheduledAt = at ?? new Date(now.getTime() + 30_000);
  const plan = await getOrCreatePlan(weekStartFor(scheduledAt, env().BASE_TIMEZONE));
  const { title, description: caption, tags } = youtubeMeta(i.series, i.ep);
  const data = {
    accountId: i.account.id,
    assetVersionId: file.version.id,
    platform: i.account.platform,
    format: ytFormat(file.version),
    visibility: i.visibility,
    status: "QUEUED" as const,
    scheduledAt,
    localTime: toLocal(scheduledAt, tz),
    timezone: tz,
    deadlineAt: new Date(scheduledAt.getTime() + 6 * 3600_000),
    caption,
    title,
    meta: { ...i.meta, tags, ytMeta: YT_META_VERSION, seriesId: i.series.id, episodeId: i.ep.id, assetId: file.asset.id, variantId: file.variant?.id ?? null, variantCode: file.variant?.code ?? null },
    externalId: null,
    externalUrl: null,
    errorCode: null,
    errorMessage: null,
    attemptCount: 0,
    nextAttemptAt: null,
    leaseUntil: null,
  };
  const prev = await db.publicationJob.findUnique({ where: { accountId_instanceKey: { accountId: i.account.id, instanceKey: i.instanceKey } } });
  if (prev) {
    if (!["CANCELLED", "FAILED", "DRAFT", "BLOCKED"].includes(prev.status)) return prev;
    return db.publicationJob.update({ where: { id: prev.id }, data: { ...data, rowVersion: { increment: 1 } } });
  }
  return db.publicationJob.create({
    data: {
      ...data,
      planId: plan.id,
      instanceKey: i.instanceKey,
      idempotencyKey: createHash("sha1").update(`${i.account.id}|${i.instanceKey}|${now.getTime()}`).digest("hex"),
    },
  });
}

async function loadSeries(seriesId: string) {
  return db.series.findUniqueOrThrow({ where: { id: seriesId }, include: { episodes: { orderBy: [{ season: "asc" }, { number: "asc" }] } } });
}

/** Sends one episode of the series to the test channel and puts the series into "testing". */
export async function startSeriesTest(input: {
  seriesId: string;
  testAccountId: string;
  launchAccountId: string | null;
  episode?: number | null;
  userId?: string | null;
  /** Conveyor: upload at this time instead of right away */
  at?: Date;
  tz?: string;
}) {
  const series = await loadSeries(input.seriesId);
  if (series.bannedAt) throw new Error("Сериал помечен как Inactive (забанен)");
  if (series.stage === "TESTING") throw new Error("Тест уже идёт");
  if (input.launchAccountId && input.launchAccountId === input.testAccountId) throw new Error("Тестовый и основной канал должны быть разными");
  const ep = input.episode ? series.episodes.find((e) => e.season === 1 && e.number === input.episode) : series.episodes[0];
  if (!ep) throw new Error(input.episode ? `Нет серии ${input.episode}` : "В сериале нет серий");
  const account = await db.socialAccount.findUniqueOrThrow({ where: { id: input.testAccountId } });
  const settings = await getYtTestSettings();
  // The conveyor tests every episode that will go to a main channel: Content ID can sit on episode 2
  // of a series whose episode 1 is clean. A manual test checks the one episode asked for.
  const eps = input.at ? series.episodes.slice(0, Math.max(1, (await getConveyorSettings()).mainEpisodes)) : [ep];
  const run = `${series.id}:${Date.now()}`;
  const jobs = [];
  for (const [n, e] of eps.entries()) {
    const at = input.at ? new Date(input.at.getTime() + n * 2 * 60_000) : undefined;
    jobs.push(
      await queueAt(
        {
          series,
          ep: e,
          account,
          visibility: settings.visibility,
          instanceKey: n ? `test:${run}:e${e.number}` : `test:${run}`,
          meta: { purpose: "test", launchAccountId: input.launchAccountId, conveyor: Boolean(input.at), testRun: run },
        },
        at,
        input.tz,
      ),
    );
  }
  const job = jobs[0];
  const when = input.at ? `в ${toLocal(input.at, input.tz ?? env().BASE_TIMEZONE, "HH:mm")} (${input.tz ?? env().BASE_TIMEZONE})` : "сейчас";
  const what = eps.length > 1 ? `Серии 1–${eps.length}` : epLabel(ep);
  await db.series.update({
    where: { id: series.id },
    data: { stage: "TESTING", testJobId: job.id, testNote: `${what} грузятся на @${account.handle} ${when}`, testLiveAt: null, testCheckedAt: null, testQueuedAt: null },
  });
  await audit("series.test.start", "Series", series.id, input.userId ?? null, { jobIds: jobs.map((j) => j.id), account: account.handle, episodes: eps.map(epLabel) });
  return job;
}

/** Puts episode 1 of the series on the main channel right away. */
export async function launchFirstEpisode(seriesId: string, accountId: string, userId?: string | null) {
  const series = await loadSeries(seriesId);
  if (series.bannedAt) throw new Error("Сериал помечен как Inactive (забанен)");
  const ep = series.episodes[0];
  if (!ep) throw new Error("В сериале нет серий");
  const account = await db.socialAccount.findUniqueOrThrow({ where: { id: accountId } });
  // instanceKey ends with ":ep:<id>" so the weekly planner treats this episode as already published on this channel.
  const job = await queueAt({ series, ep, account, visibility: "PUBLIC", instanceKey: `launch:ep:${ep.id}`, meta: { purpose: "launch" } });
  await db.series.update({ where: { id: series.id }, data: { launchJobId: job.id } });
  await audit("series.launch", "Series", series.id, userId ?? null, { jobId: job.id, account: account.handle });
  return job;
}

export async function markTestPassed(seriesId: string, note: string, userId?: string | null, allowedGeos?: string[]) {
  // A clean test video plays everywhere: the series may go to every geo, including ones without a main channel yet.
  const geos = allowedGeos ?? Object.keys(GEOS);
  const series = await db.series.update({
    where: { id: seriesId },
    data: { stage: "IN_WORK", inWorkAt: new Date(), active: true, testNote: note, allowedGeos: geos },
  });
  await resolveNotification(`series-test:${seriesId}`);
  await audit("series.test.passed", "Series", seriesId, userId ?? null, { note, geos });
  if ((await getConveyorSettings()).enabled && geos.length) {
    const placed = await enqueueMain(seriesId);
    if (placed.length) {
      await db.series.update({ where: { id: seriesId }, data: { testNote: `${note}. В очереди: ${placed.map((p) => `@${p.handle}`).join(", ")}` } });
      return;
    }
  }
  const job = series.testJobId ? await db.publicationJob.findUnique({ where: { id: series.testJobId } }) : null;
  const launchAccountId = ((job?.meta ?? {}) as { launchAccountId?: string | null }).launchAccountId ?? (await getYtTestSettings()).launchAccountId;
  if (!launchAccountId) {
    await notify(`series-test:${seriesId}`, "series-test", `«${series.title}» прошёл тест и в работе: загрузите серии на основной канал вручную`, `/catalog?series=${seriesId}`);
    return;
  }
  try {
    await launchFirstEpisode(seriesId, launchAccountId, userId);
  } catch (e) {
    await db.series.update({ where: { id: seriesId }, data: { testNote: `${note}. Первая серия не запущена: ${(e as Error).message}` } });
    await notify(`series-test:${seriesId}`, "series-test", `«${series.title}» прошёл тест, но первая серия не запущена: ${(e as Error).message.slice(0, 150)}`, `/catalog?series=${seriesId}`);
  }
}

export async function markTestFailed(seriesId: string, note: string, userId?: string | null) {
  const series = await db.series.update({ where: { id: seriesId }, data: { stage: "TEST_FAILED", testNote: note } });
  // Episodes of the same test that haven't gone up yet are not needed any more.
  await db.publicationJob.updateMany({
    where: { status: "QUEUED", externalId: null, AND: [{ meta: { path: ["seriesId"], equals: seriesId } }, { meta: { path: ["purpose"], equals: "test" } }] },
    data: { status: "CANCELLED" },
  });
  await audit("series.test.failed", "Series", seriesId, userId ?? null, { note });
  await notify(`series-test:${seriesId}`, "series-test", `«${series.title}» не прошёл тест на YouTube: ${note.slice(0, 150)}`, `/catalog?series=${seriesId}`);
}

/** Worker: follows every series in testing and decides when YouTube's verdict is in. */
export async function checkSeriesTests() {
  const settings = await getYtTestSettings();
  const testing = await db.series.findMany({ where: { stage: "TESTING" } });
  for (const s of testing) {
    try {
      await checkOne(s, settings);
    } catch (e) {
      console.warn(`[series-test] ${s.slug}: ${(e as Error).message}`);
    }
  }
}

/** All uploads of one test (the conveyor sends several episodes), episode order. */
async function testRunJobs(testJobId: string) {
  const first = await db.publicationJob.findUnique({ where: { id: testJobId }, include: { account: true } });
  if (!first) return [];
  const run = (first.meta as { testRun?: string } | null)?.testRun;
  if (!run) return [first];
  return db.publicationJob.findMany({ where: { meta: { path: ["testRun"], equals: run } }, include: { account: true }, orderBy: { scheduledAt: "asc" } });
}

const jobEp = async (jobId: string) => {
  const j = await db.publicationJob.findUnique({ where: { id: jobId }, select: { meta: true } });
  const id = (j?.meta as { episodeId?: string } | null)?.episodeId;
  const ep = id ? await db.episode.findUnique({ where: { id } }) : null;
  return ep ? `серия ${ep.number}` : "серия";
};

async function checkOne(s: Series, settings: YtTestSettings) {
  const jobs = s.testJobId ? await testRunJobs(s.testJobId) : [];
  if (!jobs.length) return markTestFailed(s.id, "Тестовая публикация пропала");
  const setNote = (testNote: string, extra: object = {}) => db.series.update({ where: { id: s.id }, data: { testNote, ...extra } });
  const many = jobs.length > 1;
  const label = async (id: string) => (many ? `${await jobEp(id)}: ` : "");

  if (jobs.some((j) => j.status === "CANCELLED")) {
    await db.series.update({ where: { id: s.id }, data: { stage: "NEW", testNote: "Тест отменён" } });
    return;
  }
  for (const job of jobs) {
    if (!["ACTION_REQUIRED", "FAILED", "UNKNOWN"].includes(job.status)) continue;
    if (job.errorCode === "MODERATION") return markTestFailed(s.id, `${await label(job.id)}${job.errorMessage ?? "YouTube отклонил ролик"}`);
    // Our side (token, file, network): not a verdict on the series.
    await setNote(`Загрузка не удалась: ${job.errorMessage ?? job.errorCode ?? "ошибка"}. Исправьте и нажмите «Повторить» в публикации`);
    return;
  }
  const now = Date.now();
  if (s.testCheckedAt && now - s.testCheckedAt.getTime() < RECHECK_MS) return;
  // A finished upload is looked at even while the next episodes still upload: a block fails the test early.
  let geos = Object.keys(GEOS);
  let pending = false;
  const notes: string[] = [];
  for (const job of jobs) {
    if (job.status !== "PUBLISHED" || !job.externalId) {
      pending = true;
      continue;
    }
    const health = await ytVideoHealth(job.account, job.externalId, job.visibility.toLowerCase());
    if (health.state === "pending") pending = true;
    if (health.state !== "bad") continue;
    // Blocked only in some countries: the series can still go to the geos where it plays.
    if (!health.region) return markTestFailed(s.id, `${await label(job.id)}${health.note}`);
    const { blocked, allowed } = health.region;
    geos = geos.filter((g) => geoCountries(g).every((c) => !blocked?.includes(c) && (!allowed || allowed.includes(c))));
    if (!geos.length) return markTestFailed(s.id, `${await label(job.id)}${health.note}. Заблокирован во всех наших гео`);
    notes.push(`${await label(job.id)}${health.note}`);
  }
  const uploaded = jobs.every((j) => j.status === "PUBLISHED" && j.externalId);
  const liveAt = uploaded ? (s.testLiveAt ?? new Date(now)) : null;
  const left = liveAt ? Math.ceil((liveAt.getTime() + settings.waitMin * 60_000 - now) / 60_000) : settings.waitMin;
  const partial = notes.length ? ` (только ${geos.join(", ")}: ${notes.join("; ")})` : "";
  const what = many ? `${jobs.length} серии` : "";
  if (uploaded && !pending && left <= 0)
    return markTestPassed(s.id, `Прошёл${what ? ` (${what})` : ""}: ${settings.waitMin} мин на @${jobs[0].account.handle}${partial || " без блокировок"}`, null, notes.length ? geos : undefined);
  const note = !uploaded
    ? `Загружено ${jobs.filter((j) => j.externalId).length} из ${jobs.length} на @${jobs[0].account.handle}, YouTube обрабатывает`
    : pending
      ? "YouTube ещё обрабатывает ролик"
      : `Чисто${partial}, наблюдаем ещё ${left} мин`;
  await setNote(note, { testLiveAt: liveAt, testCheckedAt: new Date(now) });
}

/**
 * YouTube can put an age restriction on a video some time after the test passed. Series that passed
 * in the last two days are looked at again: an 18+ test video takes the series off the main channels'
 * line (episodes not uploaded yet) and marks it failed.
 */
export async function recheckPassedSeries(now = new Date()) {
  const recent = await db.series.findMany({
    where: { stage: "IN_WORK", inWorkAt: { gte: new Date(now.getTime() - 48 * 3600_000) }, testJobId: { not: null } },
  });
  const out: string[] = [];
  for (const s of recent) {
    let health: Awaited<ReturnType<typeof ytVideoHealth>> | null = null;
    for (const job of await testRunJobs(s.testJobId!)) {
      if (!job.externalId || job.account.platform !== "YOUTUBE") continue;
      try {
        const h = await ytVideoHealth(job.account, job.externalId, job.visibility.toLowerCase());
        if (h.state === "bad" && h.note.startsWith("18+")) {
          health = h;
          break;
        }
      } catch (e) {
        console.warn(`[series-test] recheck ${s.slug}: ${(e as Error).message}`);
      }
    }
    if (!health) continue;
    const items = await db.channelQueueItem.findMany({ where: { seriesId: s.id }, include: { account: true } });
    const kept: string[] = [];
    for (const i of items) {
      const j = i.jobId ? await db.publicationJob.findUnique({ where: { id: i.jobId } }) : null;
      if (j && (j.externalId || j.status !== "QUEUED")) {
        kept.push(`@${i.account.handle}`);
        continue;
      }
      if (j) await db.publicationJob.update({ where: { id: j.id }, data: { status: "CANCELLED" } });
      await db.channelQueueItem.delete({ where: { id: i.id } });
    }
    const note = `${health.note}; снят с очереди боевых${kept.length ? `, уже загружено на ${[...new Set(kept)].join(", ")}` : ""}`;
    await markTestFailed(s.id, note);
    out.push(`${s.title}: ${note}`);
  }
  return out;
}

/**
 * Main-channel uploads wait private until their slot. Each is looked at before it opens: if Content ID
 * blocks it where the channel plays (or YouTube marks it 18+ / rejects it), it is not opened, and the
 * series' episodes on that channel that aren't public yet are taken off too, so viewers don't get a
 * Part 3 without a Part 2. The series is marked failed. Returns what was stopped.
 */
export async function guardMainUploads(now = new Date()) {
  const jobs = await db.publicationJob.findMany({
    where: {
      platform: "YOUTUBE", visibility: "PUBLIC", status: { in: ["PROCESSING", "SENT"] }, externalId: { not: null },
      account: { role: "MAIN", status: "ACTIVE" }, scheduledAt: { gt: new Date(now.getTime() - 3600_000) },
    },
    include: { account: true },
    orderBy: { scheduledAt: "asc" },
  });
  const stopped: string[] = [];
  const done = new Set<string>();
  for (const job of jobs) {
    const meta = (job.meta ?? {}) as { seriesId?: string; episodeId?: string; purpose?: string };
    if (!meta.seriesId || !meta.episodeId || meta.purpose === "film" || done.has(`${job.accountId}|${meta.seriesId}`)) continue;
    let h;
    try {
      h = await ytVideoHealth(job.account, job.externalId!, "private");
    } catch (e) {
      console.warn(`[guard] ${job.externalId}: ${(e as Error).message}`);
      continue;
    }
    if (h.state !== "bad") continue;
    if (h.region) {
      const countries = geoCountries(job.account.geo ?? "");
      const { blocked, allowed } = h.region;
      if (countries.every((c) => !blocked?.includes(c) && (!allowed || allowed.includes(c)))) continue; // plays where this channel is
    }
    done.add(`${job.accountId}|${meta.seriesId}`);
    const ep = await db.episode.findUnique({ where: { id: meta.episodeId } });
    // Every episode of this series on this channel that isn't public yet: uploaded ones stay private, the rest are cancelled.
    const siblings = await db.publicationJob.findMany({
      where: { accountId: job.accountId, visibility: "PUBLIC", status: { in: ["QUEUED", "SENT", "PROCESSING"] }, meta: { path: ["seriesId"], equals: meta.seriesId } },
    });
    for (const j of siblings) await db.publicationJob.update({ where: { id: j.id }, data: { status: j.externalId ? "CANCEL_PENDING" : "CANCELLED", nextAttemptAt: null } });
    await db.channelQueueItem.deleteMany({ where: { accountId: job.accountId, seriesId: meta.seriesId, OR: [{ jobId: null }, { jobId: { in: siblings.map((j) => j.id) } }] } });
    const note = `На @${job.account.handle} серия ${ep?.number ?? "?"}: ${h.note}. Не публикуется, остальные неопубликованные серии сняты`;
    await markTestFailed(meta.seriesId, note);
    await audit("main.upload.stopped", "PublicationJob", job.id, null, { note, cancelled: siblings.map((j) => j.id) });
    stopped.push(note);
  }
  return stopped;
}

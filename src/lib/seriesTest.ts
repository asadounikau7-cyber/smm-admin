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

  const job = await queueAt(
    {
      series,
      ep,
      account,
      visibility: settings.visibility,
      instanceKey: `test:${series.id}:${Date.now()}`,
      meta: { purpose: "test", launchAccountId: input.launchAccountId, conveyor: Boolean(input.at) },
    },
    input.at,
    input.tz,
  );
  const when = input.at ? `в ${toLocal(input.at, input.tz ?? env().BASE_TIMEZONE, "HH:mm")} (${input.tz ?? env().BASE_TIMEZONE})` : "сейчас";
  await db.series.update({
    where: { id: series.id },
    data: { stage: "TESTING", testJobId: job.id, testNote: `${epLabel(ep)} грузится на @${account.handle} ${when}`, testLiveAt: null, testCheckedAt: null, testQueuedAt: null },
  });
  await audit("series.test.start", "Series", series.id, input.userId ?? null, { jobId: job.id, account: account.handle, episode: epLabel(ep) });
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

async function checkOne(s: Series, settings: YtTestSettings) {
  const job = s.testJobId ? await db.publicationJob.findUnique({ where: { id: s.testJobId }, include: { account: true } }) : null;
  if (!job) return markTestFailed(s.id, "Тестовая публикация пропала");
  const setNote = (testNote: string, extra: object = {}) => db.series.update({ where: { id: s.id }, data: { testNote, ...extra } });

  switch (job.status) {
    case "QUEUED":
    case "SENT":
    case "PROCESSING":
      if (job.externalId) await setNote(`Загружено на @${job.account.handle}, YouTube обрабатывает`);
      return;
    case "CANCELLED":
      await db.series.update({ where: { id: s.id }, data: { stage: "NEW", testNote: "Тест отменён" } });
      return;
    case "ACTION_REQUIRED":
    case "FAILED":
    case "UNKNOWN":
      if (job.errorCode === "MODERATION") return markTestFailed(s.id, job.errorMessage ?? "YouTube отклонил ролик");
      // Our side (token, file, network): not a verdict on the series.
      await setNote(`Загрузка не удалась: ${job.errorMessage ?? job.errorCode ?? "ошибка"}. Исправьте и нажмите «Повторить» в публикации`);
      return;
    case "PUBLISHED":
      break;
    default:
      return;
  }

  const now = Date.now();
  const liveAt = s.testLiveAt ?? new Date(now);
  if (s.testCheckedAt && now - s.testCheckedAt.getTime() < RECHECK_MS) return;
  const health = await ytVideoHealth(job.account, job.externalId!, job.visibility.toLowerCase());
  // Blocked only in some countries: the series can still go to the geos where it plays.
  let geos: string[] | undefined;
  if (health.state === "bad") {
    const ours = Object.keys(GEOS);
    if (!health.region) return markTestFailed(s.id, health.note);
    const { blocked, allowed } = health.region;
    geos = ours.filter((g) => geoCountries(g).every((c) => !blocked?.includes(c) && (!allowed || allowed.includes(c))));
    if (!geos.length) return markTestFailed(s.id, `${health.note}. Заблокирован во всех наших гео`);
  }
  const left = Math.ceil((liveAt.getTime() + settings.waitMin * 60_000 - now) / 60_000);
  const partial = geos ? ` (только ${geos.join(", ")}: ${health.note})` : "";
  if (health.state !== "pending" && left <= 0)
    return markTestPassed(s.id, `Прошёл: ${settings.waitMin} мин на @${job.account.handle}${partial || " без блокировок"}`, null, geos);
  await setNote(health.state === "pending" ? health.note : `Чисто${partial}, наблюдаем ещё ${left} мин`, { testLiveAt: liveAt, testCheckedAt: new Date(now) });
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
    const job = await db.publicationJob.findUnique({ where: { id: s.testJobId! }, include: { account: true } });
    if (!job?.externalId || job.account.platform !== "YOUTUBE") continue;
    let health;
    try {
      health = await ytVideoHealth(job.account, job.externalId, job.visibility.toLowerCase());
    } catch (e) {
      console.warn(`[series-test] recheck ${s.slug}: ${(e as Error).message}`);
      continue;
    }
    if (health.state !== "bad" || !health.note.startsWith("18+")) continue;
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

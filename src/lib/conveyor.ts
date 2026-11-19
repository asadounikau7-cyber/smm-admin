import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import type { SocialAccount } from "@prisma/client";
import { db } from "./db";
import { notify } from "./notify";
import { queueAt, startSeriesTest } from "./seriesTest";

/**
 * YouTube conveyor: test channels check new series every day at spread-out local times; series that pass
 * line up on the main channels of their geo and go out one slot at a time, first N episodes only.
 */

export const GEOS = {
  US: { label: "США", tz: "America/New_York", countries: ["US"] },
  UK: { label: "Великобритания", tz: "Europe/London", countries: ["GB"] },
} as const;
export type Geo = keyof typeof GEOS;
export const isGeo = (g: string | null | undefined): g is Geo => Boolean(g && g in GEOS);
export const geoTz = (g: Geo) => GEOS[g].tz;
export const geoCountries = (g: string) => (isGeo(g) ? [...GEOS[g].countries] : []);

export type ConveyorSettings = {
  enabled: boolean;
  /** When nobody queued series for testing, take the next untested ones from the catalog */
  autoPick: boolean;
  /** Local times on each test channel; their number = series tested per channel per day */
  testSlots: string[];
  /** Random shift of each test upload, ± minutes */
  jitterMin: number;
  /** Local times on each main channel */
  mainSlots: string[];
  /** Episodes of a passed series that go to a main channel */
  mainEpisodes: number;
  /** Pause new tests in a geo when its main channels are booked further ahead than this */
  backlogDays: number;
};

export const DEFAULT_CONVEYOR: ConveyorSettings = {
  enabled: false,
  autoPick: false,
  testSlots: ["11:00", "15:00", "19:00"],
  jitterMin: 10,
  mainSlots: ["10:00", "14:00", "19:00"],
  mainEpisodes: 3,
  backlogDays: 7,
};

/** Test channels of one geo are shifted against each other so two never upload within half an hour. */
const CHANNEL_SHIFT_MIN = 50;
/** A main-channel slot is taken if the channel already has a publication this close to it. */
const SLOT_CLEARANCE_MIN = 90;
const MAIN_DAYS_AHEAD = 2;
/** Main jobs closer than this stay where they are when slots change (upload lead is 6 h). */
const REPLAN_AFTER_MIN = 7 * 60;
/** Minimum distance between two uploads on one test channel. */
const TEST_GAP_MIN = 120;
/** Days of tests planned ahead: today and tomorrow. */
const TEST_DAYS_AHEAD = 2;
/** Local hours a channel may publish in (slots and shifted test times stay inside). */
export const WINDOW = { from: "09:00", to: "23:00" } as const;

export async function getConveyorSettings(): Promise<ConveyorSettings> {
  const s = await db.setting.findUnique({ where: { key: "ytConveyor" } });
  return { ...DEFAULT_CONVEYOR, ...((s?.value as Partial<ConveyorSettings>) ?? {}) };
}

export async function saveConveyorSettings(v: ConveyorSettings) {
  await db.setting.upsert({ where: { key: "ytConveyor" }, update: { value: v }, create: { key: "ytConveyor", value: v } });
}

/** Geos that have at least one working main channel. */
export async function conveyorGeos(): Promise<Geo[]> {
  const rows = await db.socialAccount.findMany({ where: { platform: "YOUTUBE", role: "MAIN", status: "ACTIVE", geo: { not: null } }, select: { geo: true } });
  return [...new Set(rows.map((r) => r.geo).filter(isGeo))];
}

const channels = (role: "MAIN" | "TEST", geo?: Geo) =>
  db.socialAccount.findMany({
    where: { platform: "YOUTUBE", role, status: "ACTIVE", geo: geo ?? { in: Object.keys(GEOS) } },
    orderBy: { createdAt: "asc" },
  });

/** Local wall-clock time on a given local date, as UTC. */
function at(date: DateTime, time: string, tz: string) {
  const [h, m] = time.split(":").map(Number);
  return DateTime.fromObject({ year: date.year, month: date.month, day: date.day, hour: h, minute: m }, { zone: tz }).toJSDate();
}

/** Same shift for the same channel, day and slot, so every worker tick computes the same time. */
function jitter(key: string, maxMin: number) {
  if (maxMin <= 0) return 0;
  const n = parseInt(createHash("sha1").update(key).digest("hex").slice(0, 8), 16);
  return (n % (2 * maxMin + 1)) - maxMin;
}

/** Main-channel slots booked ahead, in days, for a geo. */
export async function backlogDays(geo: Geo, s: ConveyorSettings) {
  const mains = await channels("MAIN", geo);
  if (!mains.length || !s.mainSlots.length) return Infinity;
  const pending = await db.channelQueueItem.count({ where: { accountId: { in: mains.map((m) => m.id) }, jobId: null } });
  return pending / (mains.length * s.mainSlots.length);
}

/**
 * Backlog that throttles tests on a geo's test channels. A test result covers every geo
 * (YouTube's region data decides where the series may go), so test channels of a geo with
 * no main channel yet keep testing for the geos that have one.
 */
async function testBacklog(geo: Geo, s: ConveyorSettings) {
  const own = await backlogDays(geo, s);
  if (own !== Infinity) return own;
  const others = await Promise.all((await conveyorGeos()).map((g) => backlogDays(g, s)));
  return others.length ? Math.min(...others) : Infinity;
}

// ---------- tests ----------

/** Planned test times for one channel on one local day. */
export function testTimes(account: Pick<SocialAccount, "id">, index: number, day: DateTime, s: ConveyorSettings, tz: string) {
  return s.testSlots.map((slot) => {
    const shift = index * CHANNEL_SHIFT_MIN + jitter(`${account.id}|${day.toISODate()}|${slot}`, s.jitterMin);
    // Jitter never pulls a time before the window opens.
    const t = Math.max(at(day, slot, tz).getTime() + shift * 60_000, at(day, WINDOW.from, tz).getTime());
    return { slot, at: new Date(t) };
  });
}

/** Next series to test: queued by a person first, then (if allowed) untested ones from the catalog. */
async function nextSeries(s: ConveyorSettings) {
  const queued = await db.series.findFirst({ where: { testQueuedAt: { not: null }, stage: { in: ["NEW", "TEST_FAILED"] }, bannedAt: null }, orderBy: { testQueuedAt: "asc" } });
  if (queued || !s.autoPick) return queued;
  // Only English content for now: series marked as another language (e.g. Spanish) wait.
  return db.series.findFirst({
    where: { stage: "NEW", bannedAt: null, episodes: { some: {} }, OR: [{ contentLang: null }, { contentLang: "en" }] },
    orderBy: [{ createdAt: "asc" }, { title: "asc" }],
  });
}

/** Worker: fills today's free test slots on every test channel. Idempotent per slot. */
export async function scheduleTests(now = new Date()) {
  const s = await getConveyorSettings();
  if (!s.enabled) return [];
  const created: { account: string; series: string; at: Date }[] = [];
  for (const geo of Object.keys(GEOS) as Geo[]) {
    const tests = await channels("TEST", geo);
    if (!tests.length) continue;
    if ((await testBacklog(geo, s)) > s.backlogDays) continue;
    const tz = geoTz(geo);
    const today = DateTime.fromJSDate(now, { zone: tz }).startOf("day");
    // Today and tomorrow are planned ahead, so the whole flow shows in Publications.
    for (let d = 0; d < TEST_DAYS_AHEAD; d++) {
      const day = today.plus({ days: d });
      for (const [index, account] of tests.entries()) {
        const taken = await db.publicationJob.findMany({
          where: { accountId: account.id, status: { not: "CANCELLED" }, meta: { path: ["conveyorSlot"], string_starts_with: `${day.toISODate()}|` } },
          select: { meta: true },
        });
        const used = new Set(taken.map((j) => (j.meta as { conveyorSlot?: string }).conveyorSlot));
        // Anything else on this channel today (older slot times, manual tests) keeps its distance too.
        const near = await db.publicationJob.findMany({
          where: { accountId: account.id, status: { not: "CANCELLED" }, scheduledAt: { gte: day.toJSDate(), lt: day.plus({ days: 1 }).toJSDate() } },
          select: { scheduledAt: true },
        });
        for (const t of testTimes(account, index, day, s, tz)) {
          const key = `${day.toISODate()}|${t.slot}`;
          if (used.has(key) || t.at.getTime() < now.getTime() + 5 * 60_000) continue;
          // A channel shifted far enough to land past the window skips that slot.
          if (t.at.getTime() > at(day, WINDOW.to, tz).getTime()) continue;
          if (near.some((j) => Math.abs(j.scheduledAt.getTime() - t.at.getTime()) < TEST_GAP_MIN * 60_000)) continue;
          // A series that can't be tested (no file) is set aside and the next one is tried.
          for (let tries = 0; tries < 5; tries++) {
            const series = await nextSeries(s);
            if (!series) break;
            try {
              const job = await startSeriesTest({ seriesId: series.id, testAccountId: account.id, launchAccountId: null, at: t.at, tz });
              await db.publicationJob.update({ where: { id: job.id }, data: { meta: { ...((job.meta ?? {}) as object), conveyorSlot: key } } });
              created.push({ account: account.handle, series: series.title, at: t.at });
              near.push({ scheduledAt: t.at });
              break;
            } catch (e) {
              await db.series.update({ where: { id: series.id }, data: { stage: "TEST_FAILED", testQueuedAt: null, testNote: `Не удалось поставить в тест: ${(e as Error).message}` } });
            }
          }
        }
      }
    }
  }
  return created;
}

// ---------- main channels ----------

/** Puts the first N episodes of a passed series in line on the least busy main channel of each allowed geo. */
export async function enqueueMain(seriesId: string) {
  const s = await getConveyorSettings();
  const series = await db.series.findUniqueOrThrow({ where: { id: seriesId }, include: { episodes: { orderBy: [{ season: "asc" }, { number: "asc" }] } } });
  const eps = series.episodes.slice(0, s.mainEpisodes);
  const placed: SocialAccount[] = [];
  for (const geo of series.allowedGeos.filter(isGeo)) {
    const mains = await channels("MAIN", geo);
    if (!mains.length) continue;
    // Already lined up on one of this geo's channels: leave it there.
    if (await db.channelQueueItem.findFirst({ where: { seriesId, accountId: { in: mains.map((m) => m.id) } } })) continue;
    const load = await Promise.all(mains.map(async (m) => ({ m, n: await db.channelQueueItem.count({ where: { accountId: m.id, jobId: null } }) })));
    const target = load.sort((a, b) => a.n - b.n)[0].m;
    const last = await db.channelQueueItem.findFirst({ where: { accountId: target.id }, orderBy: { position: "desc" } });
    let pos = (last?.position ?? 0) + 1;
    for (const ep of eps)
      await db.channelQueueItem.upsert({
        where: { accountId_episodeId: { accountId: target.id, episodeId: ep.id } },
        update: {},
        create: { accountId: target.id, seriesId, episodeId: ep.id, position: pos++ },
      });
    placed.push(target);
  }
  return placed;
}

/**
 * Series that passed while a geo had no main channel go to that geo's first main channel once
 * one appears. Only geos with a main channel and no queue entry for the series are touched.
 */
async function backfillMain() {
  const geos = await conveyorGeos();
  if (!geos.length) return;
  const mains = await channels("MAIN");
  const passed = await db.series.findMany({
    where: { stage: "IN_WORK", bannedAt: null, allowedGeos: { hasSome: geos } },
    select: { id: true, allowedGeos: true, queueItems: { select: { accountId: true } } },
  });
  for (const p of passed) {
    const queuedOn = new Set(p.queueItems.map((q) => mains.find((m) => m.id === q.accountId)?.geo));
    if (p.allowedGeos.some((g) => geos.includes(g as Geo) && !queuedOn.has(g))) await enqueueMain(p.id);
  }
}

/** Free slots on a main channel for the next days, skipping times it already has a publication near. */
async function freeMainSlots(account: SocialAccount, s: ConveyorSettings, now: Date) {
  const tz = geoTz(account.geo as Geo);
  const today = DateTime.fromJSDate(now, { zone: tz }).startOf("day");
  const until = today.plus({ days: MAIN_DAYS_AHEAD + 1 }).toJSDate();
  const busy = await db.publicationJob.findMany({
    where: { accountId: account.id, status: { notIn: ["CANCELLED", "DRAFT", "BLOCKED"] }, scheduledAt: { gte: new Date(now.getTime() - SLOT_CLEARANCE_MIN * 60_000), lte: until } },
    select: { scheduledAt: true },
  });
  const slots: Date[] = [];
  for (let d = 0; d <= MAIN_DAYS_AHEAD; d++)
    for (const time of [...s.mainSlots].sort()) {
      const t = at(today.plus({ days: d }), time, tz);
      if (t.getTime() < now.getTime() + 20 * 60_000) continue;
      if (busy.some((b) => Math.abs(b.scheduledAt.getTime() - t.getTime()) < SLOT_CLEARANCE_MIN * 60_000)) continue;
      slots.push(t);
    }
  return slots;
}

/** Worker: gives free main-channel slots to the episodes waiting in line, in order. */
/**
 * After the main slots change in Settings, episodes already given a time that is no longer a slot
 * are handed back to the queue and placed again in order. Only jobs not yet picked up for upload
 * (still QUEUED, beyond the upload lead) move; queueAt reuses the same job row.
 */
async function replanStale(account: SocialAccount, s: ConveyorSettings, now: Date) {
  const items = await db.channelQueueItem.findMany({ where: { accountId: account.id, jobId: { not: null } }, select: { jobId: true } });
  if (!items.length) return;
  const tz = geoTz(account.geo as Geo);
  const jobs = await db.publicationJob.findMany({
    where: { id: { in: items.map((i) => i.jobId!) }, status: "QUEUED", externalId: null, scheduledAt: { gt: new Date(now.getTime() + REPLAN_AFTER_MIN * 60_000) } },
    select: { id: true, scheduledAt: true },
  });
  const stale = jobs.filter((j) => !s.mainSlots.includes(DateTime.fromJSDate(j.scheduledAt, { zone: tz }).toFormat("HH:mm")));
  if (!stale.length) return;
  await db.publicationJob.updateMany({ where: { id: { in: stale.map((j) => j.id) }, status: "QUEUED" }, data: { status: "CANCELLED" } });
  await db.channelQueueItem.updateMany({ where: { jobId: { in: stale.map((j) => j.id) } }, data: { jobId: null } });
}

export async function scheduleMain(now = new Date()) {
  const s = await getConveyorSettings();
  if (!s.enabled) return [];
  await backfillMain();
  const created: { account: string; episode: string; at: Date }[] = [];
  for (const account of await channels("MAIN")) {
    await replanStale(account, s, now);
    const waiting = await db.channelQueueItem.findMany({
      where: { accountId: account.id, jobId: null },
      orderBy: { position: "asc" },
      include: { series: true },
      take: 20,
    });
    if (!waiting.length) continue;
    // Episodes go out in queue order: nothing new lands before an episode already placed.
    const placed = await db.channelQueueItem.findMany({ where: { accountId: account.id, jobId: { not: null } }, select: { jobId: true } });
    const last = await db.publicationJob.aggregate({
      where: { id: { in: placed.map((p) => p.jobId!) }, status: { not: "CANCELLED" } },
      _max: { scheduledAt: true },
    });
    const after = last._max.scheduledAt?.getTime() ?? 0;
    const slots = (await freeMainSlots(account, s, now)).filter((t) => t.getTime() > after);
    const tz = geoTz(account.geo as Geo);
    for (const item of waiting) {
      const slot = slots.shift();
      if (!slot) break;
      const ep = await db.episode.findUnique({ where: { id: item.episodeId } });
      if (!ep) {
        await db.channelQueueItem.delete({ where: { id: item.id } });
        continue;
      }
      try {
        // ":ep:<id>" + purpose "launch" let the weekly planner count it as already out on this channel.
        const job = await queueAt(
          { series: item.series, ep, account, visibility: "PUBLIC", instanceKey: `conveyor:ep:${ep.id}`, meta: { purpose: "launch", conveyor: true } },
          slot,
          tz,
        );
        await db.channelQueueItem.update({ where: { id: item.id }, data: { jobId: job.id } });
        created.push({ account: account.handle, episode: `${item.series.title} S${ep.season}E${ep.number}`, at: slot });
      } catch (e) {
        await notify(`conveyor:${item.id}`, "conveyor", `@${account.handle}: не удалось поставить «${item.series.title}» S${ep.season}E${ep.number}: ${(e as Error).message.slice(0, 150)}`, "/youtube");
        slots.unshift(slot);
        break; // keep the order: don't jump ahead to the next episode
      }
    }
  }
  return created;
}

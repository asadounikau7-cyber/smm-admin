import { db } from "@/lib/db";
import { env, catalogConfigured } from "@/lib/env";
import { syncCatalog, probePending } from "@/lib/sync";
import { adapterFor } from "@/lib/adapters";
import { igRefresh } from "@/lib/adapters/instagram";
import { collectChannelStats, postNextPartComments, refreshYoutubeMeta, syncSeriesPlaylists } from "@/lib/adapters/youtube";
import { claim, runCancel, runJob } from "@/lib/runner";
import { runFilms } from "@/lib/films";
import { flushEmails, notify } from "@/lib/notify";
import { loadIntegrationKeys } from "@/lib/integrationKeys";
import { checkSeriesTests, guardMainUploads, recheckPassedSeries } from "@/lib/seriesTest";
import { scheduleMain, scheduleTests } from "@/lib/conveyor";
import { markSpanishSeries } from "@/lib/language";
import { agentRenderOnline, claimRender, getRenderMode, renderOnServer } from "@/lib/renderJobs";

const TICK_MS = 15_000;
let lastSync = 0;
let lastRefresh = 0;
let lastConveyor = 0;
let stopping = false;

async function heartbeat() {
  const v = { at: new Date().toISOString(), pid: process.pid };
  await db.setting.upsert({ where: { key: "workerHeartbeat" }, update: { value: v }, create: { key: "workerHeartbeat", value: v } });
}

async function maybeSync() {
  if (!catalogConfigured()) return;
  const force = await db.setting.findUnique({ where: { key: "syncRequested" } });
  if (!force && Date.now() - lastSync < env().SYNC_INTERVAL_MIN * 60_000) return;
  lastSync = Date.now();
  if (force) await db.setting.delete({ where: { key: "syncRequested" } }).catch(() => {});
  try {
    const r = await syncCatalog();
    console.log(`[sync] ${JSON.stringify(r)}`);
    await markSpanishSeries();
    await probePending(50);
  } catch (e) {
    console.error("[sync]", e);
    await notify("sync", "sync", `Синхронизация с B2 не удалась: ${(e as Error).message.slice(0, 200)}`, "/catalog");
  }
}

async function refreshTokens() {
  if (Date.now() - lastRefresh < 6 * 3600_000) return;
  lastRefresh = Date.now();
  for (const a of await db.socialAccount.findMany({ where: { platform: "INSTAGRAM", status: "ACTIVE" } })) {
    try {
      await igRefresh(a);
    } catch (e) {
      console.warn(`[ig-refresh] ${a.handle}: ${(e as Error).message}`);
    }
  }
}

/** QUEUED jobs that are due: lead time depends on the platform (YouTube uploads hours ahead). */
async function dispatchDue() {
  const now = Date.now();
  const horizon = new Date(now + 7 * 3600_000);
  const queued = await db.publicationJob.findMany({
    where: { status: "QUEUED", scheduledAt: { lte: horizon }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
    include: { account: true },
    orderBy: { scheduledAt: "asc" },
    take: 50,
  });
  for (const j of queued) {
    const adapter = adapterFor(j.account);
    if (!adapter) continue;
    if (j.scheduledAt.getTime() - adapter.leadMinutes(j) * 60_000 > now) continue;
    // Missed slot: past the catch-up window and nothing was sent yet → ask the owner, never publish on our own.
    if (now > j.deadlineAt.getTime() && !j.externalId) {
      await db.publicationJob.update({ where: { id: j.id }, data: { status: "ACTION_REQUIRED", errorCode: "OVERDUE", errorMessage: "Слот пропущен, перенесите публикацию" } });
      await notify(`job:${j.id}`, "overdue", `Пропущен слот публикации на @${j.account.handle} (${j.localTime})`, `/publications?job=${j.id}`);
      continue;
    }
    if (await claim(j.id, ["QUEUED"])) await runJob(j.id);
  }
}

async function followUps() {
  const due = await db.publicationJob.findMany({
    where: { status: { in: ["SENT", "PROCESSING"] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
    select: { id: true },
    take: 50,
  });
  for (const j of due) if (await claim(j.id, ["SENT", "PROCESSING"])) await runJob(j.id);

  const cancels = await db.publicationJob.findMany({
    where: { status: "CANCEL_PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
    select: { id: true },
  });
  for (const j of cancels) if (await claim(j.id, ["CANCEL_PENDING"])) await runCancel(j.id);
}

let rendering: Promise<void> | null = null;

/** Renders one waiting version in the background when the owner's computer can't (or isn't set to). */
async function maybeRender() {
  if (rendering) return;
  const mode = await getRenderMode();
  if (mode === "agent" || (mode === "auto" && (await agentRenderOnline()))) return;
  const id = await claimRender("server");
  if (!id) return;
  console.log(`[render] ${id}`);
  rendering = renderOnServer(id)
    .catch((e) => console.error("[render]", e))
    .finally(() => (rendering = null));
}

let lastRecheck = 0;
let lastStats = 0;
let lastPlaylists = 0;
let lastFilms = 0;
let lastGuard = 0;

async function tick() {
  await heartbeat();
  await loadIntegrationKeys();
  await maybeSync();
  await refreshTokens();
  await dispatchDue();
  await followUps();
  await checkSeriesTests();
  if (Date.now() - lastRecheck > 30 * 60_000) {
    lastRecheck = Date.now();
    for (const r of await recheckPassedSeries().catch((e) => (console.error("[series-test] recheck", e), [] as string[]))) console.log(`[series-test] ${r}`);
  }
  if (Date.now() - lastConveyor > 2 * 60_000) {
    lastConveyor = Date.now();
    try {
      for (const t of await scheduleTests()) console.log(`[conveyor] test «${t.series}» on @${t.account} at ${t.at.toISOString()}`);
      for (const m of await scheduleMain()) console.log(`[conveyor] ${m.episode} on @${m.account} at ${m.at.toISOString()}`);
      for (const t of await refreshYoutubeMeta()) console.log(`[youtube] new title: ${t}`);
    } catch (e) {
      console.error("[conveyor]", e);
    }
  }
  // Channel numbers: hourly, so the morning report and the Stats page are fresh.
  if (Date.now() - lastStats > 60 * 60_000) {
    lastStats = Date.now();
    await collectChannelStats().then((n) => console.log(`[stats] ${n} channels`)).catch((e) => console.error("[stats]", e));
  }
  if (Date.now() - lastPlaylists > 10 * 60_000) {
    lastPlaylists = Date.now();
    for (const t of await syncSeriesPlaylists().catch((e) => (console.error("[playlists]", e), [] as string[]))) console.log(`[playlists] ${t}`);
    for (const t of await postNextPartComments().catch((e) => (console.error("[comments]", e), [] as string[]))) console.log(`[comments] ${t}`);
  }
  if (Date.now() - lastGuard > 20 * 60_000) {
    lastGuard = Date.now();
    for (const t of await guardMainUploads().catch((e) => (console.error("[guard]", e), [] as string[]))) console.log(`[guard] ${t}`);
  }
  if (Date.now() - lastFilms > 5 * 60_000) {
    lastFilms = Date.now();
    for (const t of await runFilms().catch((e) => (console.error("[films]", e), [] as string[]))) console.log(`[films] ${t}`);
  }
  await maybeRender();
  await flushEmails().catch((e) => console.error("[mail]", e));
}

async function main() {
  console.log(`[worker] started, tz=${env().BASE_TIMEZONE}`);
  await markSpanishSeries().then((n) => n && console.log(`[lang] marked ${n} Spanish series`)).catch((e) => console.error("[lang]", e));
  process.on("SIGTERM", () => (stopping = true));
  process.on("SIGINT", () => (stopping = true));
  while (!stopping) {
    const started = Date.now();
    try {
      await tick();
    } catch (e) {
      console.error("[worker] tick failed", e);
    }
    await new Promise((r) => setTimeout(r, Math.max(1000, TICK_MS - (Date.now() - started))));
  }
  await db.$disconnect();
  console.log("[worker] stopped");
}

main();

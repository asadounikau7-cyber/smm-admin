"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireOwner, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getConveyorSettings, saveConveyorSettings, WINDOW } from "@/lib/conveyor";
import { getYtTestSettings, launchFirstEpisode, markTestFailed, markTestPassed, saveYtTestSettings, startSeriesTest } from "@/lib/seriesTest";

const s = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};

const back = (id: string, kind: "ok" | "err", msg: string) => `/catalog?series=${id}&${kind}=${encodeURIComponent(msg)}`;

export async function startSeriesTestAction(f: FormData) {
  const u = await requireUser();
  const id = s(f, "id");
  const testAccountId = s(f, "testAccountId");
  if (!testAccountId) redirect(back(id, "err", "Выберите тестовый канал"));
  let msg = "";
  try {
    await startSeriesTest({
      seriesId: id,
      testAccountId,
      launchAccountId: s(f, "launchAccountId") || null,
      episode: s(f, "episode") ? Number(s(f, "episode")) : null,
      userId: u.id,
    });
  } catch (e) {
    msg = (e as Error).message;
  }
  revalidatePath("/catalog");
  redirect(msg ? back(id, "err", msg) : back(id, "ok", "Отправлено на тестовый канал. Статус обновится сам, страницу можно закрыть"));
}

export async function decideSeriesTestAction(f: FormData) {
  const u = await requireUser();
  const id = s(f, "id");
  const passed = s(f, "verdict") === "pass";
  const note = s(f, "note");
  if (passed) await markTestPassed(id, `Отмечено вручную: прошёл${note ? ` (${note})` : ""}`, u.id);
  else await markTestFailed(id, `Отмечено вручную: не прошёл${note ? ` (${note})` : ""}`, u.id);
  revalidatePath("/catalog");
  redirect(back(id, "ok", passed ? "Сериал в работе" : "Отмечено: тест не пройден"));
}

export async function launchSeriesAction(f: FormData) {
  const u = await requireUser();
  const id = s(f, "id");
  const accountId = s(f, "launchAccountId");
  if (!accountId) redirect(back(id, "err", "Выберите основной канал"));
  let msg = "";
  try {
    await launchFirstEpisode(id, accountId, u.id);
  } catch (e) {
    msg = (e as Error).message;
  }
  revalidatePath("/catalog");
  redirect(msg ? back(id, "err", msg) : back(id, "ok", "Первая серия отправлена на основной канал"));
}

export async function resetSeriesTestAction(f: FormData) {
  const u = await requireUser();
  const id = s(f, "id");
  await db.series.update({ where: { id }, data: { stage: "NEW", testNote: null, testLiveAt: null, testCheckedAt: null } });
  await audit("series.test.reset", "Series", id, u.id);
  revalidatePath("/catalog");
  redirect(back(id, "ok", "Статус теста сброшен"));
}

export async function saveYtTestSettingsAction(f: FormData) {
  const u = await requireOwner();
  const cur = await getYtTestSettings();
  const wait = Number(s(f, "waitMin"));
  const v = {
    testAccountId: s(f, "testAccountId") || null,
    launchAccountId: s(f, "launchAccountId") || null,
    visibility: (["PUBLIC", "PRIVATE"].includes(s(f, "visibility")) ? s(f, "visibility") : "UNLISTED") as "UNLISTED" | "PUBLIC" | "PRIVATE",
    waitMin: Number.isFinite(wait) && wait >= 0 ? Math.min(wait, 24 * 60) : cur.waitMin,
  };
  if (v.testAccountId && v.testAccountId === v.launchAccountId) redirect("/settings?err=" + encodeURIComponent("Тестовый и основной канал должны быть разными"));
  await saveYtTestSettings(v);
  await audit("settings.ytTest", "Setting", "ytTest", u.id, v);
  revalidatePath("/settings");
  redirect("/settings?ok=" + encodeURIComponent("Настройки YouTube-теста сохранены"));
}

/** Manual upload to the main channel: the operator pastes the link of the video they uploaded in YouTube Studio. */
export async function markEpisodePostedAction(f: FormData) {
  const u = await requireUser();
  const id = s(f, "episodeId");
  const url = s(f, "url");
  const ep = await db.episode.findUniqueOrThrow({ where: { id } });
  if (url && !/^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(url)) redirect(back(ep.seriesId, "err", "Нужна ссылка на ролик YouTube"));
  await db.episode.update({ where: { id }, data: url ? { mainUrl: url, mainPostedAt: new Date() } : { mainUrl: null, mainPostedAt: null } });
  await audit(url ? "episode.main.posted" : "episode.main.unposted", "Episode", id, u.id, { url: url || null });
  revalidatePath("/catalog");
  redirect(back(ep.seriesId, "ok", url ? `S${ep.season}E${ep.number} отмечена как загруженная` : "Отметка снята"));
}

/** Back to watching the same test video (e.g. after a wrong automatic verdict). */
export async function resumeSeriesTestAction(f: FormData) {
  const u = await requireUser();
  const id = s(f, "id");
  await db.series.update({ where: { id }, data: { stage: "TESTING", testCheckedAt: null, testNote: "Наблюдение продолжено" } });
  await audit("series.test.resume", "Series", id, u.id);
  revalidatePath("/catalog");
  redirect(back(id, "ok", "Наблюдение за тестовым роликом продолжено"));
}

const times = (v: string) =>
  [...new Set(v.split(/[,\s]+/).filter((x) => /^\d{1,2}:\d{2}$/.test(x)).map((x) => x.padStart(5, "0")))].filter((x) => x >= WINDOW.from && x <= WINDOW.to).sort();

export async function saveConveyorSettingsAction(f: FormData) {
  const u = await requireOwner();
  const cur = await getConveyorSettings();
  const num = (k: string, min: number, max: number, def: number) => {
    const n = Number(s(f, k));
    return Number.isFinite(n) && s(f, k) !== "" ? Math.max(min, Math.min(max, Math.round(n))) : def;
  };
  const v = {
    ...cur,
    enabled: f.get("enabled") === "on",
    autoPick: f.get("autoPick") === "on",
    testSlots: times(s(f, "testSlots")),
    jitterMin: num("jitterMin", 0, 30, cur.jitterMin),
    mainSlots: times(s(f, "mainSlots")),
    mainEpisodes: num("mainEpisodes", 1, 50, cur.mainEpisodes),
    backlogDays: num("backlogDays", 1, 60, cur.backlogDays),
    channelVersions: f.get("channelVersions") === "on",
  };
  if (!v.testSlots.length || !v.mainSlots.length) redirect("/settings?err=" + encodeURIComponent(`Укажите слоты в формате 11:00, 15:00 в пределах ${WINDOW.from}–${WINDOW.to}`));
  await saveConveyorSettings(v);
  await audit("settings.ytConveyor", "Setting", "ytConveyor", u.id, v);
  revalidatePath("/settings");
  redirect("/settings?ok=" + encodeURIComponent(v.enabled ? "Конвейер включён" : "Настройки конвейера сохранены"));
}

/** Adds the series to (or removes it from) the conveyor's test queue. */
export async function queueSeriesTestAction(f: FormData) {
  const u = await requireUser();
  const id = s(f, "id");
  const on = s(f, "on") === "1";
  await db.series.update({ where: { id }, data: { testQueuedAt: on ? new Date() : null } });
  await audit(on ? "series.test.queued" : "series.test.unqueued", "Series", id, u.id);
  revalidatePath("/catalog");
  revalidatePath("/youtube");
  redirect(s(f, "back") || back(id, "ok", on ? "В очереди на тест: конвейер возьмёт его в ближайший слот" : "Убран из очереди на тест"));
}

export async function deleteTestUploadsAction(f: FormData) {
  const u = await requireOwner();
  const id = s(f, "id");
  if (s(f, "confirm") !== "DELETE") redirect(`/youtube?err=${encodeURIComponent("Удаление не подтверждено")}`);
  const { deleteTestUploads } = await import("@/lib/adapters/youtube");
  const r = await deleteTestUploads(id, u.id);
  revalidatePath("/youtube");
  const msg = `Удалено тестовых роликов: ${r.deleted}${r.errors.length ? `, ошибок: ${r.errors.length} (${r.errors[0]})` : ""}`;
  redirect(`/youtube?${r.errors.length ? "err" : "ok"}=${encodeURIComponent(msg)}`);
}

export async function refreshStatsAction() {
  await requireUser();
  const { collectChannelStats } = await import("@/lib/adapters/youtube");
  await collectChannelStats();
  revalidatePath("/stats");
  redirect("/stats");
}

export async function saveHooksAction(f: FormData) {
  const u = await requireUser();
  let n = 0;
  for (const [k, v] of f.entries()) {
    if (!k.startsWith("hook_") || typeof v !== "string") continue;
    const id = k.slice(5);
    const hook = v.replace(/\s+/g, " ").trim().slice(0, 90) || null;
    const cur = await db.series.findUnique({ where: { id }, select: { hookTitle: true } });
    if (!cur || cur.hookTitle === hook) continue;
    await db.series.update({ where: { id }, data: { hookTitle: hook } });
    n++;
  }
  await audit("series.hooks.saved", "Series", null, u.id, { count: n });
  revalidatePath("/hooks");
  redirect(`/hooks?ok=${encodeURIComponent(`Сохранено: ${n}`)}`);
}

export async function saveFilmSettingsAction(f: FormData) {
  const u = await requireOwner();
  const cur = await getConveyorSettings();
  const slot = s(f, "filmSlot");
  if (!/^\d{1,2}:\d{2}$/.test(slot)) redirect("/films?err=" + encodeURIComponent("Время в формате 19:30"));
  const v = {
    ...cur,
    filmTestAccountId: s(f, "filmTestAccountId") || null,
    filmAccountIds: f.getAll("filmAccountIds").filter((x): x is string => typeof x === "string" && x !== ""),
    filmSlot: slot.padStart(5, "0"),
  };
  await saveConveyorSettings(v);
  await audit("settings.films", "Setting", "ytConveyor", u.id, { filmTestAccountId: v.filmTestAccountId, filmAccountIds: v.filmAccountIds, filmSlot: v.filmSlot });
  revalidatePath("/films");
  redirect("/films?ok=" + encodeURIComponent(v.filmAccountIds.length ? "Фильмы включены" : "Сохранено (фильмы выключены)"));
}

export async function retryFilmAction(f: FormData) {
  const u = await requireUser();
  const id = s(f, "id");
  await db.compilation.update({ where: { id }, data: { status: "QUEUED", note: "Повторная сборка", testJobId: null, mainJobId: null, accountId: null } });
  await audit("film.retry", "Compilation", id, u.id, {});
  revalidatePath("/films");
  redirect("/films?ok=" + encodeURIComponent("Поставлен на повторную сборку"));
}

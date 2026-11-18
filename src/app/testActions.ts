"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireOwner, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
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

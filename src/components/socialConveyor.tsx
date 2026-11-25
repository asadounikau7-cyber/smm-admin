import Link from "next/link";
import { DateTime } from "luxon";
import type { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { addTikTokAccountAction } from "@/app/actions";
import { GEOS, getConveyorSettings, isGeo } from "@/lib/conveyor";
import { Empty, Flash, PageHeader, StatusBadge } from "./ui";
import { SocialPlan } from "./socialPlan";

const LABEL: Record<"TIKTOK" | "INSTAGRAM", string> = { TIKTOK: "TikTok", INSTAGRAM: "Instagram" };

/**
 * TikTok / Instagram conveyor: which accounts take part, what each one posts today and tomorrow (the operator's
 * checklist), every account's line of series, and how many passed series are still free for this platform.
 */
export async function SocialConveyor({ platform, ok, err }: { platform: "TIKTOK" | "INSTAGRAM"; ok?: string; err?: string }) {
  const label = LABEL[platform];
  const s = await getConveyorSettings();
  const accounts = await db.socialAccount.findMany({ where: { platform: platform as Platform }, include: { octoProfile: { select: { title: true } } }, orderBy: { createdAt: "asc" } });
  const live = accounts.filter((a) => a.role === "MAIN" && a.status === "ACTIVE" && isGeo(a.geo));
  const profiles = await db.octoProfile.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } });
  const items = await db.channelQueueItem.findMany({
    where: { accountId: { in: accounts.map((a) => a.id) } },
    include: { series: { select: { id: true, title: true } } },
    orderBy: { position: "asc" },
  });
  const jobs = new Map((await db.publicationJob.findMany({ where: { id: { in: items.flatMap((i) => (i.jobId ? [i.jobId] : [])) } } })).map((j) => [j.id, j]));
  const eps = new Map((await db.episode.findMany({ where: { id: { in: items.map((i) => i.episodeId) } }, select: { id: true, number: true } })).map((e) => [e.id, e.number]));
  const taken = new Set(items.map((i) => i.seriesId));
  const passed = await db.series.count({ where: { stage: "IN_WORK", bannedAt: null } });
  const free = await db.series.count({ where: { stage: "IN_WORK", bannedAt: null, id: { notIn: [...taken] } } });
  const week = new Date(Date.now() - 7 * 86400_000);
  const stats = await db.publicationJob.groupBy({ by: ["status"], where: { platform: platform as Platform, scheduledAt: { gte: week, lte: new Date() } }, _count: true });
  const c = Object.fromEntries(stats.map((x) => [x.status, x._count])) as Record<string, number>;
  const fmt = (d: Date, tz: string) => DateTime.fromJSDate(d, { zone: tz }).setLocale("ru").toFormat("ccc d LLL, HH:mm");

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title={`${label}-конвейер`}>
        <Link href="/settings" className="btn">Слоты в настройках</Link>
      </PageHeader>
      <Flash msg={ok} />
      <Flash msg={err} kind="err" />

      <div className="card p-4 text-sm">
        {label} получает только сериалы, <b>прошедшие тест на YouTube</b>: каждый сериал — на один аккаунт {label}, без повторов, первые {s.mainEpisodes} серии подряд. Слоты{" "}
        <b>{s.socialSlots.join(", ") || "не заданы"}</b> по местному времени гео аккаунта, план на 3 дня вперёд. Режим «вручную»: админка готовит видео и подпись, исполнитель выкладывает из профиля Octo и отмечает здесь.
        <div className="mt-2 flex flex-wrap gap-4 text-xs muted">
          <span>Прошли тест YouTube: {passed}</span>
          <span>Ещё не отданы в {label}: {free}</span>
          <span>За 7 дней: выложено {c.PUBLISHED ?? 0}, запланировано {c.MANUALLY_SCHEDULED ?? 0}, просрочено {c.ACTION_REQUIRED ?? 0}</span>
        </div>
      </div>

      <SocialPlan platform={platform} title={`${label}: что выложить сегодня и завтра`} />

      <section>
        <h2 className="mb-2 font-medium">Аккаунты {label}</h2>
        {accounts.length === 0 ? (
          <Empty>Аккаунтов {label} пока нет. Добавьте их формой ниже — план появится в течение пары минут.</Empty>
        ) : (
          <div className="card scroll-x">
            <table className="tbl">
              <thead><tr><th>Аккаунт</th><th>Гео</th><th>Режим</th><th>Профиль Octo</th><th className="text-center">В очереди серий</th><th>Статус</th></tr></thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td className="font-medium">@{a.handle}</td>
                    <td>{isGeo(a.geo) ? a.geo : <span className="text-amber-600">не задано</span>}</td>
                    <td>{a.tiktokMode === "PARTNER" ? "Upload-Post (авто)" : "вручную"}</td>
                    <td className="muted">{a.octoProfile?.title ?? "—"}</td>
                    <td className="text-center">{items.filter((i) => i.accountId === a.id && !["PUBLISHED", "CANCELLED", "MANUALLY_SCHEDULED"].includes(jobs.get(i.jobId ?? "")?.status ?? "")).length}</td>
                    <td>{a.status === "ACTIVE" ? (a.role === "MAIN" && isGeo(a.geo) ? "в конвейере" : "вне конвейера") : <span className="text-red-600">{a.status}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-1 text-xs muted">Гео, язык и отключение — на странице <Link className="underline" href="/accounts">«Аккаунты»</Link>.</p>
      </section>

      <form action={addTikTokAccountAction} className="card grid gap-3 p-4 md:grid-cols-6 md:items-end">
        <input type="hidden" name="platform" value={platform} />
        <input type="hidden" name="back" value={platform === "TIKTOK" ? "/tiktok" : "/instagram"} />
        <input type="hidden" name="mode" value="MANUAL" />
        <div className="md:col-span-2"><label className="label">Добавить аккаунт {label}</label><input name="handle" required className="input" placeholder="@account" /></div>
        <div>
          <label className="label">Гео</label>
          <select name="geo" className="input" defaultValue="US"><option value="US">US</option><option value="UK">UK</option></select>
        </div>
        <div className="md:col-span-2">
          <label className="label">Профиль Octo</label>
          <select name="octoProfileId" className="input" defaultValue="">
            <option value="">—</option>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        </div>
        <button className="btn btn-primary">Добавить</button>
      </form>

      <section>
        <h2 className="mb-2 font-medium">Очереди сериалов по аккаунтам</h2>
        {live.length === 0 ? (
          <Empty>Нет аккаунтов {label} в конвейере (нужны гео и статус «активен»).</Empty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {live.map((a) => {
              const tz = GEOS[a.geo as keyof typeof GEOS].tz;
              const open = items.filter((i) => i.accountId === a.id && !["PUBLISHED", "CANCELLED"].includes(jobs.get(i.jobId ?? "")?.status ?? ""));
              return (
                <div key={a.id} className="card p-4 text-sm">
                  <div className="mb-2 font-medium">@{a.handle} <span className="text-xs muted">{a.geo} · {open.length} серий впереди</span></div>
                  {open.length === 0 ? (
                    <div className="text-xs muted">Очередь пуста: новые сериалы придут после прохождения теста на YouTube.</div>
                  ) : (
                    <ul className="space-y-1">
                      {open.slice(0, 12).map((i) => {
                        const j = i.jobId ? jobs.get(i.jobId) : null;
                        return (
                          <li key={i.id} className="flex flex-wrap items-center gap-2">
                            <span className="w-32 whitespace-nowrap muted">{j ? fmt(j.scheduledAt, tz) : "ждёт слота"}</span>
                            <span className="min-w-0 flex-1 truncate">{i.series.title} · серия {eps.get(i.episodeId) ?? "?"}</span>
                            {j && <Link href={`/publications/${j.id}`}><StatusBadge status={j.status} /></Link>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

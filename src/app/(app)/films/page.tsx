import Link from "next/link";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { getConveyorSettings } from "@/lib/conveyor";
import { clock } from "@/lib/films";
import { retryFilmAction, saveFilmSettingsAction } from "@/app/testActions";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = {
  QUEUED: "ждёт сборки",
  BUILDING: "собирается",
  READY: "собран",
  TESTING: "в закрытом тесте",
  PASSED: "прошёл тест, ждёт слота",
  FAILED: "не прошёл",
  SCHEDULED: "запланирован",
  PUBLISHED: "опубликован",
};

/** Films: whole series as one long video, for series whose episodes don't fit Shorts. */
export default async function FilmsPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const sp = await searchParams;
  const s = await getConveyorSettings();
  const channels = await db.socialAccount.findMany({ where: { platform: "YOUTUBE", status: "ACTIVE" }, orderBy: [{ role: "asc" }, { handle: "asc" }] });
  const films = await db.compilation.findMany({ orderBy: { updatedAt: "desc" }, take: 100, include: { series: { select: { id: true, title: true, hookTitle: true } } } });
  const jobIds = films.flatMap((f) => [f.testJobId, f.mainJobId]).filter(Boolean) as string[];
  const jobs = new Map((await db.publicationJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, externalUrl: true, scheduledAt: true, status: true } })).map((j) => [j.id, j]));
  const waiting = await db.series.count({ where: { stage: "IN_WORK", bannedAt: null, mainSkip: { not: null }, compilation: null } });
  const on = s.filmAccountIds.length > 0;

  // Plan: what is already scheduled, then the films on their way, then series waiting for a film.
  // Each film channel takes one a day, so the rest get an estimated day in order.
  const filmChannels = channels.filter((c) => s.filmAccountIds.includes(c.id));
  const ORDER = ["PASSED", "TESTING", "READY", "BUILDING", "QUEUED"];
  const pipeline = films.filter((f) => ORDER.includes(f.status)).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.createdAt.getTime() - b.createdAt.getTime());
  const scheduled = films
    .filter((f) => f.status === "SCHEDULED" && f.mainJobId && jobs.get(f.mainJobId))
    .sort((a, b) => jobs.get(a.mainJobId!)!.scheduledAt.getTime() - jobs.get(b.mainJobId!)!.scheduledAt.getTime());
  const waitingSeries = await db.series.findMany({
    where: { stage: "IN_WORK", bannedAt: null, mainSkip: { not: null }, compilation: null },
    orderBy: { inWorkAt: "asc" },
    take: 30,
    select: { id: true, title: true, mainSkip: true },
  });
  const tzBase = "America/Winnipeg";
  const day0 = new Date();
  const busyToday = new Set(scheduled.filter((f) => jobs.get(f.mainJobId!)!.scheduledAt.toDateString() === day0.toDateString()).map((f) => f.accountId));
  const freeToday = Math.max(0, filmChannels.length - busyToday.size);
  const estimate = (k: number) => {
    if (!filmChannels.length) return "—";
    const n = filmChannels.length;
    const dayIdx = k < freeToday ? 0 : 1 + Math.floor((k - freeToday) / n);
    return new Date(day0.getTime() + dayIdx * 86400_000).toLocaleDateString("ru-RU", { timeZone: tzBase, weekday: "short", day: "numeric", month: "short" });
  };
  const plan = [
    ...scheduled.map((f) => {
      const j = jobs.get(f.mainJobId!)!;
      const ch = channels.find((c) => c.id === f.accountId);
      return { key: f.id, title: f.series.title, seriesId: f.series.id, when: j.scheduledAt.toLocaleString("ru-RU", { timeZone: tzBase, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }), exact: true, where: ch ? `@${ch.handle}` : "—", state: STATUS[f.status] };
    }),
    ...[...pipeline.map((f) => ({ id: f.id, title: f.series.title, seriesId: f.series.id, state: STATUS[f.status], where: channels.find((c) => c.id === f.accountId) })), ...waitingSeries.map((x) => ({ id: x.id, title: x.title, seriesId: x.id, state: "ждёт очереди на сборку", where: undefined }))].map(
      (x, k) => ({ key: x.id, title: x.title, seriesId: x.seriesId, when: `≈ ${estimate(k)}`, exact: false, where: x.where ? `@${x.where.handle}` : filmChannels.length ? `@${filmChannels[k % filmChannels.length].handle}` : "—", state: x.state }),
    ),
  ];

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="Фильмы" />
      {sp.ok && <div className="card p-3 text-sm">{sp.ok}</div>}
      {sp.err && <div className="card border-red-400 p-3 text-sm text-red-600">{sp.err}</div>}
      <p className="text-xs muted">
        Сериалы, у которых серии длиннее 3 минут (в Shorts не попадают), собираются в один ролик из всех серий с главами в описании,
        проходят закрытый тест на Content ID и выходят обычным видео, один фильм в день на канал. Ролики длиннее 15 минут YouTube
        принимает только на каналах, подтверждённых по телефону. Ждут сборки: {waiting}.
      </p>

      <form action={saveFilmSettingsAction} className="card space-y-3 p-4 text-sm">
        <div className="font-medium">{on ? <span className="text-green-600">Включено</span> : <span className="text-amber-600">Выключено</span>}: отметьте каналы для фильмов</div>
        <label className="block">Тестовый канал (закрытая проверка)
          <select name="filmTestAccountId" defaultValue={s.filmTestAccountId ?? ""} className="input ml-2">
            <option value="">— нет: тест закрыто на самом канале фильмов —</option>
            {channels.filter((c) => c.role === "TEST").map((c) => <option key={c.id} value={c.id}>@{c.handle}</option>)}
          </select>
        </label>
        <div>Каналы для фильмов:
          <div className="mt-1 flex flex-wrap gap-3">
            {channels.filter((c) => c.role === "MAIN").map((c) => (
              <label key={c.id} className="flex items-center gap-1"><input type="checkbox" name="filmAccountIds" value={c.id} defaultChecked={s.filmAccountIds.includes(c.id)} /> @{c.handle}</label>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2"><input type="checkbox" name="filmAsap" defaultChecked={s.filmAsap} /> Выпускать сразу после теста (до одного фильма в день на канал)</label>
        <label className="block">Иначе время выхода (местное для гео канала) <input name="filmSlot" defaultValue={s.filmSlot} className="input ml-2 w-24" /></label>
        <button className="btn btn-primary">Сохранить</button>
      </form>

      <section>
        <h2 className="mb-1 font-medium">План выхода</h2>
        <p className="mb-2 text-xs muted">
          {filmChannels.length
            ? `Каналы фильмов: ${filmChannels.map((c) => "@" + c.handle).join(", ")} — по одному фильму в день на канал. Точное время — у запланированных; у остальных ориентировочный день по очереди.`
            : "Каналы для фильмов не выбраны — план не строится."}
        </p>
        {plan.length === 0 ? (
          <div className="card p-4 text-sm muted">Нечего планировать: нет сериалов с длинными сериями, прошедших тест.</div>
        ) : (
          <div className="card scroll-x">
            <table className="tbl num">
              <thead><tr><th className="c">#</th><th>Сериал</th><th className="c">Канал</th><th className="c">Выход</th><th>Сейчас</th></tr></thead>
              <tbody>
                {plan.map((p, i) => (
                  <tr key={p.key}>
                    <td className="c muted">{i + 1}</td>
                    <td className="font-medium"><Link className="hover:underline" href={`/catalog?series=${p.seriesId}`}>{p.title}</Link></td>
                    <td className="c">{p.where}</td>
                    <td className={`c whitespace-nowrap ${p.exact ? "font-medium" : "muted"}`}>{p.when}</td>
                    <td className="text-sm">{p.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-medium">Все фильмы</h2>
        {films.length === 0 ? (
          <div className="card p-4 text-sm muted">Пока нет. Появятся, когда сериал с длинными сериями пройдёт тест первой серии.</div>
        ) : (
          <div className="card scroll-x">
            <table className="tbl">
              <thead><tr><th>Сериал</th><th>Статус</th><th>Серий</th><th>Длина</th><th>Тест</th><th>Выход</th><th>Заметка</th><th></th></tr></thead>
              <tbody>
                {films.map((f) => {
                  const t = f.testJobId ? jobs.get(f.testJobId) : null;
                  const m = f.mainJobId ? jobs.get(f.mainJobId) : null;
                  return (
                    <tr key={f.id}>
                      <td><Link className="underline" href={`/catalog?series=${f.series.id}`}>{f.series.title}</Link></td>
                      <td className={f.status === "FAILED" ? "text-red-600" : f.status === "PUBLISHED" ? "text-green-600" : ""}>{STATUS[f.status]}</td>
                      <td>{f.episodes || "—"}</td>
                      <td>{f.durationSec ? clock(f.durationSec) : "—"}</td>
                      <td>{t ? <Link className="underline" href={`/publications/${t.id}`}>{t.status === "PUBLISHED" ? "загружен" : t.status.toLowerCase()}</Link> : "—"}</td>
                      <td>{m ? <Link className="underline" href={`/publications/${m.id}`}>{m.scheduledAt.toLocaleString("ru-RU", { timeZone: "America/Winnipeg", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</Link> : "—"}</td>
                      <td className="max-w-xs text-xs muted">{f.note}</td>
                      <td>
                        {f.status === "FAILED" && (
                          <form action={retryFilmAction}><input type="hidden" name="id" value={f.id} /><button className="btn text-xs">Собрать заново</button></form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

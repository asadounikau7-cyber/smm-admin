import Link from "next/link";
import { DateTime } from "luxon";
import { db } from "@/lib/db";
import { Empty, PageHeader, StatusBadge } from "@/components/ui";
import { backlogDays, GEOS, getConveyorSettings, isGeo, testTimes } from "@/lib/conveyor";
import { queueSeriesTestAction } from "@/app/testActions";
import { studioEditUrl } from "@/lib/adapters/youtube";

export const dynamic = "force-dynamic";

export default async function YouTubeConveyorPage() {
  const s = await getConveyorSettings();
  const channels = await db.socialAccount.findMany({ where: { platform: "YOUTUBE" }, include: { octoProfile: { select: { title: true } } }, orderBy: [{ role: "asc" }, { geo: "asc" }, { createdAt: "asc" }] });
  const tests = channels.filter((c) => c.role === "TEST" && isGeo(c.geo) && c.status === "ACTIVE");
  const mains = channels.filter((c) => c.role === "MAIN" && isGeo(c.geo) && c.status === "ACTIVE");
  const since = new Date(Date.now() - 24 * 3600_000);
  const testJobs = await db.publicationJob.findMany({
    where: { accountId: { in: tests.map((t) => t.id) }, meta: { path: ["purpose"], equals: "test" }, scheduledAt: { gte: since } },
    orderBy: { scheduledAt: "asc" },
  });
  const seriesIds = [...new Set(testJobs.map((j) => (j.meta as { seriesId?: string }).seriesId).filter(Boolean))] as string[];
  const seriesById = new Map((await db.series.findMany({ where: { id: { in: seriesIds } } })).map((x) => [x.id, x]));
  const queued = await db.series.findMany({ where: { testQueuedAt: { not: null }, stage: { not: "TESTING" } }, orderBy: { testQueuedAt: "asc" }, take: 50 });
  const items = await db.channelQueueItem.findMany({
    where: { accountId: { in: mains.map((m) => m.id) } },
    include: { series: { select: { title: true } } },
    orderBy: { position: "asc" },
  });
  const jobs = new Map(
    (await db.publicationJob.findMany({ where: { id: { in: items.map((i) => i.jobId).filter(Boolean) as string[] } } })).map((j) => [j.id, j]),
  );
  const eps = new Map((await db.episode.findMany({ where: { id: { in: items.map((i) => i.episodeId) } } })).map((e) => [e.id, e]));
  const backlog = Object.fromEntries(await Promise.all((Object.keys(GEOS) as (keyof typeof GEOS)[]).map(async (g) => [g, await backlogDays(g, s)] as const)));
  const fmt = (d: Date, tz: string) => DateTime.fromJSDate(d, { zone: tz }).setLocale("ru").toFormat("ccc d LLL, HH:mm");

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="YouTube-конвейер">
        <Link href="/settings" className="btn">Настройки</Link>
      </PageHeader>

      <div className={`card p-4 text-sm ${s.enabled ? "" : "border-amber-400"}`}>
        {s.enabled ? (
          <span>Конвейер <b className="text-green-600">включён</b>: {s.testSlots.length} теста в день на тестовый канал ({s.testSlots.join(", ")}), на боевых слоты {s.mainSlots.join(", ")}, первые {s.mainEpisodes} серии. Время местное для гео канала.</span>
        ) : (
          <span>Конвейер <b className="text-amber-600">выключен</b>. Разметьте каналы (гео и роль) в «Аккаунтах» и включите его в <Link className="underline" href="/settings">Настройках</Link>.</span>
        )}
      </div>

      <section>
        <h2 className="mb-2 font-medium">Каналы</h2>
        <div className="card scroll-x">
          <table className="tbl">
            <thead><tr><th>Канал</th><th>Гео</th><th>Роль</th><th>Профиль Octo</th><th>Статус</th></tr></thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.id}>
                  <td>@{c.handle}</td>
                  <td>{isGeo(c.geo) ? `${c.geo} · ${GEOS[c.geo].tz}` : <span className="text-amber-600">не задано</span>}</td>
                  <td>{c.role === "TEST" ? "Тестовый" : "Боевой"}</td>
                  <td className="muted">{c.octoProfile?.title ?? "—"}</td>
                  <td>{c.status === "ACTIVE" ? "активен" : <span className="text-red-600">{c.status}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs muted">Гео и роль меняются на странице <Link className="underline" href="/accounts">«Аккаунты»</Link>. Каналы без гео в конвейере не участвуют.</p>
      </section>

      <section>
        <h2 className="mb-2 font-medium">Тесты</h2>
        {tests.length === 0 ? (
          <Empty>Нет тестовых каналов с гео. Отметьте их в «Аккаунтах».</Empty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {tests.map((t) => {
              const tz = GEOS[t.geo as keyof typeof GEOS].tz;
              const idx = tests.filter((x) => x.geo === t.geo).findIndex((x) => x.id === t.id);
              const today = DateTime.now().setZone(tz).startOf("day");
              const planned = testTimes(t, idx, today, s, tz);
              const mine = testJobs.filter((j) => j.accountId === t.id);
              return (
                <div key={t.id} className="card p-4 text-sm">
                  <div className="mb-2 font-medium">@{t.handle} <span className="muted text-xs">{t.geo} · сегодня слоты {planned.map((p) => DateTime.fromJSDate(p.at, { zone: tz }).toFormat("HH:mm")).join(", ")}</span></div>
                  {mine.length === 0 ? (
                    <div className="muted text-xs">Пока ничего не поставлено{s.enabled ? "" : " (конвейер выключен)"}.</div>
                  ) : (
                    <ul className="space-y-1">
                      {mine.map((j) => {
                        const ser = seriesById.get((j.meta as { seriesId?: string }).seriesId ?? "");
                        return (
                          <li key={j.id} className="flex flex-wrap items-center gap-2">
                            <span className="muted whitespace-nowrap">{fmt(j.scheduledAt, tz)}</span>
                            <Link className="underline" href={`/catalog?series=${ser?.id}`}>{ser?.title ?? "?"}</Link>
                            <StatusBadge status={j.status} />
                            {ser && <span className="text-xs muted">{ser.stage === "IN_WORK" ? "прошёл" : ser.stage === "TEST_FAILED" ? "не прошёл" : ser.testNote}</span>}
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

      <section>
        <h2 className="mb-2 font-medium">Очередь на тест: {queued.length}</h2>
        {queued.length === 0 ? (
          <Empty>{s.autoPick ? "Пусто: конвейер берёт следующие непроверенные сериалы из каталога." : "Пусто. Добавьте сериалы кнопкой «В очередь на тест» в каталоге или включите автоподбор в настройках."}</Empty>
        ) : (
          <div className="card divide-y" style={{ borderColor: "var(--border)" }}>
            {queued.map((q, i) => (
              <div key={q.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="muted w-6">{i + 1}</span>
                <Link className="flex-1 underline" href={`/catalog?series=${q.id}`}>{q.title}</Link>
                <form action={queueSeriesTestAction}>
                  <input type="hidden" name="id" value={q.id} /><input type="hidden" name="on" value="0" /><input type="hidden" name="back" value="/youtube" />
                  <button className="btn btn-sm">Убрать</button>
                </form>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-medium">Боевые каналы</h2>
        {mains.length === 0 ? (
          <Empty>Нет боевых каналов с гео.</Empty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {mains.map((m) => {
              const tz = GEOS[m.geo as keyof typeof GEOS].tz;
              const mine = items.filter((i) => i.accountId === m.id);
              const open = mine.filter((i) => !i.jobId || !["PUBLISHED", "CANCELLED"].includes(jobs.get(i.jobId)?.status ?? ""));
              const b = backlog[m.geo as string];
              return (
                <div key={m.id} className="card p-4 text-sm">
                  <div className="mb-2 font-medium">@{m.handle} <span className="muted text-xs">{m.geo} · ждут {mine.filter((i) => !i.jobId).length} серий{Number.isFinite(b) ? `, очередь гео ≈ ${b.toFixed(1)} дн.` : ""}</span></div>
                  {open.length === 0 ? (
                    <div className="muted text-xs">Очередь пуста.</div>
                  ) : (
                    <ul className="space-y-1">
                      {open.slice(0, 15).map((i) => {
                        const j = i.jobId ? jobs.get(i.jobId) : null;
                        const ep = eps.get(i.episodeId);
                        const manual = j && (j.meta as any)?.adapter?.manualOpen;
                        return (
                          <li key={i.id} className="flex flex-wrap items-center gap-2">
                            <span className="muted whitespace-nowrap">{j ? fmt(j.scheduledAt, tz) : "ждёт слота"}</span>
                            <span>{i.series.title} · S{ep?.season}E{ep?.number}</span>
                            {j && <Link href={`/publications/${j.id}`}><StatusBadge status={j.status} /></Link>}
                            {manual && j?.externalId && <a className="btn btn-sm btn-primary" target="_blank" href={studioEditUrl(j.externalId)}>Открыть в Studio</a>}
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

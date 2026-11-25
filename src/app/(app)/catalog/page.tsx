import Link from "next/link";
import { db } from "@/lib/db";
import { catalogConfigured } from "@/lib/env";
import { Empty, Flash, PageHeader, Tabs, fmtDur, fmtSize } from "@/components/ui";
import { getYtTestSettings } from "@/lib/seriesTest";
import { SeriesTestCard } from "@/components/seriesTest";
import { ManualUploads } from "@/components/manualUploads";
import { setSeriesBanAction, syncNowAction, toggleSeriesActiveAction, updateAssetAction, updateSeriesAction, updateEpisodeTitleAction } from "@/app/actions";

const KIND_LABEL: Record<string, string> = { FULL_EPISODE: "Полная серия", VERTICAL: "Вертикальная", TEASER: "Анонс", COVER: "Обложка", SUBTITLES: "Субтитры" };

type SP = Promise<{ q?: string; series?: string; ok?: string; err?: string; unmapped?: string; tab?: string }>;

const STAGE_TAB: Record<string, "IN_WORK" | "TESTING" | "TEST_FAILED"> = { work: "IN_WORK", testing: "TESTING", failed: "TEST_FAILED" };

export default async function CatalogPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = sp.q?.trim();
  const tab = sp.tab && STAGE_TAB[sp.tab] ? sp.tab : "all";
  const stageCounts = Object.fromEntries((await db.series.groupBy({ by: ["stage"], _count: true })).map((x) => [x.stage, x._count])) as Record<string, number>;
  const bannedCount = await db.series.count({ where: { bannedAt: { not: null } } });
  const tabSeries =
    tab === "all"
      ? []
      : await db.series.findMany({
          where: { stage: STAGE_TAB[tab], ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}) },
          orderBy: tab === "work" ? [{ inWorkAt: { sort: "desc", nulls: "last" } }] : [{ testCheckedAt: { sort: "desc", nulls: "last" } }, { title: "asc" }],
          take: 500,
        });
  const series = await db.series.findMany({
    where: q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { slug: { contains: q } }] } : undefined,
    orderBy: [{ active: "desc" }, { title: "asc" }],
    include: { _count: { select: { assets: true, episodes: true } } },
    take: 60,
  });
  const total = await db.series.count();
  const unmapped = await db.asset.findMany({ where: { needsMapping: true, deletedAt: null }, take: 50, orderBy: { createdAt: "desc" } });
  const selected = sp.series
    ? await db.series.findUnique({
        where: { id: sp.series },
        include: {
          episodes: { orderBy: [{ season: "asc" }, { number: "asc" }], include: { assets: { where: { renderOfId: null }, include: { versions: { where: { isCurrent: true } } } } } },
          assets: { where: { episodeId: null }, include: { versions: { where: { isCurrent: true } } } },
        },
      })
    : null;
  const ytAccounts = selected
    ? await db.socialAccount.findMany({ where: { platform: "YOUTUBE" }, include: { octoProfile: { select: { title: true } } }, orderBy: { handle: "asc" } })
    : [];
  const testJobs = selected
    ? await db.publicationJob.findMany({ where: { id: { in: [selected.testJobId, selected.launchJobId].filter((x): x is string => Boolean(x)) } }, include: { account: true } })
    : [];
  const ytTest = await getYtTestSettings();
  const allSeries = unmapped.length ? await db.series.findMany({ select: { id: true, title: true }, orderBy: { title: "asc" } }) : [];

  return (
    <div>
      <PageHeader title="Каталог">
        <form action={syncNowAction}><button className="btn" disabled={!catalogConfigured()}>Обновить из B2</button></form>
      </PageHeader>
      <Flash msg={sp.ok} />
      <Flash msg={sp.err} kind="err" />
      {!catalogConfigured() && <Flash kind="err" msg="Источник каталога не настроен: укажите B2_REGISTRY_URL (публичный каталог) или ключ B2 в .env." />}
      <Tabs
        active={tab}
        items={[
          { key: "all", label: "Все сериалы", href: "/catalog", count: total },
          { key: "work", label: "В работе", href: "/catalog?tab=work", count: stageCounts.IN_WORK ?? 0 },
          { key: "testing", label: "На тесте", href: "/catalog?tab=testing", count: stageCounts.TESTING ?? 0 },
          { key: "failed", label: "Не прошли", href: "/catalog?tab=failed", count: stageCounts.TEST_FAILED ?? 0 },
        ]}
      />
      {tab !== "all" && (
        <section>
          <form className="mb-2 max-w-sm"><input type="hidden" name="tab" value={tab} /><input name="q" defaultValue={q} placeholder="Поиск по названию" className="input" /></form>
          {tabSeries.length === 0 ? (
            <Empty>Здесь пока пусто.</Empty>
          ) : (
            <div className="card scroll-x">
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="w-10 text-center">#</th>
                    <th>Сериал</th>
                    <th className="whitespace-nowrap">{tab === "work" ? "В работе с" : "Проверен"}</th>
                    <th>{tab === "failed" ? "Почему не прошёл" : tab === "work" ? "Заметка" : "Состояние теста"}</th>
                  </tr>
                </thead>
                <tbody>
                  {tabSeries.map((x, i) => (
                    <tr key={x.id}>
                      <td className="text-center muted">{i + 1}</td>
                      <td className="font-medium"><Link className="hover:underline" href={`/catalog?series=${x.id}`}>{x.title}</Link>{x.bannedAt && <span className="ml-2 text-xs text-red-600">INACTIVE</span>}</td>
                      <td className="whitespace-nowrap muted">{(() => {
                        const d = tab === "work" ? x.inWorkAt : (x.testCheckedAt ?? x.testLiveAt);
                        return d ? d.toLocaleString("ru-RU", { timeZone: "America/Winnipeg", dateStyle: "short", timeStyle: "short" }) : "—";
                      })()}</td>
                      <td className="text-sm">{x.mainSkip ? `Не на боевых: ${x.mainSkip}` : x.testNote ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tab === "failed" && bannedCount > 0 && <p className="mt-2 text-xs muted">Ещё {bannedCount} сериалов помечены INACTIVE (забанены вручную) — они видны во вкладке «Все сериалы» красным.</p>}
        </section>
      )}
      {tab === "all" && (<>

      {unmapped.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 font-medium">Нужно разметить ({unmapped.length})</h2>
          <div className="space-y-2">
            {unmapped.map((a) => (
              <form key={a.id} action={updateAssetAction} className="card grid grid-cols-2 gap-2 p-3 md:grid-cols-8 md:items-end">
                <input type="hidden" name="id" value={a.id} />
                <div className="col-span-2 md:col-span-2 break-all text-xs">{a.objectKey}</div>
                <div className="col-span-2 md:col-span-1">
                  <label className="label">Сериал</label>
                  <select name="seriesId" defaultValue={a.seriesId ?? ""} className="input">
                    <option value="">—</option>
                    {allSeries.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                  </select>
                  <input name="newSeries" placeholder="или новый" className="input mt-1" />
                </div>
                <div><label className="label">Сезон</label><input name="season" type="number" className="input" defaultValue={1} /></div>
                <div><label className="label">Эпизод</label><input name="episode" type="number" className="input" /></div>
                <div>
                  <label className="label">Тип</label>
                  <select name="kind" defaultValue={a.kind ?? ""} className="input">
                    <option value="">—</option>
                    {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div><label className="label">Язык</label><input name="language" defaultValue={a.language ?? ""} placeholder="en" className="input" /></div>
                <button className="btn btn-primary">Сохранить</button>
              </form>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        <section>
          <form className="mb-2"><input name="q" defaultValue={q} placeholder={`Поиск среди ${total} сериалов`} className="input" /></form>
          {series.length === 0 ? (
            <Empty>Пока нет сериалов. Нажмите «Обновить из B2».</Empty>
          ) : (
            <div className="card divide-y" style={{ borderColor: "var(--border)" }}>
              {series.map((s) => (
                <div key={s.id} className={`flex items-center gap-2 px-3 py-2 text-sm ${sp.series === s.id ? "font-medium" : ""}`}>
                  <Link
                    href={`/catalog?series=${s.id}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                    className={`flex-1 truncate hover:underline ${s.bannedAt ? "text-red-600" : ""}`}
                    title={s.bannedAt ? `Inactive (забанен)${s.banReason ? `: ${s.banReason}` : ""}` : undefined}
                  >
                    {s.title}
                  </Link>
                  {s.contentLang && s.contentLang !== "en" && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-semibold text-gray-700 dark:bg-gray-800 dark:text-gray-300" title="Язык контента: в автотест не берётся">{s.contentLang.toUpperCase()}</span>}
                  {s.stage === "TESTING" && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">ТЕСТ</span>}
                  {s.testQueuedAt && s.stage !== "TESTING" && <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs font-semibold text-sky-800 dark:bg-sky-950 dark:text-sky-300">В ОЧЕРЕДИ</span>}
                  {s.stage === "IN_WORK" && <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs font-semibold text-green-700 dark:bg-green-950 dark:text-green-300">В РАБОТЕ</span>}
                  {s.stage === "TEST_FAILED" && <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-950 dark:text-red-300" title={s.testNote ?? undefined}>НЕ ПРОШЁЛ</span>}
                  <span className="text-xs muted whitespace-nowrap">{s._count.assets}{s.expectedEpisodes ? `/${s.expectedEpisodes}` : ""}</span>
                  {s.bannedAt ? (
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-950 dark:text-red-300">INACTIVE</span>
                  ) : (
                    <form action={toggleSeriesActiveAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <button title="В работе" className={`text-xs ${s.active ? "text-green-600" : "muted"}`}>{s.active ? "● в работе" : "○"}</button>
                    </form>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          {!selected ? (
            <Empty>Выберите сериал слева. Отметка «в работе» поднимает сериал наверх списка и в правилах.</Empty>
          ) : (
            <div className="space-y-4">
              {selected.bannedAt ? (
                <form action={setSeriesBanAction} className="flex flex-wrap items-center gap-3 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                  <input type="hidden" name="id" value={selected.id} />
                  <input type="hidden" name="q" value={q ?? ""} />
                  <input type="hidden" name="ban" value="0" />
                  <span className="rounded bg-red-600 px-2 py-0.5 text-xs font-bold text-white">INACTIVE</span>
                  <span className="flex-1">
                    Забанен {selected.bannedAt.toLocaleDateString("ru-RU")}
                    {selected.banReason ? `: ${selected.banReason}` : ""}. Не попадает в план недели и новые версии.
                  </span>
                  <button className="btn btn-sm">Вернуть в активные</button>
                </form>
              ) : (
                <form action={setSeriesBanAction} className="card flex flex-wrap items-end gap-2 p-4">
                  <input type="hidden" name="id" value={selected.id} />
                  <input type="hidden" name="q" value={q ?? ""} />
                  <input type="hidden" name="ban" value="1" />
                  <div className="min-w-48 flex-1">
                    <label className="label">Причина (необязательно)</label>
                    <input name="reason" placeholder="например, бан на YouTube" className="input" />
                  </div>
                  <button className="btn btn-danger">Забанен → Inactive</button>
                </form>
              )}

              {!selected.bannedAt && (
                <SeriesTestCard
                  series={selected}
                  accounts={ytAccounts.map((a) => ({ id: a.id, label: `@${a.handle}${a.octoProfile ? ` · Octo «${a.octoProfile.title}»` : ""}${a.status !== "ACTIVE" ? " (не подключён)" : ""}` }))}
                  defaults={ytTest}
                  testJob={testJobs.find((j) => j.id === selected.testJobId) ?? null}
                  launchJob={testJobs.find((j) => j.id === selected.launchJobId) ?? null}
                />
              )}

              {selected.stage === "IN_WORK" && !selected.bannedAt && <ManualUploads series={selected} />}

              <form action={updateSeriesAction} className="card grid gap-3 p-4 md:grid-cols-2">
                <input type="hidden" name="id" value={selected.id} />
                <div className={`md:col-span-2 text-xs ${selected.bannedAt ? "font-semibold text-red-600" : "muted"}`}>ID {selected.slug}{selected.bannedAt ? " · INACTIVE" : ""}</div>
                <div><label className="label">Название</label><input name="title" defaultValue={selected.title} className="input" /></div>
                <div>
                  <label className="label">Язык контента</label>
                  <select name="contentLang" defaultValue={selected.contentLang ?? "en"} className="input">
                    <option value="en">Английский</option>
                    <option value="es">Испанский (в автотест не берётся)</option>
                  </select>
                </div>
                <div><label className="label">Хештеги по умолчанию</label><input name="hashtags" defaultValue={selected.hashtags ?? ""} placeholder="#drama #shortdrama" className="input" /></div>
                <div className="md:col-span-2"><label className="label">Название-завязка для YouTube</label><input name="hookTitle" defaultValue={selected.hookTitle ?? ""} maxLength={90} className="input" placeholder="She Was Sold to the Mafia King—Now He Won't Let Her Go!" /></div>
                <div className="md:col-span-2"><label className="label">Синопсис</label><textarea name="synopsis" defaultValue={selected.synopsis ?? ""} rows={2} className="input" /></div>
                <div><button className="btn">Сохранить сериал</button></div>
              </form>

              <div className="card scroll-x">
                <table className="tbl">
                  <thead>
                    <tr><th>Эпизод</th><th>Файл</th><th>Тип</th><th>Язык</th><th>Длит.</th><th>Кадр</th><th>Размер</th><th>Права</th></tr>
                  </thead>
                  <tbody>
                    {selected.episodes.flatMap((e) =>
                      e.assets.length === 0
                        ? [<tr key={e.id}><td>S{e.season}E{e.number}</td><td colSpan={7} className="text-red-600">нет файлов</td></tr>]
                        : e.assets.map((a, i) => {
                            const v = a.versions[0];
                            return (
                              <tr key={a.id} className={a.deletedAt ? "opacity-50" : ""}>
                                <td className="whitespace-nowrap">
                                  {i === 0 ? (
                                    <form action={updateEpisodeTitleAction} className="flex gap-1">
                                      <input type="hidden" name="id" value={e.id} />
                                      <span className="pt-1">S{e.season}E{e.number}</span>
                                      <input name="title" defaultValue={e.title ?? ""} placeholder="название" className="input w-32" />
                                    </form>
                                  ) : null}
                                </td>
                                <td className="max-w-[220px] truncate text-xs">
                                  {v ? <a className="hover:underline" target="_blank" href={`/api/media/${v.id}`}>{a.objectKey.split("/").pop()}</a> : a.objectKey}
                                  {a.deletedAt && <span className="ml-1 text-red-600">удалён</span>}
                                </td>
                                <td>{a.kind ? KIND_LABEL[a.kind] : "—"}</td>
                                <td>{a.language ?? "—"}</td>
                                <td>{v?.probeError ? <span className="text-red-600" title={v.probeError}>ошибка</span> : fmtDur(v?.durationSec)}</td>
                                <td className="whitespace-nowrap">{v?.width ? `${v.width}×${v.height}` : "—"}</td>
                                <td className="whitespace-nowrap">{fmtSize(v?.size)}</td>
                                <td>
                                  <form action={updateAssetAction}>
                                    <input type="hidden" name="id" value={a.id} />
                                    <input type="hidden" name="seriesId" value={a.seriesId ?? ""} />
                                    <input type="hidden" name="season" value={e.season} />
                                    <input type="hidden" name="episode" value={e.number} />
                                    <input type="hidden" name="kind" value={a.kind ?? ""} />
                                    <input type="hidden" name="language" value={a.language ?? ""} />
                                    <input type="hidden" name="variant" value={a.variant ?? ""} />
                                    {!a.rightsConfirmed && <input type="hidden" name="rightsConfirmed" value="on" />}
                                    <button className={`btn btn-sm ${a.rightsConfirmed ? "text-green-600" : ""}`}>{a.rightsConfirmed ? "✓ подтв." : "Подтвердить"}</button>
                                  </form>
                                </td>
                              </tr>
                            );
                          }),
                    )}
                    {selected.assets.map((a) => (
                      <tr key={a.id}>
                        <td className="muted">весь сериал</td>
                        <td className="max-w-[220px] truncate text-xs">{a.objectKey.split("/").pop()}</td>
                        <td>{a.kind ? KIND_LABEL[a.kind] : "—"}</td>
                        <td>{a.language ?? "—"}</td>
                        <td>{fmtDur(a.versions[0]?.durationSec)}</td>
                        <td>{a.versions[0]?.width ? `${a.versions[0].width}×${a.versions[0].height}` : "—"}</td>
                        <td>{fmtSize(a.versions[0]?.size)}</td>
                        <td>{a.rightsConfirmed ? "✓" : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      </div>
      </>)}
    </div>
  );
}

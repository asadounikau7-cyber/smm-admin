import Link from "next/link";
import type { Prisma, VariantStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { Empty, Flash, PageHeader, PlatformTag, fmtDur, fmtSize } from "@/components/ui";
import { VariantBadge, VARIANT_STATUS } from "@/components/variantStatus";
import { createVariantsAction, rerenderVariantAction, setRenderModeAction } from "@/app/variantActions";
import { agentRenderOnline, getRenderMode } from "@/lib/renderJobs";

type SP = { ok?: string; err?: string; series?: string; template?: string; account?: string; status?: string; view?: string };

export default async function VariantsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const [series, templates, accounts, mode, agentOn, counts] = await Promise.all([
    db.series.findMany({ where: { OR: [{ active: true }, { variants: { some: {} } }] }, orderBy: { title: "asc" }, include: { episodes: { orderBy: [{ season: "asc" }, { number: "asc" }] } } }),
    db.editTemplate.findMany({ orderBy: { createdAt: "desc" } }),
    db.socialAccount.findMany({ where: { status: { not: "DISABLED" } }, orderBy: [{ platform: "asc" }, { handle: "asc" }] }),
    getRenderMode(),
    agentRenderOnline(),
    db.videoVariant.groupBy({ by: ["status"], _count: true }),
  ]);
  const seriesId = sp.series ?? series[0]?.id ?? "";
  const cur = series.find((s) => s.id === seriesId);
  const count = (s: VariantStatus) => counts.find((c) => c.status === s)?._count ?? 0;
  const total = counts.reduce((a, c) => a + c._count, 0);

  const where: Prisma.VideoVariantWhereInput = {
    ...(seriesId ? { seriesId } : {}),
    ...(sp.account ? { accountId: sp.account === "none" ? null : sp.account } : {}),
    ...(sp.status ? { status: sp.status as VariantStatus } : {}),
  };
  const variants = await db.videoVariant.findMany({
    where,
    include: { episode: true, account: true, template: true, output: { include: { versions: { where: { isCurrent: true } } } } },
    orderBy: [{ episode: { season: "asc" } }, { episode: { number: "asc" } }, { number: "asc" }],
    take: 500,
  });
  const failedIds = variants.filter((v) => v.status === "FAILED").map((v) => v.id);

  // Matrix: account × episode → version code, so nothing gets lost.
  const matrixAccounts = accounts.filter((a) => variants.some((v) => v.accountId === a.id));
  const cell = new Map(variants.filter((v) => v.accountId).map((v) => [`${v.accountId}|${v.episodeId}`, v]));
  const showMatrix = sp.view === "matrix";

  return (
    <div className="max-w-6xl">
      <PageHeader title="Версии видео">
        <Link href="/templates" className="btn">Шаблоны</Link>
      </PageHeader>
      <Flash msg={sp.ok} />
      <Flash msg={sp.err} kind="err" />

      <div className="card mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-sm">
        <span>Всего: <b>{total}</b></span>
        {(["PENDING", "RENDERING", "READY", "FAILED"] as VariantStatus[]).map((s) => (
          <span key={s}>{VARIANT_STATUS[s]}: <b>{count(s)}</b></span>
        ))}
        <span className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${agentOn ? "bg-green-500" : "bg-gray-400"}`} />
          {agentOn ? "Компьютер собирает версии" : "Компьютер не подключён"}
        </span>
        <form action={setRenderModeAction} className="ml-auto flex items-center gap-2">
          <select name="mode" defaultValue={mode} className="input !w-auto">
            <option value="auto">Сборка: на компьютере, если он в сети, иначе на сервере</option>
            <option value="agent">Сборка: только на компьютере</option>
            <option value="server">Сборка: только на сервере</option>
          </select>
          <button className="btn btn-sm">OK</button>
        </form>
      </div>

      <details className="card mb-5 p-4" open={Boolean(sp.template) || total === 0}>
        <summary className="cursor-pointer font-medium">Создать версии</summary>
        {series.length === 0 ? (
          <p className="mt-3 text-sm muted">Сначала включите сериал в «Каталоге».</p>
        ) : (
          <form action={createVariantsAction} className="mt-3 grid gap-3 md:grid-cols-3">
            <label className="block">
              <span className="label">Шаблон</span>
              <select name="templateId" className="input" defaultValue={sp.template ?? templates[0]?.id ?? ""}>
                <option value="">Без шаблона (одна версия = оригинал, правите вручную)</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="label">Сериал</span>
              <select name="seriesId" className="input" defaultValue={seriesId}>
                {series.map((s) => <option key={s.id} value={s.id}>{s.title} ({s.episodes.length} сер.)</option>)}
              </select>
            </label>
            <label className="block">
              <span className="label">Серии (пусто = все; например 1-3, 5)</span>
              <input name="episodes" className="input" placeholder="все" />
            </label>
            <div className="md:col-span-3">
              <span className="label">Аккаунты: каждый получит свою версию каждой серии (у кого версия уже есть, пропускаются)</span>
              {accounts.length === 0 ? (
                <p className="text-sm muted">Аккаунтов пока нет. Можно сделать версии «в запас» и раздать позже.</p>
              ) : (
                <div className="grid max-h-56 gap-1 overflow-y-auto rounded-lg border p-2 text-sm sm:grid-cols-2 md:grid-cols-3" style={{ borderColor: "var(--border)" }}>
                  {accounts.map((a) => (
                    <label key={a.id} className="flex items-center gap-2">
                      <input type="checkbox" name="accountIds" value={a.id} /> <PlatformTag platform={a.platform} /> @{a.handle}
                      {a.language && <span className="text-xs muted">{a.language}</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <label className="block">
              <span className="label">Ещё версий в запас на серию (без аккаунта)</span>
              <input name="pool" type="number" min={0} max={200} defaultValue={accounts.length ? 0 : 1} className="input" />
            </label>
            <div className="flex items-end md:col-span-2">
              <button className="btn btn-primary">Создать и собрать</button>
              <span className="ml-3 text-xs muted">Минутная серия собирается на компьютере за 20–40 с, на сервере за 1–2 мин.</span>
            </div>
          </form>
        )}
      </details>

      <form className="mb-3 flex flex-wrap items-end gap-2 text-sm" method="get">
        <select name="series" defaultValue={seriesId} className="input !w-auto">
          {series.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
        <select name="account" defaultValue={sp.account ?? ""} className="input !w-auto">
          <option value="">Все аккаунты</option>
          <option value="none">Без аккаунта (запас)</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
        </select>
        <select name="status" defaultValue={sp.status ?? ""} className="input !w-auto">
          <option value="">Все статусы</option>
          {Object.entries(VARIANT_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select name="view" defaultValue={sp.view ?? ""} className="input !w-auto">
          <option value="">Списком</option>
          <option value="matrix">Таблица аккаунт × серия</option>
        </select>
        <button className="btn btn-sm">Показать</button>
        {failedIds.length > 0 && (
          <span className="ml-auto">
            <button formAction={rerenderVariantAction} formMethod="post" className="btn btn-sm" name="back" value={`/variants?series=${seriesId}`}>
              Пересобрать с ошибкой ({failedIds.length})
            </button>
            {failedIds.map((id) => <input key={id} type="hidden" name="id" value={id} />)}
          </span>
        )}
      </form>

      {variants.length === 0 ? (
        <Empty>Версий {cur ? `сериала «${cur.title}» ` : ""}пока нет.</Empty>
      ) : showMatrix && cur ? (
        <div className="card scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>Аккаунт</th>
                {cur.episodes.map((e) => <th key={e.id}>S{e.season}E{e.number}</th>)}
              </tr>
            </thead>
            <tbody>
              {matrixAccounts.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap"><PlatformTag platform={a.platform} /> @{a.handle}</td>
                  {cur.episodes.map((e) => {
                    const v = cell.get(`${a.id}|${e.id}`);
                    return (
                      <td key={e.id} className="whitespace-nowrap">
                        {v ? (
                          <Link href={`/variants/${v.id}`} className="text-xs underline" title={VARIANT_STATUS[v.status]}>
                            V{String(v.number).padStart(3, "0")} {v.status === "READY" ? "✓" : v.status === "FAILED" ? "✕" : "…"}
                          </Link>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>Код</th>
                <th>Серия</th>
                <th>Аккаунт</th>
                <th>Шаблон</th>
                <th>Статус</th>
                <th>Длит.</th>
                <th>Размер</th>
              </tr>
            </thead>
            <tbody>
              {variants.map((v) => {
                const out = v.output?.versions[0];
                return (
                  <tr key={v.id}>
                    <td className="whitespace-nowrap font-mono text-xs"><Link href={`/variants/${v.id}`} className="underline">{v.code}</Link></td>
                    <td>S{v.episode.season}E{v.episode.number}</td>
                    <td className="whitespace-nowrap">{v.account ? <><PlatformTag platform={v.account.platform} /> @{v.account.handle}</> : <span className="muted">запас</span>}</td>
                    <td className="text-xs">{v.template?.name ?? <span className="muted">вручную</span>}</td>
                    <td>
                      <VariantBadge status={v.status} />
                      {v.error && <div className="mt-1 max-w-xs text-xs text-red-600">{v.error.slice(0, 140)}</div>}
                    </td>
                    <td>{fmtDur(out?.durationSec)}</td>
                    <td>{fmtSize(out?.size)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

import Link from "next/link";
import { DateTime } from "luxon";
import type { JobStatus, Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { Empty, PageHeader, PlatformTag, STATUS_LABEL, StatusBadge, Tabs } from "@/components/ui";
import { FORMAT_LABEL } from "@/lib/validators";

const CITY: Record<string, string> = { "America/New_York": "Нью-Йорк", "Europe/London": "Лондон", "America/Winnipeg": "Виннипег" };

type SP = Promise<{ view?: string; status?: string; platform?: string; account?: string; kind?: string; job?: string }>;

const KIND: Record<string, { label: string; where: object }> = {
  main: { label: "боевые", where: { NOT: [{ meta: { path: ["purpose"], equals: "test" } }, { meta: { path: ["purpose"], equals: "film" } }] } },
  test: { label: "тесты", where: { meta: { path: ["purpose"], equals: "test" } } },
  film: { label: "фильмы", where: { meta: { path: ["purpose"], equals: "film" } } },
};

export default async function PublicationsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const tz = env().BASE_TIMEZONE;
  const past = sp.view === "past";
  const now = new Date();
  // Upcoming: nearest first. Past: latest first. Cancelled ones only when asked for.
  const edge = new Date(now.getTime() - 60 * 60_000);
  const jobs = await db.publicationJob.findMany({
    where: {
      status: sp.status ? (sp.status as JobStatus) : { notIn: ["DRAFT", "BLOCKED", "CANCELLED"] },
      platform: sp.platform ? (sp.platform as Platform) : undefined,
      accountId: sp.account || undefined,
      ...(sp.kind && KIND[sp.kind] ? KIND[sp.kind].where : {}),
      ...(sp.job ? { id: sp.job } : { scheduledAt: past ? { lt: edge } : { gte: edge } }),
    },
    include: { account: true, assetVersion: { include: { asset: { include: { series: true, episode: true } } } } },
    orderBy: { scheduledAt: past ? "desc" : "asc" },
    take: 400,
  });
  const accounts = await db.socialAccount.findMany({ orderBy: [{ platform: "asc" }, { handle: "asc" }] });
  const days = new Map<string, typeof jobs>();
  for (const j of jobs) {
    const d = DateTime.fromJSDate(j.scheduledAt, { zone: tz }).setLocale("ru").toFormat("cccc, d MMMM");
    days.set(d, [...(days.get(d) ?? []), j]);
  }
  const q = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ view: sp.view, status: sp.status, platform: sp.platform, account: sp.account, kind: sp.kind, ...over })) if (v) p.set(k, v);
    return `/publications?${p.toString()}`;
  };

  return (
    <div>
      <PageHeader title="Публикации" />
      <Tabs
        active={past ? "past" : "upcoming"}
        items={[
          { key: "upcoming", label: "Предстоящие", href: q({ view: undefined }) },
          { key: "past", label: "Прошедшие", href: q({ view: "past" }) },
        ]}
      />
      <div className="mb-3 flex flex-wrap gap-1.5 text-sm">
        <a href={q({ account: undefined })} className={`rounded-full px-3 py-1 ${!sp.account ? "font-medium" : "muted"}`} style={!sp.account ? { background: "var(--bg)" } : undefined}>все аккаунты</a>
        {accounts.map((a) => (
          <a key={a.id} href={q({ account: a.id })} className={`rounded-full px-3 py-1 ${sp.account === a.id ? "font-medium" : "muted"}`} style={sp.account === a.id ? { background: "var(--bg)" } : undefined}>
            @{a.handle}
          </a>
        ))}
      </div>
      <form className="card mb-4 grid grid-cols-2 gap-2 p-3 md:grid-cols-5 md:items-end">
        {past && <input type="hidden" name="view" value="past" />}
        {sp.account && <input type="hidden" name="account" value={sp.account} />}
        <div>
          <label className="label">Тип</label>
          <select name="kind" defaultValue={sp.kind ?? ""} className="input">
            <option value="">все</option>
            {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Площадка</label>
          <select name="platform" defaultValue={sp.platform ?? ""} className="input">
            <option value="">все</option><option value="YOUTUBE">YouTube</option><option value="TIKTOK">TikTok</option><option value="INSTAGRAM">Instagram</option>
          </select>
        </div>
        <div>
          <label className="label">Статус</label>
          <select name="status" defaultValue={sp.status ?? ""} className="input">
            <option value="">все, кроме отменённых</option>
            {Object.entries(STATUS_LABEL).filter(([k]) => !["DRAFT", "BLOCKED"].includes(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <button className="btn">Показать</button>
      </form>
      <p className="muted mb-3 text-xs">Время — по Виннипегу; у каналов в другом часовом поясе серым указано их местное время. Тест — это три серии сериала подряд на тестовом канале, поэтому сериал виден трижды.</p>

      {jobs.length === 0 ? (
        <Empty>{past ? "Прошедших публикаций с такими условиями нет." : "Предстоящих публикаций с такими условиями нет."}</Empty>
      ) : (
        <div className="space-y-4">
          {[...days.entries()].map(([day, list]) => (
            <section key={day}>
              <h2 className="mb-1 text-sm font-medium capitalize">{day}</h2>
              <div className="card divide-y" style={{ borderColor: "var(--border)" }}>
                {list.map((j) => {
                  const a = j.assetVersion?.asset;
                  return (
                    <Link key={j.id} href={`/publications/${j.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm hover:opacity-80">
                      <span className="w-12 font-mono">{DateTime.fromJSDate(j.scheduledAt, { zone: tz }).toFormat("HH:mm")}</span>
                      {j.timezone !== tz && (
                        <span className="muted w-24 text-xs" title={j.timezone}>
                          {j.localTime.slice(11)} {CITY[j.timezone] ?? j.timezone}
                        </span>
                      )}
                      <PlatformTag platform={j.platform} />
                      <span className="font-medium">@{j.account.handle}</span>
                      <span className="muted hidden md:inline">{FORMAT_LABEL[j.format]}</span>
                      {(() => {
                        const p = (j.meta as { purpose?: string } | null)?.purpose;
                        return p === "test" ? <span className="rounded px-1.5 text-xs muted" style={{ background: "var(--bg)" }}>тест</span> : p === "film" ? <span className="rounded px-1.5 text-xs muted" style={{ background: "var(--bg)" }}>фильм</span> : null;
                      })()}
                      <span className="min-w-0 flex-1 truncate">{a?.series?.title}{a?.episode ? ` · S${a.episode.season}E${a.episode.number}` : ""}</span>
                      {j.externalUrl && <span className="text-xs underline">ссылка</span>}
                      <StatusBadge status={j.status} />
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

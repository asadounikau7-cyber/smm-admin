import Link from "next/link";
import { DateTime } from "luxon";
import type { JobStatus, Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { Empty, PageHeader, PlatformTag, STATUS_LABEL, StatusBadge } from "@/components/ui";
import { FORMAT_LABEL } from "@/lib/validators";

const CITY: Record<string, string> = { "America/New_York": "Нью-Йорк", "Europe/London": "Лондон", "America/Winnipeg": "Виннипег" };

type SP = Promise<{ status?: string; platform?: string; account?: string; from?: string; job?: string }>;

export default async function PublicationsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const tz = env().BASE_TIMEZONE;
  const from = sp.from ? DateTime.fromISO(sp.from, { zone: tz }) : DateTime.now().setZone(tz).startOf("day").minus({ days: 3 });
  const jobs = await db.publicationJob.findMany({
    where: {
      status: sp.status ? (sp.status as JobStatus) : { notIn: ["DRAFT", "BLOCKED"] },
      platform: sp.platform ? (sp.platform as Platform) : undefined,
      accountId: sp.account || undefined,
      ...(sp.job ? { id: sp.job } : { scheduledAt: { gte: from.toUTC().toJSDate(), lt: from.plus({ days: 21 }).toUTC().toJSDate() } }),
    },
    include: { account: true, assetVersion: { include: { asset: { include: { series: true, episode: true } } } } },
    orderBy: { scheduledAt: "asc" },
    take: 500,
  });
  const accounts = await db.socialAccount.findMany({ orderBy: { handle: "asc" } });
  const days = new Map<string, typeof jobs>();
  for (const j of jobs) {
    const d = DateTime.fromJSDate(j.scheduledAt, { zone: tz }).setLocale("ru").toFormat("ccc, d LLL");
    days.set(d, [...(days.get(d) ?? []), j]);
  }

  return (
    <div>
      <PageHeader title="Публикации" />
      <p className="muted -mt-2 mb-3 text-xs">Время — по Виннипегу. Для каналов в другом часовом поясе рядом серым указано их местное время.</p>
      <form className="card mb-4 grid grid-cols-2 gap-2 p-3 md:grid-cols-5 md:items-end">
        <div>
          <label className="label">Статус</label>
          <select name="status" defaultValue={sp.status ?? ""} className="input">
            <option value="">все утверждённые</option>
            {Object.entries(STATUS_LABEL).filter(([k]) => !["DRAFT", "BLOCKED"].includes(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Площадка</label>
          <select name="platform" defaultValue={sp.platform ?? ""} className="input">
            <option value="">все</option><option value="YOUTUBE">YouTube</option><option value="INSTAGRAM">Instagram</option><option value="TIKTOK">TikTok</option>
          </select>
        </div>
        <div>
          <label className="label">Аккаунт</label>
          <select name="account" defaultValue={sp.account ?? ""} className="input">
            <option value="">все</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
          </select>
        </div>
        <div><label className="label">С даты (3 недели)</label><input type="date" name="from" defaultValue={from.toISODate()!} className="input" /></div>
        <button className="btn">Показать</button>
      </form>

      {jobs.length === 0 ? (
        <Empty>Нет публикаций за выбранный период.</Empty>
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

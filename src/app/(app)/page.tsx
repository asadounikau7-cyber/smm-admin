import Link from "next/link";
import { db } from "@/lib/db";
import { PageHeader, PlatformTag, StatusBadge, Empty } from "@/components/ui";
import { resolveNotificationAction } from "@/app/actions";
import { studioEditUrl } from "@/lib/adapters/youtube";
import { ChannelStatsTable, StatsLink } from "@/components/channelStats";

export default async function Dashboard() {
  const [issues, notes, upcoming, lastSync, manual, counts, studio] = await Promise.all([
    db.publicationJob.findMany({
      where: { status: { in: ["ACTION_REQUIRED", "FAILED", "UNKNOWN", "CANCEL_PENDING"] }, OR: [{ errorCode: null }, { errorCode: { not: "MANUAL" } }] },
      include: { account: true },
      orderBy: { scheduledAt: "asc" },
      take: 30,
    }),
    db.notification.findMany({ where: { resolved: false }, orderBy: { updatedAt: "desc" }, take: 20 }),
    db.publicationJob.findMany({
      where: { status: { in: ["QUEUED", "SENT", "PROCESSING", "MANUALLY_SCHEDULED"] }, scheduledAt: { gte: new Date(Date.now() - 3600_000) } },
      include: { account: true },
      orderBy: { scheduledAt: "asc" },
      take: 12,
    }),
    db.setting.findUnique({ where: { key: "lastSync" } }),
    db.publicationJob.count({ where: { status: "ACTION_REQUIRED", errorCode: "MANUAL" } }),
    db.publicationJob.groupBy({ by: ["status"], _count: true, where: { scheduledAt: { gte: new Date(Date.now() - 7 * 86400_000) } } }),
    db.publicationJob.findMany({
      where: { status: "PROCESSING", platform: "YOUTUBE", meta: { path: ["adapter", "manualOpen"], equals: true } },
      include: { account: true },
      orderBy: { scheduledAt: "asc" },
      take: 50,
    }),
  ]);
  const c = Object.fromEntries(counts.map((x) => [x.status, x._count])) as Record<string, number>;
  const sent = (c.PUBLISHED ?? 0) + (c.FAILED ?? 0) + (c.UNKNOWN ?? 0);
  const sync = lastSync?.value as { at?: string } | undefined;

  return (
    <div>
      <PageHeader title="Обзор">
        <Link href="/plan" className="btn btn-primary">Собрать неделю</Link>
      </PageHeader>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="В очереди" value={(c.QUEUED ?? 0) + (c.SENT ?? 0) + (c.PROCESSING ?? 0)} />
        <Stat label="Опубликовано за 7 дней" value={c.PUBLISHED ?? 0} />
        <Stat label="Доля подтверждённых" value={sent ? `${Math.round(((c.PUBLISHED ?? 0) / sent) * 100)}%` : "—"} />
        <Stat label="Синхронизация каталога" value={sync?.at ? new Date(sync.at).toLocaleString("ru-RU", { timeZone: "America/Winnipeg", dateStyle: "short", timeStyle: "short" }) : "не было"} />
      </div>

      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between"><h2 className="font-medium">Боевые каналы YouTube</h2><StatsLink /></div>
        <ChannelStatsTable mainOnly />
      </section>

      {manual > 0 && (
        <Link href="/publications?status=ACTION_REQUIRED&platform=TIKTOK" className="card mb-4 flex items-center gap-3 p-4 text-sm hover:opacity-80">
          <span className="rounded-full bg-teal-100 px-2 py-0.5 text-xs text-teal-800 dark:bg-teal-950 dark:text-teal-300">TikTok вручную</span>
          <span className="flex-1">Поставить в TikTok Studio: {manual} публикаций</span>
          <span className="underline">Открыть пакеты</span>
        </Link>
      )}

      {studio.length > 0 && (
        <section className="card mb-4 p-4">
          <h2 className="mb-1 font-medium">Открыть в YouTube Studio: {studio.length}</h2>
          <p className="mb-3 text-xs muted">Время публикации наступило, а YouTube не дал открыть ролик через API. Откройте профиль Octo канала, нажмите «Открыть в Studio» и поставьте нужный доступ. Админка сама увидит это в течение 10 минут.</p>
          <div className="divide-y" style={{ borderColor: "var(--border)" }}>
            {studio.map((j) => (
              <div key={j.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="whitespace-nowrap muted">{j.localTime}</span>
                <span>@{j.account.handle}</span>
                <span className="flex-1 truncate">{j.title ?? j.caption.split("\n")[0]}</span>
                <span className="text-xs muted">{j.visibility === "PUBLIC" ? "открытый" : "по ссылке"}</span>
                <a href={studioEditUrl(j.externalId!)} target="_blank" className="btn btn-sm btn-primary">Открыть в Studio</a>
                <Link href={`/publications/${j.id}`} className="btn btn-sm">Задача</Link>
              </div>
            ))}
          </div>
        </section>
      )}

      <h2 className="mb-2 font-medium">Очередь исключений</h2>
      {issues.length === 0 && notes.length === 0 ? (
        <Empty>Всё в порядке: нет задач, требующих вмешательства.</Empty>
      ) : (
        <div className="card mb-6 divide-y" style={{ borderColor: "var(--border)" }}>
          {issues.map((j) => (
            <Link key={j.id} href={`/publications/${j.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm hover:opacity-80">
              <StatusBadge status={j.status} />
              <PlatformTag platform={j.platform} />
              <span>@{j.account.handle}</span>
              <span className="muted">{j.localTime}</span>
              <span className="muted flex-1 truncate">{j.errorMessage}</span>
            </Link>
          ))}
          {notes.map((n) => (
            <div key={n.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">Уведомление{n.count > 1 ? ` ×${n.count}` : ""}</span>
              <span className="flex-1">{n.message}</span>
              {n.link && <Link className="btn btn-sm" href={n.link}>Открыть</Link>}
              <form action={resolveNotificationAction}><input type="hidden" name="id" value={n.id} /><button className="btn btn-sm">Скрыть</button></form>
            </div>
          ))}
        </div>
      )}

      <h2 className="mb-2 mt-6 font-medium">Ближайшие публикации</h2>
      {upcoming.length === 0 ? (
        <Empty>Нет запланированных публикаций. Соберите и утвердите неделю.</Empty>
      ) : (
        <div className="card scroll-x">
          <table className="tbl">
            <tbody>
              {upcoming.map((j) => (
                <tr key={j.id}>
                  <td className="whitespace-nowrap">{j.localTime}</td>
                  <td><PlatformTag platform={j.platform} /></td>
                  <td>@{j.account.handle}</td>
                  <td className="max-w-xs truncate">{j.title ?? j.caption.split("\n")[0]}</td>
                  <td><StatusBadge status={j.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card p-4">
      <div className="text-xs muted">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}

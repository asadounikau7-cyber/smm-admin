import Link from "next/link";
import type { Platform, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ChannelStatsTable, StatsLink, loadChannelStats } from "@/components/channelStats";

const n = (v: number) => v.toLocaleString("ru-RU");
const purpose = (p: string): Prisma.PublicationJobWhereInput => ({ meta: { path: ["purpose"], equals: p } });

function Tile({ label, value, sub, href, tone }: { label: string; value: string | number; sub?: React.ReactNode; href?: string; tone?: "good" | "bad" }) {
  const color = tone === "good" ? "text-green-600" : tone === "bad" ? "text-red-600" : "";
  const body = (
    <div className="card h-full p-4 text-center">
      <div className="text-xs muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${color}`}>{typeof value === "number" ? n(value) : value}</div>
      {sub && <div className="mt-0.5 text-xs muted">{sub}</div>}
    </div>
  );
  return href ? <Link href={href} className="block hover:opacity-80">{body}</Link> : body;
}

function Gain({ v }: { v: number | null }) {
  if (v === null) return <>за сутки: —</>;
  return <>за сутки: <span className={v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : ""}>{v > 0 ? "+" : ""}{n(v)}</span></>;
}

/** «Обзор» top: series tests, published totals, and a summary per platform. */
export async function OverviewStats() {
  const week = new Date(Date.now() - 7 * 86400_000);
  const pub = (where: Prisma.PublicationJobWhereInput) => db.publicationJob.count({ where: { status: "PUBLISHED", ...where } });
  const social = async (platform: Platform) => {
    const [accounts, total, last7, planned, overdue] = await Promise.all([
      db.socialAccount.count({ where: { platform, status: { not: "DISABLED" } } }),
      pub({ platform }),
      pub({ platform, scheduledAt: { gte: week, lte: new Date() } }),
      db.publicationJob.count({ where: { platform, status: "MANUALLY_SCHEDULED" } }),
      db.publicationJob.count({ where: { platform, status: "ACTION_REQUIRED", errorCode: "MANUAL", scheduledAt: { lt: new Date() } } }),
    ]);
    return { accounts, total, last7, planned, overdue };
  };
  const [stages, queued, ytAll, ytTests, ytFilms, yt7, tt, ig, stats] = await Promise.all([
    db.series.groupBy({ by: ["stage"], _count: true }),
    db.series.count({ where: { stage: "NEW", testQueuedAt: { not: null } } }),
    pub({ platform: "YOUTUBE" }),
    pub({ platform: "YOUTUBE", ...purpose("test") }),
    pub({ platform: "YOUTUBE", ...purpose("film") }),
    pub({ platform: "YOUTUBE", account: { role: "MAIN" }, scheduledAt: { gte: week, lte: new Date() }, NOT: [purpose("test")] }),
    social("TIKTOK"),
    social("INSTAGRAM"),
    loadChannelStats(),
  ]);
  const s = Object.fromEntries(stages.map((x) => [x.stage, x._count])) as Record<string, number>;
  const passed = s.IN_WORK ?? 0;
  const failed = s.TEST_FAILED ?? 0;
  const tested = passed + failed;
  const ytMain = ytAll - ytTests - ytFilms;

  const mains = stats.rows.filter((r) => r.a.role === "MAIN");
  const withPrev = mains.filter((r) => r.prev);
  const sum = (k: "subscribers" | "views" | "likes" | "publicVideos") => mains.reduce((t, r) => t + r.last[k], 0);
  const gain = (k: "subscribers" | "views" | "likes" | "publicVideos") => (withPrev.length ? withPrev.reduce((t, r) => t + r.last[k] - r.prev![k], 0) : null);

  const socialRow = (title: string, href: string, x: Awaited<ReturnType<typeof social>>) => (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between"><h2 className="font-medium">{title}</h2><Link href={href} className="text-xs underline">Открыть конвейер</Link></div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Tile label="Аккаунтов" value={x.accounts} />
        <Tile label="Опубликовано всего" value={x.total} sub={`за 7 дней: ${n(x.last7)}`} />
        <Tile label="Запланировано" value={x.planned} sub="отмечено исполнителем" />
        <Tile label="Просрочено" value={x.overdue} tone={x.overdue ? "bad" : undefined} sub="время прошло, не выложено" />
        <Tile label="Просмотры" value="—" sub="ручной режим: площадка не отдаёт цифры" />
      </div>
    </section>
  );

  return (
    <>
      <section className="mb-6">
        <h2 className="mb-2 font-medium">Сериалы: проверка на тестовых каналах</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Tile label="Протестировано" value={tested} sub="проверка закончена" href="/catalog" />
          <Tile label="Прошли проверку" value={passed} tone="good" sub={tested ? `${Math.round((passed / tested) * 100)}% от проверенных` : undefined} href="/catalog?tab=work" />
          <Tile label="Не прошли" value={failed} tone={failed ? "bad" : undefined} sub={tested ? `${Math.round((failed / tested) * 100)}% от проверенных` : undefined} href="/catalog?tab=failed" />
          <Tile label="На тесте сейчас" value={s.TESTING ?? 0} href="/catalog?tab=testing" />
          <Tile label="Ждут теста" value={queued} sub="в очереди конвейера" />
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 font-medium">Публикации видео, всего</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Tile label="Всего опубликовано" value={ytAll + tt.total + ig.total} sub="все площадки" href="/publications?view=past" />
          <Tile label="YouTube, боевые" value={ytMain} sub={`за 7 дней: ${n(yt7)}`} />
          <Tile label="YouTube, тесты" value={ytTests} sub="закрытые, на тестовых" />
          <Tile label="Фильмы" value={ytFilms} href="/films" />
          <Tile label="TikTok + Instagram" value={tt.total + ig.total} sub={`TikTok ${n(tt.total)} · Instagram ${n(ig.total)}`} />
        </div>
      </section>

      <section className="mb-3">
        <h2 className="mb-2 font-medium">Боевые каналы YouTube: итого</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Tile label="Каналов" value={mains.length} />
          <Tile label="Подписчики" value={sum("subscribers")} sub={<Gain v={gain("subscribers")} />} />
          <Tile label="Просмотры" value={sum("views")} sub={<Gain v={gain("views")} />} />
          <Tile label="Лайки" value={sum("likes")} sub={<Gain v={gain("likes")} />} />
          <Tile label="Открытых роликов" value={sum("publicVideos")} sub={<Gain v={gain("publicVideos")} />} />
        </div>
      </section>

      <section className="mb-6">
        <div className="mb-2 flex justify-end"><StatsLink /></div>
        <ChannelStatsTable mainOnly />
      </section>

      {socialRow("TikTok: итого", "/tiktok", tt)}
      {socialRow("Instagram: итого", "/instagram", ig)}
    </>
  );
}

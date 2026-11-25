import Link from "next/link";
import { DateTime } from "luxon";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

const n = (v: number) => v.toLocaleString("ru-RU");
function Delta({ v }: { v: number | null }) {
  if (v === null || v === 0) return <span className="delta muted">{v === null ? "—" : "±0"}</span>;
  return <span className={`delta ${v > 0 ? "text-green-600" : "text-red-600"}`}>{v > 0 ? "+" : ""}{n(v)}</span>;
}

/** Latest snapshot per YouTube channel with the change vs the previous day (main channels first). */
export async function loadChannelStats() {
  const tz = env().BASE_TIMEZONE;
  const today = DateTime.now().setZone(tz).startOf("day");
  const accounts = await db.socialAccount.findMany({ where: { platform: "YOUTUBE" }, orderBy: [{ role: "asc" }, { geo: "asc" }, { createdAt: "asc" }] });
  const stats = await db.channelStat.findMany({ where: { day: { gte: today.minus({ days: 8 }).toISODate()! } }, orderBy: { day: "asc" } });
  const rows = accounts
    .map((a) => {
      const list = stats.filter((s) => s.accountId === a.id);
      return { a, list, last: list[list.length - 1], prev: list.length > 1 ? list[list.length - 2] : null };
    })
    .filter((r) => r.last);
  const takenAt = rows.reduce<Date | null>((t, r) => (!t || r.last.takenAt > t ? r.last.takenAt : t), null);
  return { tz, today, rows, takenAt };
}

/** The summary table: shown on «Статистика» (all channels) and «Обзор» (main channels only). */
export async function ChannelStatsTable({ mainOnly = false }: { mainOnly?: boolean }) {
  const { rows: all } = await loadChannelStats();
  const rows = mainOnly ? all.filter((r) => r.a.role === "MAIN") : all;
  if (!rows.length) return <div className="card p-4 text-sm muted">Снимков статистики пока нет: первый появится в течение часа.</div>;
  const sum = (k: "subscribers" | "views" | "likes" | "comments" | "publicVideos") => rows.filter((r) => r.a.role === "MAIN").reduce((t, r) => t + r.last[k], 0);
  const sumPrev = (k: "subscribers" | "views" | "likes") => rows.filter((r) => r.a.role === "MAIN" && r.prev).reduce((t, r) => t + r.prev![k], 0);
  const mainHasPrev = rows.some((r) => r.a.role === "MAIN" && r.prev);
  const d = (r: (typeof rows)[number], k: "subscribers" | "views" | "likes" | "comments" | "publicVideos") => (r.prev ? r.last[k] - r.prev[k] : null);
  const mains = rows.filter((r) => r.a.role === "MAIN");
  const total = (k: "subscribers" | "views" | "likes" | "comments" | "publicVideos") => (mainHasPrev ? mains.reduce((t, r) => t + (d(r, k) ?? 0), 0) : null);
  return (
    <section className="card scroll-x">
      <table className="tbl num">
        <thead>
          <tr>
            <th>Канал</th>
            <th className="c">Роль</th>
            <th className="c">Подписчики</th>
            <th className="c">Просмотры</th>
            <th className="c">Лайки</th>
            <th className="c">Комментарии</th>
            <th className="c">Открытых роликов</th>
            <th className="c">Новых за сутки</th>
            <th>Лучший ролик</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const { a, last } = r;
            const top = last.top as { id: string; title: string; views: number } | null;
            const fresh = d(r, "publicVideos");
            return (
              <tr key={a.id}>
                <td className="whitespace-nowrap">
                  <a className="font-medium hover:underline" href={`https://www.youtube.com/@${a.handle}/shorts`} target="_blank" rel="noreferrer">@{a.handle}</a>
                  {a.geo && <span className="ml-1.5 rounded px-1.5 text-xs muted" style={{ background: "var(--bg)" }}>{a.geo}</span>}
                </td>
                <td className="c text-xs muted">{a.role === "MAIN" ? "боевой" : "тестовый"}</td>
                <td className="c">{n(last.subscribers)}<Delta v={d(r, "subscribers")} /></td>
                <td className="c font-medium">{n(last.views)}<Delta v={d(r, "views")} /></td>
                <td className="c">{n(last.likes)}<Delta v={d(r, "likes")} /></td>
                <td className="c">{n(last.comments)}<Delta v={d(r, "comments")} /></td>
                <td className="c">{n(last.publicVideos)}</td>
                <td className="c">{fresh === null ? <span className="muted">—</span> : fresh > 0 ? <span className="font-medium text-green-600">+{fresh}</span> : <span className="muted">0</span>}</td>
                <td className="max-w-xs text-xs">
                  {top && top.views > 0 ? (
                    <>
                      <a className="line-clamp-2 hover:underline" href={`https://www.youtube.com/shorts/${top.id}`} target="_blank" rel="noreferrer">{top.title}</a>
                      <span className="muted">{n(top.views)} просм.</span>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
          <tr className="total">
            <td>Боевые, всего</td>
            <td></td>
            <td className="c">{n(sum("subscribers"))}<Delta v={mainHasPrev ? sum("subscribers") - sumPrev("subscribers") : null} /></td>
            <td className="c">{n(sum("views"))}<Delta v={mainHasPrev ? sum("views") - sumPrev("views") : null} /></td>
            <td className="c">{n(sum("likes"))}<Delta v={mainHasPrev ? sum("likes") - sumPrev("likes") : null} /></td>
            <td className="c">{n(sum("comments"))}<Delta v={total("comments")} /></td>
            <td className="c">{n(sum("publicVideos"))}</td>
            <td className="c">{(() => { const t = total("publicVideos"); return t === null ? "—" : t > 0 ? `+${t}` : "0"; })()}</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

export function StatsLink() {
  return <Link href="/stats" className="text-xs underline">Вся статистика</Link>;
}

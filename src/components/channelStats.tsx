import Link from "next/link";
import { DateTime } from "luxon";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

const n = (v: number) => v.toLocaleString("ru-RU");
function Delta({ v }: { v: number | null }) {
  if (v === null) return <span className="muted text-xs"> —</span>;
  if (v === 0) return <span className="muted text-xs"> ±0</span>;
  return <span className={`text-xs ${v > 0 ? "text-green-600" : "text-red-600"}`}> {v > 0 ? "+" : ""}{n(v)}</span>;
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
  return (
          <section className="card overflow-x-auto">
            <table className="table text-sm">
              <thead>
                <tr><th>Канал</th><th>Роль</th><th className="text-right">Подписчики</th><th className="text-right">Просмотры</th><th className="text-right">Лайки</th><th className="text-right">Коммент.</th><th className="text-right">Открытых роликов</th><th>Лучший ролик</th></tr>
              </thead>
              <tbody>
                {rows.map(({ a, last, prev }) => {
                  const top = last.top as { id: string; title: string; views: number } | null;
                  return (
                    <tr key={a.id}>
                      <td><a className="underline" href={`https://www.youtube.com/@${a.handle}/shorts`} target="_blank" rel="noreferrer">@{a.handle}</a> <span className="muted text-xs">{a.geo ?? ""}</span></td>
                      <td>{a.role === "MAIN" ? "Боевой" : "Тестовый"}</td>
                      <td className="text-right">{n(last.subscribers)}<Delta v={prev ? last.subscribers - prev.subscribers : null} /></td>
                      <td className="text-right">{n(last.views)}<Delta v={prev ? last.views - prev.views : null} /></td>
                      <td className="text-right">{n(last.likes)}<Delta v={prev ? last.likes - prev.likes : null} /></td>
                      <td className="text-right">{n(last.comments)}</td>
                      <td className="text-right">{n(last.publicVideos)}</td>
                      <td className="text-xs">{top && top.views > 0 ? <a className="underline" href={`https://www.youtube.com/shorts/${top.id}`} target="_blank" rel="noreferrer">{top.title}</a> : <span className="muted">—</span>}{top && top.views > 0 ? <span className="muted"> · {n(top.views)}</span> : null}</td>
                    </tr>
                  );
                })}
                <tr className="font-medium">
                  <td>Боевые, всего</td><td></td>
                  <td className="text-right">{n(sum("subscribers"))}<Delta v={mainHasPrev ? sum("subscribers") - sumPrev("subscribers") : null} /></td>
                  <td className="text-right">{n(sum("views"))}<Delta v={mainHasPrev ? sum("views") - sumPrev("views") : null} /></td>
                  <td className="text-right">{n(sum("likes"))}<Delta v={mainHasPrev ? sum("likes") - sumPrev("likes") : null} /></td>
                  <td className="text-right">{n(sum("comments"))}</td>
                  <td className="text-right">{n(sum("publicVideos"))}</td><td></td>
                </tr>
              </tbody>
            </table>
          </section>
  );
}

export function StatsLink() {
  return <Link href="/stats" className="text-xs underline">Вся статистика</Link>;
}

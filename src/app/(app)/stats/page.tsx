import { DateTime } from "luxon";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { Empty, PageHeader } from "@/components/ui";
import { refreshStatsAction } from "@/app/testActions";

export const dynamic = "force-dynamic";

const n = (v: number) => v.toLocaleString("ru-RU");
function Delta({ v }: { v: number | null }) {
  if (v === null) return <span className="muted text-xs"> —</span>;
  if (v === 0) return <span className="muted text-xs"> ±0</span>;
  return <span className={`text-xs ${v > 0 ? "text-green-600" : "text-red-600"}`}> {v > 0 ? "+" : ""}{n(v)}</span>;
}

export default async function StatsPage() {
  const tz = env().BASE_TIMEZONE;
  const today = DateTime.now().setZone(tz).startOf("day");
  const days = Array.from({ length: 7 }, (_, i) => today.minus({ days: 6 - i }).toISODate()!);
  const accounts = await db.socialAccount.findMany({ where: { platform: "YOUTUBE" }, orderBy: [{ role: "asc" }, { geo: "asc" }, { createdAt: "asc" }] });
  const stats = await db.channelStat.findMany({ where: { day: { gte: today.minus({ days: 8 }).toISODate()! } }, orderBy: { day: "asc" } });
  const by = (id: string) => stats.filter((s) => s.accountId === id);
  const rows = accounts
    .map((a) => {
      const list = by(a.id);
      const last = list[list.length - 1];
      const prev = list.length > 1 ? list[list.length - 2] : null;
      return { a, last, prev, list };
    })
    .filter((r) => r.last);
  const sum = (k: "subscribers" | "views" | "likes" | "comments" | "publicVideos", main: boolean) =>
    rows.filter((r) => (r.a.role === "MAIN") === main).reduce((t, r) => t + r.last![k], 0);
  const sumPrev = (k: "subscribers" | "views" | "likes", main: boolean) =>
    rows.filter((r) => (r.a.role === "MAIN") === main && r.prev).reduce((t, r) => t + r.prev![k], 0);
  const mainHasPrev = rows.some((r) => r.a.role === "MAIN" && r.prev);
  const takenAt = rows.reduce<Date | null>((t, r) => (!t || r.last!.takenAt > t ? r.last!.takenAt : t), null);

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader title="Статистика каналов">
        <form action={refreshStatsAction}><button className="btn">Обновить сейчас</button></form>
      </PageHeader>
      <p className="text-xs muted">
        Данные YouTube API, обновляются каждый час{takenAt ? `, последний снимок ${DateTime.fromJSDate(takenAt, { zone: tz }).setLocale("ru").toFormat("d LLL, HH:mm")} (Виннипег)` : ""}.
        Изменение — к предыдущему дню. Лайки и комментарии — сумма по открытым роликам канала. Просмотры YouTube показывает с задержкой до суток.
      </p>
      {rows.length === 0 ? (
        <Empty>Снимков пока нет: первый появится в течение часа или по кнопке «Обновить сейчас».</Empty>
      ) : (
        <>
          <section className="card overflow-x-auto">
            <table className="table text-sm">
              <thead>
                <tr><th>Канал</th><th>Роль</th><th className="text-right">Подписчики</th><th className="text-right">Просмотры</th><th className="text-right">Лайки</th><th className="text-right">Коммент.</th><th className="text-right">Открытых роликов</th><th>Лучший ролик</th></tr>
              </thead>
              <tbody>
                {rows.map(({ a, last, prev }) => {
                  const top = last!.top as { id: string; title: string; views: number } | null;
                  return (
                    <tr key={a.id}>
                      <td><a className="underline" href={`https://www.youtube.com/@${a.handle}/shorts`} target="_blank" rel="noreferrer">@{a.handle}</a> <span className="muted text-xs">{a.geo ?? ""}</span></td>
                      <td>{a.role === "MAIN" ? "Боевой" : "Тестовый"}</td>
                      <td className="text-right">{n(last!.subscribers)}<Delta v={prev ? last!.subscribers - prev.subscribers : null} /></td>
                      <td className="text-right">{n(last!.views)}<Delta v={prev ? last!.views - prev.views : null} /></td>
                      <td className="text-right">{n(last!.likes)}<Delta v={prev ? last!.likes - prev.likes : null} /></td>
                      <td className="text-right">{n(last!.comments)}</td>
                      <td className="text-right">{n(last!.publicVideos)}</td>
                      <td className="text-xs">{top && top.views > 0 ? <a className="underline" href={`https://www.youtube.com/shorts/${top.id}`} target="_blank" rel="noreferrer">{top.title}</a> : <span className="muted">—</span>}{top && top.views > 0 ? <span className="muted"> · {n(top.views)}</span> : null}</td>
                    </tr>
                  );
                })}
                <tr className="font-medium">
                  <td>Боевые, всего</td><td></td>
                  <td className="text-right">{n(sum("subscribers", true))}<Delta v={mainHasPrev ? sum("subscribers", true) - sumPrev("subscribers", true) : null} /></td>
                  <td className="text-right">{n(sum("views", true))}<Delta v={mainHasPrev ? sum("views", true) - sumPrev("views", true) : null} /></td>
                  <td className="text-right">{n(sum("likes", true))}<Delta v={mainHasPrev ? sum("likes", true) - sumPrev("likes", true) : null} /></td>
                  <td className="text-right">{n(sum("comments", true))}</td>
                  <td className="text-right">{n(sum("publicVideos", true))}</td><td></td>
                </tr>
              </tbody>
            </table>
          </section>

          <section>
            <h2 className="mb-2 font-medium">Просмотры по дням</h2>
            <div className="card overflow-x-auto">
              <table className="table text-sm">
                <thead><tr><th>Канал</th>{days.map((d) => <th key={d} className="text-right">{DateTime.fromISO(d).setLocale("ru").toFormat("d LLL")}</th>)}</tr></thead>
                <tbody>
                  {rows.filter((r) => r.a.role === "MAIN").map(({ a, list }) => (
                    <tr key={a.id}>
                      <td>@{a.handle}</td>
                      {days.map((d) => {
                        const s = list.find((x) => x.day === d);
                        return <td key={d} className="text-right">{s ? n(s.views) : <span className="muted">—</span>}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-xs muted">Всего просмотров канала на конец дня. Тестовые каналы не показаны: их ролики закрытые.</p>
          </section>
        </>
      )}
    </div>
  );
}

import { DateTime } from "luxon";
import { Empty, PageHeader } from "@/components/ui";
import { ChannelStatsTable, loadChannelStats } from "@/components/channelStats";
import { refreshStatsAction } from "@/app/testActions";

export const dynamic = "force-dynamic";

const n = (v: number) => v.toLocaleString("ru-RU");

export default async function StatsPage() {
  const { tz, today, rows, takenAt } = await loadChannelStats();
  const days = Array.from({ length: 7 }, (_, i) => today.minus({ days: 6 - i }).toISODate()!);

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
          <ChannelStatsTable />
          <section>
            <h2 className="mb-2 font-medium">Просмотры по дням</h2>
            <div className="card scroll-x">
              <table className="tbl num">
                <thead><tr><th>Канал</th>{days.map((d) => <th key={d} className="c">{DateTime.fromISO(d).setLocale("ru").toFormat("ccc, d LLL")}</th>)}<th className="c">За неделю</th></tr></thead>
                <tbody>
                  {rows.filter((r) => r.a.role === "MAIN").map(({ a, list }) => (
                    <tr key={a.id}>
                      <td className="whitespace-nowrap font-medium">@{a.handle}</td>
                      {days.map((d, i) => {
                        const s = list.find((x) => x.day === d);
                        const p = i > 0 ? list.find((x) => x.day === days[i - 1]) : list.find((x) => x.day < d && x.day >= DateTime.fromISO(d).minus({ days: 1 }).toISODate()!);
                        const gain = s && p ? s.views - p.views : null;
                        return (
                          <td key={d} className="c">
                            {s ? n(s.views) : <span className="muted">—</span>}
                            {gain !== null && <span className={`delta ${gain > 0 ? "text-green-600" : "muted"}`}>{gain > 0 ? `+${n(gain)}` : "±0"}</span>}
                          </td>
                        );
                      })}
                      {(() => {
                        const inWeek = list.filter((x) => days.includes(x.day));
                        const g = inWeek.length > 1 ? inWeek[inWeek.length - 1].views - inWeek[0].views : null;
                        return <td className="c font-medium">{g === null ? "—" : g > 0 ? `+${n(g)}` : "0"}</td>;
                      })()}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-xs muted">Всего просмотров канала на конец дня, под числом — прирост за день. Тестовые каналы не показаны: их ролики закрытые.</p>
          </section>
        </>
      )}
    </div>
  );
}

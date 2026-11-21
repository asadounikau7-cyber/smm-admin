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

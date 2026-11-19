import Link from "next/link";
import { db } from "@/lib/db";
import { Empty, PageHeader, PlatformTag } from "@/components/ui";
import { FORMAT_LABEL } from "@/lib/validators";
import { WEEKDAYS_RU, type Slot } from "@/lib/time";

const KIND: Record<string, string> = { FULL_EPISODE: "Серии", VERTICAL: "Вертикальные", TEASER: "Анонсы", COVER: "Обложки", SUBTITLES: "Субтитры" };

export default async function RulesPage() {
  const rules = await db.releaseRule.findMany({ include: { series: true, account: true }, orderBy: [{ series: { title: "asc" } }, { createdAt: "asc" }] });
  const byId = new Map(rules.map((r) => [r.id, r]));
  return (
    <div>
      <PageHeader title="Правила выпуска">
        <Link href="/rules/new" className="btn btn-primary">+ Правило</Link>
      </PageHeader>
      {rules.length === 0 ? (
        <Empty>Правил пока нет. Правило связывает сериал, тип материала, язык, аккаунт и слоты, например «серии на YouTube Shorts по вторникам и четвергам в 19:00».</Empty>
      ) : (
        <div className="card scroll-x">
          <table className="tbl">
            <thead><tr><th>Название</th><th>Сериал</th><th>Что</th><th>Куда</th><th>Когда</th><th>Порядок</th><th></th></tr></thead>
            <tbody>
              {rules.map((r) => {
                const slots = (r.slots as Slot[]) ?? [];
                const when = r.offsetFromRuleId
                  ? `${r.offsetMinutes! < 0 ? "за" : "через"} ${Math.abs(r.offsetMinutes! / 60)} ч от «${byId.get(r.offsetFromRuleId)?.name ?? "?"}»`
                  : slots.map((s) => `${WEEKDAYS_RU[s.weekday]} ${s.time}`).join(", ");
                return (
                  <tr key={r.id} className={r.enabled ? "" : "opacity-50"}>
                    <td className="font-medium">{r.name}</td>
                    <td className={`max-w-[220px] truncate ${r.series.bannedAt ? "text-red-600" : ""}`}>{r.series.title}{r.series.bannedAt ? " · INACTIVE" : ""}</td>
                    <td>{KIND[r.assetKind]} · {r.language}</td>
                    <td><PlatformTag platform={r.account.platform} /> <span className="muted">@{r.account.handle} · {FORMAT_LABEL[r.format]}</span></td>
                    <td>{when} <span className="text-xs muted">{r.timezone}</span></td>
                    <td>{r.strictOrder ? "строгий" : "—"}{r.maxEpisodes ? `, первые ${r.maxEpisodes}` : ""}</td>
                    <td><Link href={`/rules/${r.id}`} className="btn btn-sm">Изменить</Link></td>
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

import Link from "next/link";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { saveHooksAction } from "@/app/testActions";

export const dynamic = "force-dynamic";

/** Hook titles for series that passed the test: the plot set-up that goes into the YouTube title. */
export default async function HooksPage({ searchParams }: { searchParams: Promise<{ all?: string; ok?: string }> }) {
  const sp = await searchParams;
  const all = sp.all === "1";
  const series = await db.series.findMany({
    where: { stage: "IN_WORK", bannedAt: null, ...(all ? {} : { hookTitle: null }) },
    orderBy: { inWorkAt: "desc" },
    take: 300,
    select: { id: true, title: true, hookTitle: true, inWorkAt: true },
  });
  return (
    <div className="max-w-4xl space-y-4">
      <PageHeader title="Названия-завязки">
        <Link href={all ? "/hooks" : "/hooks?all=1"} className="btn">{all ? "Только без завязки" : "Показать все"}</Link>
      </PageHeader>
      {sp.ok && <div className="card p-3 text-sm">{sp.ok}</div>}
      <p className="text-xs muted">
        Завязка сюжета одной фразой идёт в название ролика на YouTube вместо названия сериала: «… | Part 1 #shortdrama». До 90 символов, по-английски.
        Пусто — в названии остаётся название сериала. Меняются только ещё не загруженные серии.
      </p>
      {series.length === 0 ? (
        <div className="card p-4 text-sm muted">Все прошедшие тест сериалы уже с завязкой.</div>
      ) : (
        <form action={saveHooksAction} className="space-y-2">
          {series.map((s) => (
            <div key={s.id} className="card p-3">
              <div className="mb-1 text-sm"><Link className="underline" href={`/catalog?series=${s.id}`}>{s.title}</Link></div>
              <input name={`hook_${s.id}`} data-series={s.title} defaultValue={s.hookTitle ?? ""} maxLength={90} className="input w-full" placeholder="She Was Sold to the Mafia King—Now He Won't Let Her Go!" />
            </div>
          ))}
          <button className="btn btn-primary">Сохранить</button>
        </form>
      )}
    </div>
  );
}

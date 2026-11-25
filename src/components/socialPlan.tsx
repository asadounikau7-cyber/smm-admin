import Link from "next/link";
import { db } from "@/lib/db";
import { manualStatusAction } from "@/app/actions";
import { CopyButton } from "./copy";
import { PlatformTag } from "./ui";

const fmt = (d: Date, tz: string) => d.toLocaleString("ru-RU", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" });

/**
 * TikTok / Instagram posted by hand: what the operator has to put up today and tomorrow, account by account,
 * with the file, the caption and a mark for each post. Overdue packages come first.
 */
export async function SocialPlan({ platform, title }: { platform?: "TIKTOK" | "INSTAGRAM"; title?: string } = {}) {
  const now = new Date();
  const until = new Date(now.getTime() + 36 * 3600_000);
  const jobs = await db.publicationJob.findMany({
    where: {
      platform: platform ? platform : { in: ["TIKTOK", "INSTAGRAM"] },
      OR: [
        { status: "ACTION_REQUIRED", errorCode: "MANUAL", scheduledAt: { lt: until } },
        { status: "MANUALLY_SCHEDULED", scheduledAt: { gte: new Date(now.getTime() - 24 * 3600_000) } },
        { status: "PUBLISHED", updatedAt: { gte: new Date(now.getTime() - 24 * 3600_000) } },
      ],
    },
    include: { account: { include: { octoProfile: true } } },
    orderBy: { scheduledAt: "asc" },
    take: 200,
  });
  if (!jobs.length) return null;
  const metas = jobs.map((j) => (j.meta ?? {}) as { seriesId?: string; episodeId?: string });
  const [series, eps] = await Promise.all([
    db.series.findMany({ where: { id: { in: metas.flatMap((m) => (m.seriesId ? [m.seriesId] : [])) } }, select: { id: true, title: true } }),
    db.episode.findMany({ where: { id: { in: metas.flatMap((m) => (m.episodeId ? [m.episodeId] : [])) } }, select: { id: true, number: true } }),
  ]);
  const sTitle = new Map(series.map((s) => [s.id, s.title]));
  const eNum = new Map(eps.map((e) => [e.id, e.number]));
  const accounts = [...new Map(jobs.map((j) => [j.accountId, j.account])).values()];
  const todo = jobs.filter((j) => j.status === "ACTION_REQUIRED");
  const overdue = todo.filter((j) => j.scheduledAt < now).length;

  return (
    <section className="card mb-6 p-4">
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h2 className="font-medium">{title ?? "TikTok / Instagram: план на сегодня и завтра"}</h2>
        <span className="text-xs muted">выложить: {todo.length}{overdue ? ` · просрочено: ${overdue}` : ""}</span>
      </div>
      <p className="mb-3 text-xs muted">
        Скачайте видео, откройте профиль Octo аккаунта, выложите с этой подписью в указанное время и отметьте здесь. «Запланировано» — если поставили на время в TikTok Studio; «Выложено» — со ссылкой на пост.
      </p>
      {accounts.map((a) => {
        const rows = jobs.filter((j) => j.accountId === a.id);
        return (
          <div key={a.id} className="mb-4">
            <div className="mb-1 flex items-center gap-2 text-sm font-medium">
              <PlatformTag platform={a.platform} /> @{a.handle}
              {a.geo && <span className="muted">· {a.geo}</span>}
              {a.octoProfile && <span className="muted">· Octo: {a.octoProfile.title}</span>}
            </div>
            <div className="divide-y" style={{ borderColor: "var(--border)" }}>
              {rows.map((j) => {
                const m = (j.meta ?? {}) as { seriesId?: string; episodeId?: string };
                const late = j.status === "ACTION_REQUIRED" && j.scheduledAt < now;
                const name = `${(m.seriesId && sTitle.get(m.seriesId)) ?? j.caption.split("\n")[0]}${m.episodeId && eNum.has(m.episodeId) ? ` · серия ${eNum.get(m.episodeId)}` : ""}`;
                return (
                  <div key={j.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                    <span className={`w-24 whitespace-nowrap ${late ? "font-medium text-red-600" : "muted"}`}>{fmt(j.scheduledAt, j.timezone)}</span>
                    <Link href={`/publications/${j.id}`} className="min-w-0 flex-1 truncate hover:underline">{name}</Link>
                    {j.status === "PUBLISHED" ? (
                      <a href={j.externalUrl ?? "#"} target="_blank" className="text-xs text-green-700 underline dark:text-green-400">выложено</a>
                    ) : (
                      <>
                        {j.status === "MANUALLY_SCHEDULED" && <span className="text-xs muted">запланировано</span>}
                        {late && <span className="text-xs text-red-600">просрочено</span>}
                        {j.assetVersionId && <a className="btn btn-sm" href={`/api/media/${j.assetVersionId}`} target="_blank">Скачать</a>}
                        <CopyButton text={j.caption} label="Текст" />
                        {j.status === "ACTION_REQUIRED" && (
                          <form action={manualStatusAction}>
                            <input type="hidden" name="id" value={j.id} /><input type="hidden" name="rowVersion" value={j.rowVersion} />
                            <input type="hidden" name="target" value="MANUALLY_SCHEDULED" />
                            <button className="btn btn-sm">Запланировано</button>
                          </form>
                        )}
                        <form action={manualStatusAction} className="flex gap-1">
                          <input type="hidden" name="id" value={j.id} /><input type="hidden" name="rowVersion" value={j.rowVersion} />
                          <input type="hidden" name="target" value="PUBLISHED" />
                          <input name="url" required placeholder="ссылка на пост" className="input h-8 w-44 text-xs" />
                          <button className="btn btn-sm btn-primary">Выложено</button>
                        </form>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}

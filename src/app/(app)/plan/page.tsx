import Link from "next/link";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { Empty, Flash, PageHeader, PlatformTag, StatusBadge, fmtDur } from "@/components/ui";
import { FORMAT_LABEL } from "@/lib/validators";
import { approveWeekAction, buildWeekAction, editDraftAction, generateCoverAction, toggleExcludeAction } from "@/app/actions";

type SP = Promise<{ week?: string; ok?: string; err?: string; confirm?: string; key?: string }>;

export default async function PlanPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const tz = env().BASE_TIMEZONE;
  const now = DateTime.now().setZone(tz);
  // Default: next week if today is Fri-Sun, otherwise this week.
  const base = sp.week ? DateTime.fromISO(sp.week, { zone: tz }) : now.weekday >= 5 ? now.plus({ weeks: 1 }) : now;
  const monday = base.startOf("week");
  const weekStart = monday.toUTC().toJSDate();
  const weekParam = monday.toISODate()!;
  const prev = monday.minus({ weeks: 1 }).toISODate();
  const next = monday.plus({ weeks: 1 }).toISODate();

  const plan = await db.weeklyPlan.findUnique({
    where: { weekStart },
    include: {
      jobs: {
        orderBy: { scheduledAt: "asc" },
        include: { account: true, assetVersion: { include: { asset: { include: { episode: true, series: true } } } } },
      },
    },
  });
  const jobs = plan?.jobs ?? [];
  const drafts = jobs.filter((j) => ["DRAFT", "BLOCKED"].includes(j.status));
  const ready = drafts.filter((j) => j.status === "DRAFT" && !j.excluded).length;
  const blocked = drafts.filter((j) => j.status === "BLOCKED" && !j.excluded).length;
  const approveKey = sp.key || randomUUID();
  const days = new Map<string, typeof jobs>();
  for (const j of jobs) {
    const d = DateTime.fromJSDate(j.scheduledAt, { zone: tz }).setLocale("ru").toFormat("cccc, d LLLL");
    days.set(d, [...(days.get(d) ?? []), j]);
  }
  const draftAssetIds = [...new Set(drafts.map((j) => j.assetVersion?.assetId).filter(Boolean))] as string[];
  const allVersions = draftAssetIds.length ? await db.assetVersion.findMany({ where: { assetId: { in: draftAssetIds } }, orderBy: { createdAt: "desc" } }) : [];
  const versionOptions = (assetId: string | undefined) => allVersions.filter((v) => v.assetId === assetId).slice(0, 5);

  return (
    <div>
      <PageHeader title={`Неделя ${monday.setLocale("ru").toFormat("d LLL")} – ${monday.plus({ days: 6 }).setLocale("ru").toFormat("d LLL yyyy")}`}>
        <Link href={`/plan?week=${prev}`} className="btn">←</Link>
        <Link href={`/plan?week=${next}`} className="btn">→</Link>
        <form action={buildWeekAction}>
          <input type="hidden" name="weekStart" value={weekStart.toISOString()} />
          <input type="hidden" name="week" value={weekParam} />
          <button className="btn">{jobs.length ? "Пересобрать" : "Собрать неделю"}</button>
        </form>
      </PageHeader>
      <Flash msg={sp.ok} />
      <Flash msg={sp.err} kind="err" />
      <p className="mb-4 text-xs muted">Время показано в поясе каждой строки, база — {tz}. Пересборка сохраняет ручные правки черновиков и не трогает утверждённые строки.</p>

      {drafts.length > 0 && (
        <div className="card mb-5 flex flex-wrap items-center gap-3 p-4">
          <div className="flex-1 text-sm">
            Готово к утверждению: <b>{ready}</b>
            {blocked > 0 && <> · заблокировано: <b className="text-red-600">{blocked}</b></>}
          </div>
          {sp.confirm && blocked > 0 ? (
            <form action={approveWeekAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="planId" value={plan!.id} />
              <input type="hidden" name="week" value={weekParam} />
              <input type="hidden" name="approveKey" value={approveKey} />
              <input type="hidden" name="allowPartial" value="true" />
              <span className="text-sm text-red-600">{blocked} строк заблокированы и не попадут в очередь.</span>
              <button className="btn btn-primary">Утвердить только готовые ({ready})</button>
            </form>
          ) : (
            <form action={approveWeekAction}>
              <input type="hidden" name="planId" value={plan!.id} />
              <input type="hidden" name="week" value={weekParam} />
              <input type="hidden" name="approveKey" value={approveKey} />
              <button className="btn btn-primary" disabled={ready === 0}>Утвердить неделю</button>
            </form>
          )}
        </div>
      )}

      {jobs.length === 0 ? (
        <Empty>План пуст. Нажмите «Собрать неделю»: черновик заполнится по включённым правилам.</Empty>
      ) : (
        <div className="space-y-5">
          {[...days.entries()].map(([day, list]) => (
            <section key={day}>
              <h2 className="mb-2 text-sm font-medium capitalize">{day}</h2>
              <div className="space-y-2">
                {list.map((j) => {
                  const asset = j.assetVersion?.asset;
                  const ep = asset?.episode;
                  const reasons = (j.blockReasons as string[] | null) ?? [];
                  const isDraft = ["DRAFT", "BLOCKED"].includes(j.status);
                  const versions = isDraft ? versionOptions(asset?.id) : [];
                  return (
                    <details key={j.id} className={`card ${j.excluded ? "opacity-50" : ""}`}>
                      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                        <span className="w-14 font-mono">{j.localTime.slice(11)}</span>
                        <span className="text-xs muted">{j.timezone.split("/").pop()}</span>
                        <PlatformTag platform={j.platform} />
                        <span className="font-medium">@{j.account.handle}</span>
                        <span className="muted">{FORMAT_LABEL[j.format]}</span>
                        <span className="min-w-0 flex-1 truncate">{asset?.series?.title}{ep ? ` · S${ep.season}E${ep.number}` : ""}</span>
                        <span className="text-xs muted">{j.visibility === "PUBLIC" ? "публично" : j.visibility === "UNLISTED" ? "по ссылке" : "приватно"}</span>
                        {j.excluded ? <span className="text-xs muted">исключено</span> : <StatusBadge status={j.status} />}
                      </summary>
                      <div className="border-t px-4 py-3 text-sm" style={{ borderColor: "var(--border)" }}>
                        {reasons.length > 0 && (
                          <ul className="mb-3 list-disc pl-5 text-red-600">{reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                        )}
                        <div className="mb-3 grid gap-1 text-xs muted md:grid-cols-3">
                          <div>Файл: {asset ? <a className="underline" target="_blank" href={`/api/media/${j.assetVersionId}`}>{asset.objectKey.split("/").slice(-3).join("/")}</a> : "нет"}</div>
                          <div>Длительность: {fmtDur(j.assetVersion?.durationSec)} · {j.assetVersion?.width ? `${j.assetVersion.width}×${j.assetVersion.height}` : "—"}</div>
                          <div>UTC: {j.scheduledAt.toISOString().slice(0, 16).replace("T", " ")}</div>
                          {((j.meta as any)?.aiDisclosure || (j.meta as any)?.paidPromotion || (j.meta as any)?.madeForKids) && (
                            <div className="md:col-span-3">Маркировка: {[(j.meta as any)?.aiDisclosure && "AI", (j.meta as any)?.paidPromotion && "промо", (j.meta as any)?.madeForKids && "для детей"].filter(Boolean).join(", ")}</div>
                          )}
                        </div>
                        {isDraft ? (
                          <form action={editDraftAction} className="grid gap-3 md:grid-cols-2">
                            <input type="hidden" name="id" value={j.id} />
                            <div><label className="label">Время ({j.timezone})</label><input type="datetime-local" name="localTime" defaultValue={j.localTime.replace(" ", "T")} className="input" /></div>
                            <div>
                              <label className="label">Версия файла</label>
                              <select name="assetVersionId" defaultValue={j.assetVersionId ?? ""} className="input">
                                <option value="">{j.assetVersionId ? "(без изменений)" : "— нет файла —"}</option>
                                {versions.map((v) => <option key={v.id} value={v.id}>{v.isCurrent ? "текущая" : "старая"} · {v.versionKey.slice(0, 18)}</option>)}
                              </select>
                            </div>
                            {j.title !== null && <div className="md:col-span-2"><label className="label">Заголовок</label><input name="title" defaultValue={j.title ?? ""} className="input" maxLength={100} /></div>}
                            <div className="md:col-span-2"><label className="label">Подпись</label><textarea name="caption" defaultValue={j.caption} rows={4} className="input" /></div>
                            <div>
                              <label className="label">Видимость</label>
                              <select name="visibility" defaultValue={j.visibility} className="input">
                                <option value="PUBLIC">Публично</option><option value="UNLISTED">По ссылке</option><option value="PRIVATE">Приватно</option>
                              </select>
                            </div>
                            {((j.meta as any)?.ambiguous || (j.meta as any)?.missing) && (
                              <label className="flex items-center gap-2 pt-5 text-sm text-amber-700"><input type="checkbox" name="timeConfirmed" /> Подтверждаю время при переходе часов</label>
                            )}
                            <div className="flex gap-2 md:col-span-2">
                              <button className="btn btn-primary">Сохранить</button>
                            </div>
                          </form>
                        ) : (
                          <p className="text-xs muted">Строка утверждена. Изменения — в разделе <Link href={`/publications/${j.id}`} className="underline">Публикации</Link>.</p>
                        )}
                        {isDraft && (
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <form action={toggleExcludeAction}><input type="hidden" name="id" value={j.id} /><button className="btn btn-sm">{j.excluded ? "Вернуть в план" : "Исключить"}</button></form>
                            {j.assetVersionId && (
                              <form action={generateCoverAction} className="flex items-center gap-1">
                                <input type="hidden" name="id" value={j.id} />
                                <input name="coverTitle" placeholder="текст на обложке" className="input w-44" />
                                <input name="atSec" type="number" step="0.5" defaultValue={1} title="секунда кадра" className="input w-16" />
                                <button className="btn btn-sm">Сгенерировать обложку</button>
                              </form>
                            )}
                            {j.coverKey && <a href={`/api/cover?k=${encodeURIComponent(j.coverKey)}`} target="_blank" className="text-xs underline">обложка</a>}
                          </div>
                        )}
                      </div>
                    </details>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

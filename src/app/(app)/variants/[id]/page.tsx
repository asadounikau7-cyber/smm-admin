import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { Flash, PageHeader, PlatformTag, StatusBadge, fmtDur, fmtSize } from "@/components/ui";
import { VariantBadge } from "@/components/variantStatus";
import { Editor } from "@/components/editor";
import { assignVariantAction, deleteVariantAction, rerenderVariantAction, saveVariantAction } from "@/app/variantActions";
import { normalizeRecipe } from "@/lib/recipe";

export default async function VariantPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const v = await db.videoVariant.findUnique({
    where: { id },
    include: {
      series: true, episode: true, account: true, template: true, sourceVersion: true, sourceAsset: true,
      output: { include: { versions: { orderBy: { createdAt: "desc" } } } },
    },
  });
  if (!v) notFound();
  const accounts = await db.socialAccount.findMany({ where: { status: { not: "DISABLED" } }, orderBy: [{ platform: "asc" }, { handle: "asc" }] });
  const cur = v.output?.versions.find((x) => x.isCurrent);
  const versionIds = v.output?.versions.map((x) => x.id) ?? [];
  const jobs = versionIds.length
    ? await db.publicationJob.findMany({ where: { assetVersionId: { in: versionIds } }, include: { account: true }, orderBy: { scheduledAt: "desc" } })
    : [];
  const tz = env().BASE_TIMEZONE;

  return (
    <div className="max-w-6xl">
      <PageHeader title={v.code}>
        <Link href={`/variants?series=${v.seriesId}`} className="btn">← Все версии</Link>
      </PageHeader>
      <Flash msg={sp.ok} />
      <Flash msg={sp.err} kind="err" />

      <div className="mb-5 grid gap-4 md:grid-cols-[1fr_300px]">
        <div className="card grid content-start gap-2 p-4 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <VariantBadge status={v.status} />
            <span>{v.series.title} · S{v.episode.season}E{v.episode.number} · {v.language.toUpperCase()} · версия {v.number}</span>
          </div>
          {v.error && <div className="text-red-600">{v.error}</div>}
          <div className="muted">
            Шаблон: {v.template ? <Link className="underline" href={`/templates/${v.template.id}`}>{v.template.name}</Link> : "без шаблона"} · Исходник: <span className="font-mono text-xs">{v.sourceAsset.objectKey}</span>
          </div>
          {cur && (
            <div className="muted">
              Собрано {v.renderedAt?.toLocaleString("ru-RU", { timeZone: tz })} ({v.renderer === "server" ? "на сервере" : "на компьютере"}) · {fmtDur(cur.durationSec)} · {cur.width}×{cur.height} · {fmtSize(cur.size)}
            </div>
          )}
          <form action={assignVariantAction} className="mt-2 flex flex-wrap items-end gap-2">
            <input type="hidden" name="id" value={v.id} />
            <label className="block">
              <span className="label">Аккаунт (одна версия — один аккаунт)</span>
              <select name="accountId" defaultValue={v.accountId ?? ""} className="input">
                <option value="">— запас, без аккаунта —</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.platform} · @{a.handle}</option>)}
              </select>
            </label>
            <button className="btn btn-sm">Сохранить</button>
          </form>
          <div className="mt-2 flex flex-wrap items-start gap-2">
            {cur && <a className="btn btn-sm" href={`/api/variants/${v.id}/file?download`}>Скачать MP4</a>}
            {(v.status === "READY" || v.status === "FAILED") && (
              <form action={rerenderVariantAction}>
                <input type="hidden" name="id" value={v.id} />
                <button className="btn btn-sm">Пересобрать</button>
              </form>
            )}
            <form action={deleteVariantAction}>
              <input type="hidden" name="id" value={v.id} />
              <button className="btn btn-sm btn-danger">Удалить версию</button>
            </form>
          </div>
          {jobs.length > 0 && (
            <div className="mt-3">
              <div className="label">Публикации этой версии</div>
              <ul className="space-y-1">
                {jobs.map((j) => (
                  <li key={j.id} className="flex flex-wrap items-center gap-2">
                    <PlatformTag platform={j.platform} /> @{j.account.handle} · {j.localTime} <StatusBadge status={j.status} />
                    <Link className="text-xs underline" href={`/publications/${j.id}`}>открыть</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="card p-3">
          <div className="label">Готовое видео</div>
          {cur ? (
            <video src={`/api/variants/${v.id}/file`} controls playsInline className="w-full rounded-lg bg-black" style={{ aspectRatio: "9 / 16" }} />
          ) : (
            <div className="flex items-center justify-center rounded-lg bg-black/80 text-sm text-white/70" style={{ aspectRatio: "9 / 16" }}>
              {v.status === "FAILED" ? "Сборка не удалась" : "Ещё собирается…"}
            </div>
          )}
        </div>
      </div>

      <h2 className="mb-3 font-semibold">Монтаж этой версии</h2>
      <Editor
        mode="variant"
        sources={[{ versionId: v.sourceVersionId, label: `S${v.episode.season}E${v.episode.number}`, durationSec: v.sourceVersion.durationSec }]}
        initialRecipe={normalizeRecipe(v.recipe)}
        action={saveVariantAction}
        hidden={{ id: v.id }}
        notes={v.notes ?? ""}
        submitLabel="Сохранить и пересобрать"
      />
    </div>
  );
}

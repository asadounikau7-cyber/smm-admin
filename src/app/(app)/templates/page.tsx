import Link from "next/link";
import { db } from "@/lib/db";
import { Empty, Flash, PageHeader } from "@/components/ui";
import { createTemplateAction } from "@/app/variantActions";
import { PRESETS, normalizeRecipe, normalizeVariation } from "@/lib/recipe";

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const sp = await searchParams;
  const templates = await db.editTemplate.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { variants: true } } } });
  return (
    <div className="max-w-5xl">
      <PageHeader title="Шаблоны монтажа">
        <form action={createTemplateAction}>
          <button className="btn btn-primary">+ Новый шаблон</button>
        </form>
      </PageHeader>
      <Flash msg={sp.ok} />
      <Flash msg={sp.err} kind="err" />
      <p className="mb-4 text-sm muted">
        Шаблон задаёт основу монтажа (обрезка, кадр, фильтр, текст) и диапазоны, в которых версии отличаются друг от друга. Из шаблона в разделе «Версии» делаются версии для аккаунтов. Оригиналы в B2 не меняются.
      </p>
      {templates.length === 0 ? (
        <Empty>Шаблонов пока нет. Создайте первый: например, «Крючок сверху + лёгкий зум».</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {templates.map((t) => {
            const r = normalizeRecipe(t.recipe);
            const v = normalizeVariation(t.variation);
            return (
              <Link key={t.id} href={`/templates/${t.id}`} className="card block p-4 hover:brightness-[.98]">
                <div className="font-medium">{t.name}</div>
                {t.notes && <div className="text-sm muted">{t.notes}</div>}
                <div className="mt-2 text-xs muted">
                  Основа: {PRESETS[r.preset]}, зум {r.zoom}, текстов {r.texts.length}
                  {v.presets?.length ? ` · фильтры: ${v.presets.map((p) => PRESETS[p]).join(", ")}` : ""}
                  {v.hookTexts?.length ? ` · крючков: ${v.hookTexts.length}` : ""}
                </div>
                <div className="mt-1 text-xs muted">Версий из шаблона: {t._count.variants}</div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

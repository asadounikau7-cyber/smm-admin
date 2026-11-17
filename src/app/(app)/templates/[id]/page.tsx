import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { Flash, PageHeader } from "@/components/ui";
import { Editor } from "@/components/editor";
import { deleteTemplateAction, saveTemplateAction } from "@/app/variantActions";
import { normalizeRecipe, normalizeVariation } from "@/lib/recipe";
import { editorSources } from "@/lib/editorSources";

export default async function TemplatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const t = await db.editTemplate.findUnique({ where: { id } });
  if (!t) notFound();
  const sources = await editorSources();
  return (
    <div className="max-w-6xl">
      <PageHeader title={`Шаблон: ${t.name}`}>
        <Link href="/templates" className="btn">← Все шаблоны</Link>
        <Link href={`/variants?template=${t.id}`} className="btn">Сделать версии</Link>
        <form action={deleteTemplateAction}>
          <input type="hidden" name="id" value={t.id} />
          <button className="btn btn-danger">Удалить</button>
        </form>
      </PageHeader>
      <Flash msg={sp.ok} />
      <Flash msg={sp.err} kind="err" />
      {sources.length === 0 && (
        <Flash kind="err" msg="Для предпросмотра нужен хотя бы один активный сериал с файлами (Каталог → включите сериал)." />
      )}
      <Editor
        mode="template"
        sources={sources}
        initialRecipe={normalizeRecipe(t.recipe)}
        initialVariation={normalizeVariation(t.variation)}
        action={saveTemplateAction}
        hidden={{ id: t.id }}
        name={t.name}
        notes={t.notes ?? ""}
        submitLabel="Сохранить шаблон"
      />
    </div>
  );
}

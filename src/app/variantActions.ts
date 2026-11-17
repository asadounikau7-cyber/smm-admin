"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { unlink } from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireOwner, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { DEFAULT_RECIPE, DEFAULT_VARIATION, normalizeRecipe, normalizeVariation } from "@/lib/recipe";
import { createVariants, updateVariantRecipe } from "@/lib/variants";
import { renderPath } from "@/lib/renderStore";

const s = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const json = (f: FormData, k: string) => {
  try {
    return JSON.parse(s(f, k) || "null");
  } catch {
    return null;
  }
};
const back = (path: string, msg: string, err = false) => redirect(`${path}${path.includes("?") ? "&" : "?"}${err ? "err" : "ok"}=${encodeURIComponent(msg)}`);

// ---------- templates ----------
export async function createTemplateAction() {
  const u = await requireOwner();
  const t = await db.editTemplate.create({
    data: { name: "Новый шаблон", recipe: DEFAULT_RECIPE as unknown as Prisma.InputJsonValue, variation: DEFAULT_VARIATION as unknown as Prisma.InputJsonValue },
  });
  await audit("template.create", "EditTemplate", t.id, u.id);
  redirect(`/templates/${t.id}`);
}

export async function saveTemplateAction(f: FormData) {
  const u = await requireOwner();
  const id = s(f, "id");
  const data = {
    name: s(f, "name") || "Шаблон",
    notes: s(f, "notes") || null,
    recipe: normalizeRecipe(json(f, "recipe")) as unknown as Prisma.InputJsonValue,
    variation: normalizeVariation(json(f, "variation")) as unknown as Prisma.InputJsonValue,
  };
  await db.editTemplate.update({ where: { id }, data });
  await audit("template.save", "EditTemplate", id, u.id);
  revalidatePath("/templates");
  back(`/templates/${id}`, "Шаблон сохранён");
}

export async function deleteTemplateAction(f: FormData) {
  const u = await requireOwner();
  const id = s(f, "id");
  await db.editTemplate.delete({ where: { id } });
  await audit("template.delete", "EditTemplate", id, u.id);
  back("/templates", "Шаблон удалён. Уже созданные версии остались");
}

// ---------- versions ----------
export async function createVariantsAction(f: FormData) {
  const u = await requireUser();
  const seriesId = s(f, "seriesId");
  if (!seriesId) back("/variants", "Выберите сериал", true);
  const episodes = s(f, "episodes")
    .split(/[\s,;]+/)
    .flatMap((x) => {
      const m = /^(\d+)-(\d+)$/.exec(x);
      if (!m) return x ? [x] : [];
      const out: string[] = [];
      for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(String(i));
      return out;
    });
  const accountIds = f.getAll("accountIds").map(String).filter(Boolean);
  const pool = Math.min(200, Math.max(0, Number(s(f, "pool") || 0)));
  if (!accountIds.length && !pool) back("/variants", "Отметьте аккаунты или укажите, сколько версий сделать в запас", true);
  const r = await createVariants({ templateId: s(f, "templateId") || null, seriesId, episodes, accountIds, pool });
  await audit("variants.create", "Series", seriesId, u.id, { created: r.created, alreadyHad: r.alreadyHad, noSource: r.noSource });
  revalidatePath("/variants");
  if (r.created === 1 && s(f, "open") === "1") redirect(`/variants/${r.ids[0]}`);
  const parts = [`Создано версий: ${r.created}. Они собираются по очереди`];
  if (r.alreadyHad) parts.push(`у ${r.alreadyHad} пар «серия × аккаунт» версия уже была`);
  if (r.noSource.length) parts.push(`нет исходника: ${r.noSource.join(", ")}`);
  back(`/variants?series=${seriesId}`, parts.join("; "), r.created === 0);
}

export async function saveVariantAction(f: FormData) {
  const u = await requireUser();
  const id = s(f, "id");
  try {
    await updateVariantRecipe(id, normalizeRecipe(json(f, "recipe")));
  } catch (e) {
    back(`/variants/${id}`, (e as Error).message, true);
  }
  if (s(f, "notes") !== undefined) await db.videoVariant.update({ where: { id }, data: { notes: s(f, "notes") || null } });
  await audit("variant.edit", "VideoVariant", id, u.id);
  back(`/variants/${id}`, "Сохранено, версия поставлена на пересборку");
}

export async function assignVariantAction(f: FormData) {
  const u = await requireUser();
  const id = s(f, "id");
  const accountId = s(f, "accountId") || null;
  const v = await db.videoVariant.findUniqueOrThrow({ where: { id } });
  if (accountId) {
    const other = await db.videoVariant.findFirst({ where: { episodeId: v.episodeId, accountId, id: { not: id } } });
    if (other) back(`/variants/${id}`, `У этого аккаунта уже есть версия этой серии: ${other.code}. Сначала отвяжите её`, true);
  }
  await db.videoVariant.update({ where: { id }, data: { accountId } });
  await audit("variant.assign", "VideoVariant", id, u.id, { accountId });
  back(`/variants/${id}`, accountId ? "Версия закреплена за аккаунтом" : "Версия отвязана от аккаунта");
}

export async function rerenderVariantAction(f: FormData) {
  await requireUser();
  const ids = f.getAll("id").map(String);
  await db.videoVariant.updateMany({ where: { id: { in: ids }, status: { in: ["FAILED", "READY"] } }, data: { status: "PENDING", attempts: 0, error: null, leaseUntil: null } });
  const to = s(f, "back") || (ids.length === 1 ? `/variants/${ids[0]}` : "/variants");
  back(to, "Поставлено на пересборку");
}

export async function deleteVariantAction(f: FormData) {
  const u = await requireOwner();
  const id = s(f, "id");
  const v = await db.videoVariant.findUniqueOrThrow({ where: { id }, include: { output: { include: { versions: true } } } });
  const versionIds = v.output?.versions.map((x) => x.id) ?? [];
  const used = versionIds.length ? await db.publicationJob.count({ where: { assetVersionId: { in: versionIds }, status: { not: "CANCELLED" } } }) : 0;
  if (used) back(`/variants/${id}`, `Версия уже стоит в ${used} публикациях. Отмените их или оставьте версию`, true);
  await db.publicationJob.updateMany({ where: { assetVersionId: { in: versionIds } }, data: { assetVersionId: null } });
  await db.videoVariant.delete({ where: { id } });
  for (const x of v.output?.versions ?? []) await unlink(renderPath(x.versionKey)).catch(() => {});
  await audit("variant.delete", "VideoVariant", id, u.id, { code: v.code });
  back(`/variants?series=${v.seriesId}`, `Версия ${v.code} удалена`);
}

export async function setRenderModeAction(f: FormData) {
  await requireOwner();
  const mode = ["auto", "agent", "server"].includes(s(f, "mode")) ? s(f, "mode") : "auto";
  await db.setting.upsert({ where: { key: "renderMode" }, update: { value: mode }, create: { key: "renderMode", value: mode } });
  back("/variants", "Режим сборки сохранён");
}

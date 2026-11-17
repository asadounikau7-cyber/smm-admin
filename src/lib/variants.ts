import { Prisma } from "@prisma/client";
import { db } from "./db";
import { DEFAULT_RECIPE, generateRecipes, normalizeRecipe, normalizeVariation, recipeSignature, variantCode, type Recipe } from "./recipe";

/** Source file of an episode for editing: a vertical cut if there is one, else the full episode. */
export async function sourceFor(episodeId: string, language = "en") {
  const assets = await db.asset.findMany({
    where: { episodeId, deletedAt: null, renderOfId: null, kind: { in: ["VERTICAL", "FULL_EPISODE"] } },
    include: { versions: { where: { isCurrent: true } } },
  });
  const ok = assets.filter((a) => a.versions.length);
  const byLang = ok.filter((a) => (a.language ?? "en") === language);
  const pool = byLang.length ? byLang : ok;
  const a = pool.find((x) => x.kind === "VERTICAL") ?? pool[0];
  return a ? { asset: a, version: a.versions[0] } : null;
}

export type CreateVariantsInput = {
  templateId: string | null;
  seriesId: string;
  /** Episode numbers (season 1 unless given as "2:3"); empty = all */
  episodes: string[];
  accountIds: string[];
  /** Extra versions per episode not given to anyone yet */
  pool: number;
};

/**
 * Makes versions for each episode × account (skipping accounts that already have one for that episode),
 * plus `pool` spare ones. All versions of one episode differ (signature is unique per episode).
 */
export async function createVariants(input: CreateVariantsInput) {
  const series = await db.series.findUniqueOrThrow({ where: { id: input.seriesId }, include: { episodes: { orderBy: [{ season: "asc" }, { number: "asc" }] } } });
  const tpl = input.templateId ? await db.editTemplate.findUnique({ where: { id: input.templateId } }) : null;
  const base = normalizeRecipe(tpl?.recipe ?? DEFAULT_RECIPE);
  const variation = normalizeVariation(tpl?.variation ?? {});
  const accounts = input.accountIds.length ? await db.socialAccount.findMany({ where: { id: { in: input.accountIds } } }) : [];
  const want = new Set(input.episodes.map((e) => (e.includes(":") ? e : `1:${e}`)));
  const episodes = want.size ? series.episodes.filter((e) => want.has(`${e.season}:${e.number}`)) : series.episodes;

  const res = { created: 0, alreadyHad: 0, noSource: [] as string[], ids: [] as string[] };
  for (const ep of episodes) {
    const existing = await db.videoVariant.findMany({ where: { episodeId: ep.id }, select: { accountId: true, signature: true, language: true, number: true } });
    const has = new Set(existing.map((v) => v.accountId).filter(Boolean));
    const targets: { accountId: string | null; language: string }[] = [];
    for (const a of accounts) {
      if (has.has(a.id)) res.alreadyHad++;
      else targets.push({ accountId: a.id, language: (a.language || "en").toLowerCase() });
    }
    for (let i = 0; i < input.pool; i++) targets.push({ accountId: null, language: "en" });
    if (!targets.length) continue;

    const src = await sourceFor(ep.id, targets[0].language);
    if (!src) {
      res.noSource.push(`S${ep.season}E${ep.number}`);
      continue;
    }
    const recipes = generateRecipes(base, variation, targets.length, `${tpl?.id ?? "default"}|${ep.id}|${existing.length}`, new Set(existing.map((v) => v.signature)));
    const nextNum = new Map<string, number>();
    for (const v of existing) nextNum.set(v.language, Math.max(nextNum.get(v.language) ?? 0, v.number));

    for (let i = 0; i < Math.min(targets.length, recipes.length); i++) {
      const t = targets[i];
      const num = (nextNum.get(t.language) ?? 0) + 1;
      nextNum.set(t.language, num);
      const v = await db.videoVariant.create({
        data: {
          code: variantCode(series.slug, ep.season, ep.number, t.language, num),
          number: num,
          language: t.language,
          seriesId: series.id,
          episodeId: ep.id,
          sourceAssetId: src.asset.id,
          sourceVersionId: src.version.id,
          templateId: tpl?.id ?? null,
          recipe: recipes[i].recipe as unknown as Prisma.InputJsonValue,
          signature: recipes[i].signature,
          accountId: t.accountId,
        },
      });
      res.created++;
      res.ids.push(v.id);
    }
  }
  return res;
}

/** Saves an edited recipe; refuses if another version of the same episode already looks exactly like this. */
export async function updateVariantRecipe(id: string, recipe: Recipe) {
  const r = normalizeRecipe(recipe);
  const signature = recipeSignature(r);
  const v = await db.videoVariant.findUniqueOrThrow({ where: { id } });
  const dup = await db.videoVariant.findFirst({ where: { episodeId: v.episodeId, signature, id: { not: id } } });
  if (dup) throw new Error(`Точно такая же версия уже есть: ${dup.code}`);
  return db.videoVariant.update({
    where: { id },
    data: { recipe: r as unknown as Prisma.InputJsonValue, signature, status: "PENDING", attempts: 0, error: null, leaseUntil: null },
  });
}

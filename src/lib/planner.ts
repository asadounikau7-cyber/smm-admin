import { isManual } from "./adapters";
import { createHash } from "node:crypto";
import { Prisma, type Asset, type AssetVersion, type Episode, type ReleaseRule, type Series, type SocialAccount } from "@prisma/client";
import { db } from "./db";
import { env } from "./env";
import { renderCaption } from "./caption";
import { resolveSlot, toLocal, type Slot } from "./time";
import { FORMAT_PLATFORM, VALIDATORS, validate } from "./validators";
import { audit } from "./audit";

type RuleFull = ReleaseRule & { series: Series & { episodes: Episode[] }; account: SocialAccount };
type AssetWithVersion = Asset & { versions: AssetVersion[] };

const DRAFT_STATES = ["DRAFT", "BLOCKED"] as const;
const isDraft = (s: string) => (DRAFT_STATES as readonly string[]).includes(s);

type Candidate = {
  rule: RuleFull;
  instanceKey: string;
  slotKey: string;
  scheduledAt: Date;
  timezone: string;
  ambiguous: boolean;
  missing: boolean;
  episode: Episode | null;
  asset: AssetWithVersion | null;
  extraReasons: string[];
};

/** Episode 1 sent to the main channel after a successful YouTube test counts as published there. */
function isLaunchOn(j: { ruleId: string | null; accountId: string; meta: Prisma.JsonValue }, accountId: string) {
  return j.ruleId == null && j.accountId === accountId && (j.meta as { purpose?: string } | null)?.purpose === "launch";
}

export function idemKey(planId: string, accountId: string, instanceKey: string) {
  return createHash("sha1").update(`${planId}|${accountId}|${instanceKey}`).digest("hex");
}

async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const s = await db.setting.findUnique({ where: { key } });
  return (s?.value as T) ?? fallback;
}

export async function getOrCreatePlan(weekStart: Date) {
  return db.weeklyPlan.upsert({
    where: { weekStart },
    update: {},
    create: { weekStart, timezone: env().BASE_TIMEZONE },
  });
}

function currentVersion(a: AssetWithVersion | null) {
  return a?.versions.find((v) => v.isCurrent) ?? null;
}

/**
 * «Собрать неделю»: fills the draft from the rules. Keeps manual edits in drafts and
 * never touches approved rows. Returns the plan id.
 */
export async function buildWeek(weekStart: Date, userId: string | null) {
  const plan = await getOrCreatePlan(weekStart);
  const rules = (await db.releaseRule.findMany({
    where: { enabled: true, series: { bannedAt: null } },
    include: { series: { include: { episodes: { orderBy: [{ season: "asc" }, { number: "asc" }] } } }, account: true },
    orderBy: { createdAt: "asc" },
  })) as RuleFull[];

  const assets = (await db.asset.findMany({
    where: { deletedAt: null, needsMapping: false, renderOfId: null },
    include: { versions: { where: { isCurrent: true } } },
  })) as AssetWithVersion[];

  // Edited versions given to accounts: an account publishes its own version of the episode when it has one.
  const variants = await db.videoVariant.findMany({
    where: { accountId: { in: [...new Set(rules.map((r) => r.accountId))] } },
    include: { output: { include: { versions: { where: { isCurrent: true } } } } },
  });
  const variantFor = new Map(variants.map((v) => [`${v.episodeId}|${v.accountId}`, v]));

  const existing = await db.publicationJob.findMany({ where: { planId: plan.id } });
  const approvedHere = existing.filter((j) => !isDraft(j.status));
  const usedElsewhere = await db.publicationJob.findMany({
    where: { planId: { not: plan.id }, status: { not: "CANCELLED" } },
    select: { ruleId: true, accountId: true, instanceKey: true, meta: true },
  });

  const candidates: Candidate[] = [];
  const findAsset = (seriesId: string, episodeId: string | null, kind: string, lang: string) =>
    assets.find((a) => a.seriesId === seriesId && a.episodeId === episodeId && a.kind === kind && a.language === lang && currentVersion(a)) ?? null;

  // Pass 1: slot-based rules (episodes and stand-alone teasers).
  for (const rule of rules.filter((r) => r.offsetMinutes == null || !r.offsetFromRuleId)) {
    const slots = (rule.slots as Slot[]) ?? [];
    const resolved = slots
      .map((s) => ({ s, r: resolveSlot(weekStart, s, rule.timezone) }))
      // Slots that have already passed this week get nothing: the next episode goes to the next free slot.
      .filter(({ r }) => r.utc.getTime() > Date.now() + 15 * 60_000)
      .sort((a, b) => a.r.utc.getTime() - b.r.utc.getTime());
    const occupied = new Set(approvedHere.filter((j) => j.ruleId === rule.id).map((j) => (j.meta as { slotKey?: string } | null)?.slotKey));

    if (rule.assetKind === "TEASER" && !rule.offsetFromRuleId) {
      const teasers = assets.filter((a) => a.seriesId === rule.seriesId && a.kind === "TEASER" && a.language === rule.language && currentVersion(a));
      const useCount = new Map<string, number>();
      for (const j of [...usedElsewhere, ...approvedHere])
        if (j.ruleId === rule.id) {
          const id = (j.meta as { assetId?: string } | null)?.assetId;
          if (id) useCount.set(id, (useCount.get(id) ?? 0) + 1);
        }
      for (const { s, r } of resolved) {
        const slotKey = `${s.weekday}-${s.time}`;
        if (occupied.has(slotKey)) continue;
        const pick = [...teasers].sort((a, b) => (useCount.get(a.id) ?? 0) - (useCount.get(b.id) ?? 0))[0] ?? null;
        if (pick) useCount.set(pick.id, (useCount.get(pick.id) ?? 0) + 1);
        candidates.push({
          rule, instanceKey: `${rule.id}:slot:${weekStart.toISOString().slice(0, 10)}:${slotKey}`, slotKey,
          scheduledAt: r.utc, timezone: rule.timezone, ambiguous: r.ambiguous, missing: r.missing,
          episode: pick?.episodeId ? rule.series.episodes.find((e) => e.id === pick.episodeId) ?? null : null,
          asset: pick, extraReasons: pick ? [] : ["Нет анонсов для этого сериала и языка"],
        });
      }
      continue;
    }

    // Episodic: next episodes in order.
    const done = new Set(
      [...usedElsewhere, ...approvedHere]
        .filter((j) => j.ruleId === rule.id || isLaunchOn(j, rule.accountId))
        .map((j) => j.instanceKey.split(":ep:")[1])
        .filter(Boolean),
    );
    const queue = rule.series.episodes.slice(0, rule.maxEpisodes ?? undefined).filter((e) => !done.has(e.id));
    let stopped = false;
    for (const { s, r } of resolved) {
      const slotKey = `${s.weekday}-${s.time}`;
      if (occupied.has(slotKey) || stopped) continue;
      let placed = false;
      while (queue.length && !placed) {
        const ep = queue.shift()!;
        const asset = findAsset(rule.seriesId, ep.id, rule.assetKind, rule.language);
        if (!asset && !rule.strictOrder) continue; // skip a missing episode when order is not required
        candidates.push({
          rule, instanceKey: `${rule.id}:ep:${ep.id}`, slotKey, scheduledAt: r.utc, timezone: rule.timezone,
          ambiguous: r.ambiguous, missing: r.missing, episode: ep, asset,
          extraReasons: asset ? [] : [`Нет файла для S${ep.season}E${ep.number} (${rule.language}). Порядок обязателен: очередь серий остановлена`],
        });
        placed = true;
        if (!asset) stopped = true;
      }
      if (!placed) break;
    }
  }

  // Pass 2: rules with an offset from another rule's episode release.
  for (const rule of rules.filter((r) => r.offsetMinutes != null && r.offsetFromRuleId)) {
    const releases = [
      ...candidates.filter((c) => c.rule.id === rule.offsetFromRuleId && c.episode).map((c) => ({ ep: c.episode!, at: c.scheduledAt })),
      ...approvedHere
        .filter((j) => j.ruleId === rule.offsetFromRuleId && j.instanceKey.includes(":ep:"))
        .map((j) => ({ ep: rule.series.episodes.find((e) => e.id === j.instanceKey.split(":ep:")[1])!, at: j.scheduledAt }))
        .filter((x) => x.ep),
    ];
    const approvedKeys = new Set(approvedHere.filter((j) => j.ruleId === rule.id).map((j) => j.instanceKey));
    for (const rel of releases) {
      const instanceKey = `${rule.id}:ep:${rel.ep.id}`;
      if (approvedKeys.has(instanceKey)) continue;
      const at = new Date(rel.at.getTime() + rule.offsetMinutes! * 60_000);
      const asset =
        findAsset(rule.seriesId, rel.ep.id, rule.assetKind, rule.language) ??
        (rule.assetKind === "TEASER" ? findAsset(rule.seriesId, null, "TEASER", rule.language) : null);
      candidates.push({
        rule, instanceKey, slotKey: `offset:${rel.ep.id}`, scheduledAt: at, timezone: rule.timezone,
        ambiguous: false, missing: false, episode: rel.ep, asset,
        extraReasons: asset ? [] : [`Нет анонса для S${rel.ep.season}E${rel.ep.number} (${rule.language})`],
      });
    }
  }

  const rightsRequired = await getSetting<boolean>("requireRights", false);
  const ytDailyLimit = await getSetting<number>("youtubeDailyUploads", 6);
  const now = Date.now();
  const keep = new Set<string>();

  await db.$transaction(async (tx) => {
    for (const c of candidates) {
      const key = `${c.rule.accountId}|${c.instanceKey}`;
      keep.add(key);
      const prev = existing.find((j) => j.accountId === c.rule.accountId && j.instanceKey === c.instanceKey);
      if (prev && !isDraft(prev.status)) continue;

      const series = c.rule.series;
      let ver = currentVersion(c.asset);
      const reasons = [...c.extraReasons];
      const variant = c.episode && c.rule.assetKind !== "TEASER" ? variantFor.get(`${c.episode.id}|${c.rule.accountId}`) : undefined;
      if (variant) {
        const out = variant.output?.versions[0];
        if (variant.status === "READY" && out) ver = out;
        else reasons.push(`Версия ${variant.code} ещё не собрана (${variant.status === "FAILED" ? "ошибка сборки" : "в очереди"})`);
      } else if (c.rule.requireVariant && c.episode) {
        reasons.push(`Нет своей версии S${c.episode.season}E${c.episode.number} для @${c.rule.account.handle}`);
      }
      const vars = { title: c.episode?.title ?? series.title, series: series.title, season: c.episode?.season, episode: c.episode?.number, cta: c.rule.cta, hashtags: c.rule.hashtags ?? series.hashtags };
      const caption = renderCaption(c.rule.captionTemplate, vars);
      const title =
        FORMAT_PLATFORM[c.rule.format] === "YOUTUBE"
          ? c.episode && c.rule.assetKind !== "TEASER"
            ? `${series.title} — S${String(c.episode.season).padStart(2, "0")}E${String(c.episode.number).padStart(2, "0")}${c.episode.title ? ` · ${c.episode.title}` : ""}`
            : `${series.title} — анонс`
          : null;

      const data = {
        ruleId: c.rule.id,
        accountId: c.rule.accountId,
        assetVersionId: ver?.id ?? null,
        platform: c.rule.account.platform,
        format: c.rule.format,
        visibility: c.rule.visibility,
        scheduledAt: c.scheduledAt,
        localTime: toLocal(c.scheduledAt, c.timezone),
        timezone: c.timezone,
        deadlineAt: new Date(c.scheduledAt.getTime() + env().CATCHUP_WINDOW_MIN * 60_000),
        caption,
        title,
        meta: {
          slotKey: c.slotKey,
          assetId: c.asset?.id ?? null,
          episodeId: c.episode?.id ?? null,
          validator: VALIDATORS[c.rule.format].version,
          ambiguous: c.ambiguous,
          missing: c.missing,
          madeForKids: c.rule.madeForKids,
          aiDisclosure: c.rule.aiDisclosure,
          paidPromotion: c.rule.paidPromotion,
          extraReasons: reasons,
          variantId: variant?.id ?? null,
          variantCode: variant?.code ?? null,
        } satisfies Prisma.InputJsonValue,
      };

      if (prev?.manualEdit) {
        // Keep the owner's edits: only refresh the file if it was missing.
        await tx.publicationJob.update({ where: { id: prev.id }, data: { assetVersionId: prev.assetVersionId ?? data.assetVersionId } });
      } else if (prev) {
        await tx.publicationJob.update({ where: { id: prev.id }, data });
      } else {
        await tx.publicationJob.create({
          data: { ...data, planId: plan.id, instanceKey: c.instanceKey, idempotencyKey: idemKey(plan.id, c.rule.accountId, c.instanceKey) },
        });
      }
    }
    // Drop draft rows that no longer come from any rule (manual edits stay).
    for (const j of existing)
      if (isDraft(j.status) && !j.manualEdit && !keep.has(`${j.accountId}|${j.instanceKey}`))
        await tx.publicationJob.delete({ where: { id: j.id } });
  });

  await revalidatePlan(plan.id, { rightsRequired, ytDailyLimit, now });
  await audit("plan.build", "WeeklyPlan", plan.id, userId, { candidates: candidates.length });
  return plan.id;
}

/** Re-runs the checks on all draft rows of the plan and sets DRAFT / BLOCKED. */
export async function revalidatePlan(planId: string, opts?: { rightsRequired?: boolean; ytDailyLimit?: number; now?: number }) {
  const rightsRequired = opts?.rightsRequired ?? (await getSetting<boolean>("requireRights", false));
  const ytDailyLimit = opts?.ytDailyLimit ?? (await getSetting<number>("youtubeDailyUploads", 6));
  const now = opts?.now ?? Date.now();
  const jobs = await db.publicationJob.findMany({
    where: { planId },
    include: { account: true, assetVersion: { include: { asset: true } } },
    orderBy: { scheduledAt: "asc" },
  });
  const ytPerDay = new Map<string, number>();
  for (const j of jobs) {
    if (j.excluded || j.platform !== "YOUTUBE") continue;
    const d = j.scheduledAt.toISOString().slice(0, 10);
    ytPerDay.set(d, (ytPerDay.get(d) ?? 0) + 1);
  }
  for (const j of jobs) {
    if (!isDraft(j.status)) continue;
    const meta = (j.meta ?? {}) as { extraReasons?: string[]; ambiguous?: boolean; missing?: boolean; timeConfirmed?: boolean };
    const reasons = [
      ...(meta.extraReasons ?? []),
      ...validate({
        format: j.format,
        account: j.account,
        version: j.assetVersion ? { ...j.assetVersion, deleted: Boolean(j.assetVersion.asset.deletedAt) } : null,
        caption: j.caption,
        title: j.title,
        rightsRequired,
        rightsConfirmed: j.assetVersion?.asset.rightsConfirmed,
        ambiguousTime: meta.ambiguous && !meta.timeConfirmed,
        missingTime: meta.missing && !meta.timeConfirmed,
      }),
    ];
    if (j.scheduledAt.getTime() < now) reasons.push("Время публикации уже прошло — перенесите");
    const conflict = jobs.find(
      (o) => o.id !== j.id && !o.excluded && o.accountId === j.accountId && Math.abs(o.scheduledAt.getTime() - j.scheduledAt.getTime()) < 60_000 && o.status !== "CANCELLED",
    );
    if (conflict) reasons.push(`Конфликт: на @${j.account.handle} уже есть публикация в это время`);
    if (j.platform === "YOUTUBE" && (ytPerDay.get(j.scheduledAt.toISOString().slice(0, 10)) ?? 0) > ytDailyLimit)
      reasons.push(`Превышена дневная квота YouTube API (${ytDailyLimit} загрузок)`);
    const status = reasons.length ? "BLOCKED" : "DRAFT";
    await db.publicationJob.update({ where: { id: j.id }, data: { status, blockReasons: reasons } });
  }
}

export type ApproveResult =
  | { ok: true; queued: number; manual: number; skippedBlocked: number; replay: boolean }
  | { ok: false; needsConfirm: true; blocked: { id: string; reasons: string[] }[] };

/**
 * «Утвердить неделю». One transaction with a row lock on the plan, so two concurrent
 * approvals can't double-queue. Same approveKey returns the earlier result.
 */
export async function approveWeek(planId: string, userId: string, approveKey: string, allowPartial: boolean): Promise<ApproveResult> {
  await revalidatePlan(planId);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "WeeklyPlan" WHERE id = ${planId} FOR UPDATE`;
    const plan = await tx.weeklyPlan.findUniqueOrThrow({ where: { id: planId } });
    if (plan.approveKey === approveKey) {
      const ev = await tx.auditEvent.findFirst({ where: { entity: "WeeklyPlan", entityId: planId, action: "plan.approve" }, orderBy: { createdAt: "desc" } });
      const d = (ev?.data ?? {}) as { queued?: number; manual?: number; skippedBlocked?: number };
      return { ok: true, queued: d.queued ?? 0, manual: d.manual ?? 0, skippedBlocked: d.skippedBlocked ?? 0, replay: true };
    }
    const drafts = await tx.publicationJob.findMany({
      where: { planId, excluded: false, status: { in: ["DRAFT", "BLOCKED"] } },
      include: { account: true },
    });
    const blocked = drafts.filter((d) => d.status === "BLOCKED");
    if (blocked.length && !allowPartial)
      return { ok: false, needsConfirm: true, blocked: blocked.map((b) => ({ id: b.id, reasons: (b.blockReasons as string[]) ?? [] })) };

    let queued = 0;
    let manual = 0;
    for (const j of drafts.filter((d) => d.status === "DRAFT")) {
      const manualTikTok = isManual(j.account);
      await tx.publicationJob.update({
        where: { id: j.id },
        data: { status: manualTikTok ? "ACTION_REQUIRED" : "QUEUED", rowVersion: { increment: 1 }, errorCode: manualTikTok ? "MANUAL" : null, errorMessage: manualTikTok ? "Поставьте пост в TikTok Studio по пакету" : null },
      });
      manualTikTok ? manual++ : queued++;
    }
    await tx.weeklyPlan.update({ where: { id: planId }, data: { status: "APPROVED", approvedAt: new Date(), approvedById: userId, approveKey } });
    const result = { queued, manual, skippedBlocked: blocked.length };
    await audit("plan.approve", "WeeklyPlan", planId, userId, result, tx);
    return { ok: true, ...result, replay: false };
  });
}

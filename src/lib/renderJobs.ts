import path from "node:path";
import { tmpdir } from "node:os";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { db } from "./db";
import { probe, run } from "./media";
import { mediaUrl } from "./mediaSource";
import { buildFrame, buildRender, normalizeRecipe } from "./recipe";
import { FONT_FILE, storeRender } from "./renderStore";
import { notify } from "./notify";

const LEASE_MIN = 30;
const MAX_ATTEMPTS = 3;
export type RenderMode = "auto" | "agent" | "server";

export async function getRenderMode(): Promise<RenderMode> {
  const s = await db.setting.findUnique({ where: { key: "renderMode" } });
  const v = s?.value as RenderMode | undefined;
  return v === "agent" || v === "server" ? v : "auto";
}

/** An agent that can render has polled within the last 90 seconds. */
export async function agentRenderOnline() {
  const s = await db.setting.findUnique({ where: { key: "agentHeartbeat" } });
  const v = s?.value as { at?: string; render?: boolean } | undefined;
  return Boolean(v?.render && v.at && Date.now() - new Date(v.at).getTime() < 90_000);
}

/** Takes the oldest waiting version (or one whose renderer went silent). Safe with several renderers. */
export async function claimRender(renderer: string): Promise<string | null> {
  await db.videoVariant.updateMany({
    where: { status: "RENDERING", leaseUntil: { lt: new Date() }, attempts: { gte: MAX_ATTEMPTS } },
    data: { status: "FAILED", error: "Сборка не завершилась за 3 попытки", leaseUntil: null },
  });
  const now = new Date();
  const lease = new Date(now.getTime() + LEASE_MIN * 60_000);
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "VideoVariant" SET status = 'RENDERING', "leaseUntil" = ${lease},
      renderer = ${renderer}, attempts = attempts + 1, "updatedAt" = ${now}
    WHERE id = (
      SELECT id FROM "VideoVariant"
      WHERE status = 'PENDING' OR (status = 'RENDERING' AND "leaseUntil" < ${now})
      ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    ) RETURNING id`;
  return rows[0]?.id ?? null;
}

async function loadVariant(id: string) {
  const v = await db.videoVariant.findUniqueOrThrow({ where: { id }, include: { sourceAsset: true, sourceVersion: true, account: true } });
  let sv = v.sourceVersion;
  if (!sv.probedAt) {
    const p = await probe(await mediaUrl(v.sourceAsset, sv, 600, { internal: true }));
    sv = await db.assetVersion.update({ where: { id: sv.id }, data: { ...p, probedAt: new Date() } });
  }
  // {handle} in a text becomes the account's @handle, so one template can sign every account's video;
  // {hook} becomes the series' one-line plot hook (its name when there's none).
  const series = await db.series.findUnique({ where: { id: v.seriesId }, select: { title: true, hookTitle: true } });
  const recipe = normalizeRecipe(v.recipe);
  recipe.texts = recipe.texts
    .map((t) => ({ ...t, text: t.text.replaceAll("{handle}", v.account?.handle ?? "").replaceAll("{hook}", series?.hookTitle || series?.title || "") }))
    .filter((t) => t.text.replace("@", "").trim());
  return { ...v, sourceVersion: sv, recipe };
}

/** Everything an agent needs to render one version: inputs to download, text files, ffmpeg args. */
export async function renderTask(id: string, appUrl: string) {
  const v = await loadVariant(id);
  const plan = buildRender(v.recipe, { durationSec: v.sourceVersion.durationSec, hasAudio: Boolean(v.sourceVersion.audioCodec) }, "medium");
  return {
    variantId: v.id,
    code: v.code,
    inputs: [
      { name: "in0.mp4", url: await mediaUrl(v.sourceAsset, v.sourceVersion, 6 * 3600) },
      { name: "font.ttf", url: `${appUrl}/api/agent/font` },
    ],
    files: plan.files,
    args: plan.args,
    output: plan.output,
    uploadUrl: `${appUrl}/api/agent/render/${v.id}`,
  };
}

export async function failRender(id: string, error: string) {
  const v = await db.videoVariant.findUnique({ where: { id } });
  if (!v) return;
  const final = v.attempts >= MAX_ATTEMPTS;
  await db.videoVariant.update({
    where: { id },
    data: { status: final ? "FAILED" : "PENDING", error: error.slice(0, 500), leaseUntil: null },
  });
  if (final) await notify(`render:${id}`, "render_failed", `Версия ${v.code} не собралась: ${error.slice(0, 200)}`, `/variants/${id}`);
}

async function withWorkdir<T>(files: Record<string, string>, fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(path.join(tmpdir(), "render-"));
  try {
    await copyFile(FONT_FILE, path.join(dir, "font.ttf"));
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, path.basename(name)), content, "utf8");
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function ffmpegIn(dir: string, args: string[], input: string, timeoutMs: number) {
  const a = args.map((x) => (x === "in0.mp4" ? input : x));
  const r = await run("ffmpeg", a, timeoutMs, dir);
  if (r.code !== 0) throw new Error(`ffmpeg: ${r.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
}

/** Renders on this server (slow on 1 vCPU, used when no agent is online). */
export async function renderOnServer(id: string) {
  try {
    const v = await loadVariant(id);
    const plan = buildRender(v.recipe, { durationSec: v.sourceVersion.durationSec, hasAudio: Boolean(v.sourceVersion.audioCodec) }, "veryfast");
    const input = await mediaUrl(v.sourceAsset, v.sourceVersion, 6 * 3600, { internal: true });
    await withWorkdir(plan.files, async (dir) => {
      await ffmpegIn(dir, plan.args, input, 40 * 60_000);
      await storeRender(id, path.join(dir, plan.output), "server");
    });
  } catch (e) {
    await failRender(id, (e as Error).message);
  }
}

/** One exact output frame as JPEG, for the editor. */
export async function renderFrame(versionId: string, recipe: unknown, outT: number): Promise<Buffer> {
  const v = await db.assetVersion.findUniqueOrThrow({ where: { id: versionId }, include: { asset: true } });
  const plan = buildFrame(normalizeRecipe(recipe), outT, v.durationSec);
  const input = await mediaUrl(v.asset, v, 600, { internal: true });
  return withWorkdir(plan.files, async (dir) => {
    await ffmpegIn(dir, plan.args, input, 60_000);
    return readFile(path.join(dir, plan.output));
  });
}

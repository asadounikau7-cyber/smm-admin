import { db } from "./db";
import { decryptJson, encryptJson } from "./crypto";
import { setEnvOverrides, type Env } from "./env";

/** Keys the owner can enter in «Настройки» instead of editing .env on the server. */
export const INTEGRATION_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "UPLOAD_POST_API_KEY", "B2_KEY_ID", "B2_APP_KEY"] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];
const SETTING = "integrationKeys";
const TTL_MS = 30_000;
let loadedAt = 0;

export async function storedIntegrationKeys(): Promise<Partial<Record<IntegrationKey, string>>> {
  const s = await db.setting.findUnique({ where: { key: SETTING } });
  const blob = (s?.value as { enc?: string } | null)?.enc;
  try {
    return decryptJson<Partial<Record<IntegrationKey, string>>>(blob) ?? {};
  } catch {
    return {}; // ENCRYPTION_KEY changed: keys must be entered again
  }
}

/** Applies the stored keys to env(); cheap to call often (cached for 30 s per process). */
export async function loadIntegrationKeys(force = false) {
  if (!force && Date.now() - loadedAt < TTL_MS) return;
  loadedAt = Date.now();
  setEnvOverrides((await storedIntegrationKeys()) as Partial<Env>);
}

/** Saves non-empty values; `clear` lists keys to remove (fall back to .env). */
export async function saveIntegrationKeys(values: Partial<Record<IntegrationKey, string>>, clear: IntegrationKey[] = []) {
  const cur = await storedIntegrationKeys();
  for (const k of INTEGRATION_KEYS) {
    const v = values[k]?.trim();
    if (v) cur[k] = v;
    if (clear.includes(k)) delete cur[k];
  }
  const value = { enc: encryptJson(cur) };
  await db.setting.upsert({ where: { key: SETTING }, update: { value }, create: { key: SETTING, value } });
  await loadIntegrationKeys(true);
}

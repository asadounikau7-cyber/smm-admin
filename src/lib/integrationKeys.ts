import { db } from "./db";
import { decryptJson, encryptJson } from "./crypto";
import { setEnvOverrides, type Env } from "./env";

/** Keys the owner can enter in «Настройки» instead of editing .env on the server. */
export const INTEGRATION_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "UPLOAD_POST_API_KEY", "B2_KEY_ID", "B2_APP_KEY"] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

/**
 * What each key looks like. A value that doesn't fit is refused, so a password the browser slipped
 * into a field (it happened with the Google secret on 2026-11-24) never replaces a working key.
 */
const KEY_FORMAT: Record<IntegrationKey, RegExp> = {
  GOOGLE_CLIENT_ID: /^[\w-]+\.apps\.googleusercontent\.com$/,
  GOOGLE_CLIENT_SECRET: /^(GOCSPX-)?[\w-]{20,}$/,
  INSTAGRAM_APP_ID: /^\d{6,20}$/,
  INSTAGRAM_APP_SECRET: /^[0-9a-f]{20,64}$/i,
  UPLOAD_POST_API_KEY: /^\S{16,}$/,
  B2_KEY_ID: /^[0-9a-f]{12,40}$/i,
  B2_APP_KEY: /^K[\w/+]{20,}$/,
};

/** Keys whose entered value doesn't look like that key. */
export function invalidKeys(values: Partial<Record<IntegrationKey, string>>): IntegrationKey[] {
  return INTEGRATION_KEYS.filter((k) => {
    const v = values[k]?.trim();
    return Boolean(v) && !KEY_FORMAT[k].test(v!);
  });
}
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

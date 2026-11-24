import { env } from "./env";
import { loadIntegrationKeys } from "./integrationKeys";

/** Keys entered in «Настройки» reach this process (cached 30 s). */
export const ensureB2Keys = () => loadIntegrationKeys();

/**
 * Private bucket without the S3 endpoint: the catalog's b2_download_file_by_id links keep working when
 * an application key is set (B2_KEY_ID + B2_APP_KEY). The account token from b2_authorize_account goes
 * in the Authorization header (server downloads) or the Authorization query parameter (ffmpeg, the
 * agent, a browser preview). Tokens live 24 h; one is reused for 20 h, or renewed after a 401.
 */
let cached: { token: string; until: number; keyId: string } | null = null;

export const isB2Download = (url: string) => /^https:\/\/[a-z0-9.-]*backblazeb2\.com\//i.test(url);
export const b2KeySet = () => Boolean(env().B2_KEY_ID && env().B2_APP_KEY);

export async function b2Token(force = false): Promise<string | null> {
  const e = env();
  if (!e.B2_KEY_ID || !e.B2_APP_KEY) return null;
  if (!force && cached && cached.keyId === e.B2_KEY_ID && cached.until > Date.now()) return cached.token;
  const res = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { authorization: `Basic ${Buffer.from(`${e.B2_KEY_ID}:${e.B2_APP_KEY}`).toString("base64")}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as { authorizationToken?: string; message?: string; code?: string };
  if (!res.ok || !body.authorizationToken) throw new Error(`Ключ B2 не принят: HTTP ${res.status} ${body.code ?? ""} ${body.message ?? ""}`.trim());
  cached = { token: body.authorizationToken, until: Date.now() + 20 * 3600_000, keyId: e.B2_KEY_ID };
  return cached.token;
}

/** fetch() for a B2 download link: adds the token when a key is set and renews it once on a 401. */
export async function b2Fetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!isB2Download(url) || !b2KeySet()) return fetch(url, init);
  const go = async (token: string | null) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(token ? { authorization: token } : {}) } });
  let res = await go(await b2Token());
  if (res.status === 401) res = await go(await b2Token(true));
  return res;
}

/** A B2 download link anyone holding it can open while the token lives (ffmpeg, agent, preview). */
export async function b2SignedUrl(url: string): Promise<string> {
  if (!isB2Download(url) || !b2KeySet()) return url;
  const token = await b2Token();
  if (!token) return url;
  const u = new URL(url);
  u.searchParams.set("Authorization", token);
  return u.toString();
}

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
type Auth = { token: string; until: number; keyId: string; apiUrl: string; downloadUrl: string; accountId: string; buckets: { id: string; name: string }[] };
let cached: Auth | null = null;
const bucketNames = new Map<string, string>();

export const isB2Download = (url: string) => /^https:\/\/[a-z0-9.-]*backblazeb2\.com\//i.test(url);
export const b2KeySet = () => Boolean(env().B2_KEY_ID && env().B2_APP_KEY);

export async function b2Token(force = false): Promise<string | null> {
  return (await b2Auth(force))?.token ?? null;
}

async function b2Auth(force = false): Promise<Auth | null> {
  const e = env();
  if (!e.B2_KEY_ID || !e.B2_APP_KEY) return null;
  if (!force && cached && cached.keyId === e.B2_KEY_ID && cached.until > Date.now()) return cached;
  const res = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { authorization: `Basic ${Buffer.from(`${e.B2_KEY_ID}:${e.B2_APP_KEY}`).toString("base64")}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    authorizationToken?: string; accountId?: string; message?: string; code?: string;
    apiInfo?: { storageApi?: { apiUrl?: string; downloadUrl?: string; allowed?: { buckets?: { id: string; name: string | null }[] | null } } };
  };
  if (!res.ok || !body.authorizationToken) throw new Error(`Ключ B2 не принят: HTTP ${res.status} ${body.code ?? ""} ${body.message ?? ""}`.trim());
  const sa = body.apiInfo?.storageApi ?? {};
  const buckets = (sa.allowed?.buckets ?? []).filter((b): b is { id: string; name: string } => Boolean(b?.id && b?.name));
  for (const b of buckets) bucketNames.set(b.id, b.name);
  cached = { token: body.authorizationToken, until: Date.now() + 20 * 3600_000, keyId: e.B2_KEY_ID, apiUrl: sa.apiUrl ?? "", downloadUrl: sa.downloadUrl ?? "", accountId: body.accountId ?? "", buckets };
  return cached;
}

/** Bucket name for a B2 file id ("4_z<bucketId>_f…"): from the key's allowed buckets, else b2_list_buckets. */
async function bucketName(a: Auth, fileId: string): Promise<string | null> {
  const id = fileId.match(/^4_z([0-9a-f]+)_/)?.[1];
  if (!id) return null;
  if (bucketNames.has(id)) return bucketNames.get(id)!;
  if (!a.apiUrl) return null;
  const res = await fetch(`${a.apiUrl}/b2api/v3/b2_list_buckets?accountId=${encodeURIComponent(a.accountId)}&bucketId=${id}`, { headers: { authorization: a.token }, signal: AbortSignal.timeout(30_000) });
  const body = (await res.json().catch(() => ({}))) as { buckets?: { bucketId: string; bucketName: string }[] };
  const name = body.buckets?.find((b) => b.bucketId === id)?.bucketName ?? null;
  if (name) bucketNames.set(id, name);
  return name;
}

/** fetch() for a B2 download link: adds the token when a key is set and renews it once on a 401. */
export async function b2Fetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!isB2Download(url) || !b2KeySet()) return fetch(url, init);
  const go = async (token: string | null) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(token ? { authorization: token } : {}) } });
  let res = await go(await b2Token());
  if (res.status === 401) res = await go(await b2Token(true));
  return res;
}

/**
 * A link anyone holding it can open while the token lives (ffmpeg, agent, preview). Download by file id
 * takes the token only as a header, so the file is addressed by bucket + file name, which takes it as
 * ?Authorization=. Falls back to the original link when the bucket name can't be found.
 */
export async function b2SignedUrl(url: string, fileName: string): Promise<string> {
  if (!isB2Download(url) || !b2KeySet()) return url;
  const a = await b2Auth();
  if (!a) return url;
  const fileId = new URL(url).searchParams.get("fileId") ?? "";
  const bucket = await bucketName(a, fileId);
  if (!bucket) return url;
  const base = a.downloadUrl || new URL(url).origin;
  return `${base}/file/${encodeURIComponent(bucket)}/${fileName.split("/").map(encodeURIComponent).join("/")}?Authorization=${encodeURIComponent(a.token)}`;
}

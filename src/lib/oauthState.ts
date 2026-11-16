import { cookies } from "next/headers";
import { createHash, randomBytes } from "node:crypto";

const COOKIE = "smm_oauth";

/** state + PKCE verifier kept in a short-lived httpOnly cookie. */
export async function beginOAuth(provider: string, extra: Record<string, string> = {}) {
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  (await cookies()).set(COOKIE, JSON.stringify({ provider, state, verifier, ...extra }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.APP_URL?.startsWith("https://") ?? false,
    path: "/api/oauth",
    maxAge: 600,
  });
  return { state, challenge };
}

export async function finishOAuth(provider: string, state: string | null) {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  jar.delete(COOKIE);
  if (!raw || !state) return null;
  const v = JSON.parse(raw) as { provider: string; state: string; verifier: string };
  if (v.provider !== provider || v.state !== state) return null;
  return v;
}

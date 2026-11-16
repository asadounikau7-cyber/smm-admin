import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db";

export const SESSION_COOKIE = "smm_session";
const TTL_DAYS = 14;

function secret() {
  return new TextEncoder().encode(process.env.SESSION_SECRET ?? "");
}

export async function createSession(userId: string) {
  const token = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TTL_DAYS}d`)
    .sign(secret());
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.APP_URL?.startsWith("https://") ?? false,
    path: "/",
    maxAge: TTL_DAYS * 86400,
  });
}

export async function verifyToken(token: string | undefined) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function currentUser() {
  const id = await verifyToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!id) return null;
  return db.user.findUnique({ where: { id } });
}

export async function requireUser() {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}

export async function requireOwner() {
  const u = await requireUser();
  if (u.role !== "OWNER") throw new Error("Недостаточно прав");
  return u;
}

export async function destroySession() {
  (await cookies()).delete(SESSION_COOKIE);
}

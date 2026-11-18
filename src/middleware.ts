import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

// /api/agent/* authenticates with AGENT_TOKEN inside the route.
const PUBLIC = ["/login", "/privacy", "/api/health", "/api/public/", "/api/agent/"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  const token = req.cookies.get("smm_session")?.value;
  let ok = false;
  if (token) {
    try {
      await jwtVerify(token, new TextEncoder().encode(process.env.SESSION_SECRET ?? ""));
      ok = true;
    } catch {}
  }
  if (ok) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };

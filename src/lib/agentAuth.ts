import { timingSafeEqual } from "node:crypto";
import { env } from "./env";

export function agentAuthorized(req: Request) {
  const token = env().AGENT_TOKEN;
  if (!token) return false;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

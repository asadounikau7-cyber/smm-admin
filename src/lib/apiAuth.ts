import { NextResponse } from "next/server";
import { currentUser } from "./auth";

export async function apiUser(owner = false) {
  const u = await currentUser();
  if (!u) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (owner && u.role !== "OWNER") return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { user: u };
}

/** BigInt-safe JSON. */
export function json(data: unknown, status = 200) {
  return new NextResponse(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v)), {
    status,
    headers: { "content-type": "application/json" },
  });
}

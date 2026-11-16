import { approveWeek } from "@/lib/planner";
import { apiUser, json } from "@/lib/apiAuth";

/** POST { allowPartial?: boolean } with header Idempotency-Key. Same key → same result. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await apiUser(true);
  if (error) return error;
  const { id } = await params;
  const key = req.headers.get("idempotency-key");
  if (!key) return json({ error: "Idempotency-Key header is required" }, 400);
  const body = await req.json().catch(() => ({}));
  const res = await approveWeek(id, user.id, key, Boolean(body.allowPartial));
  return json(res, res.ok ? 200 : 409);
}

import type { JobStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { apiUser, json } from "@/lib/apiAuth";

/** GET ?status=&from=&to=&accountId= */
export async function GET(req: Request) {
  const { error } = await apiUser();
  if (error) return error;
  const u = new URL(req.url);
  const from = u.searchParams.get("from");
  const to = u.searchParams.get("to");
  const jobs = await db.publicationJob.findMany({
    where: {
      status: (u.searchParams.get("status") as JobStatus) || undefined,
      accountId: u.searchParams.get("accountId") || undefined,
      scheduledAt: { gte: from ? new Date(from) : undefined, lt: to ? new Date(to) : undefined },
    },
    include: { account: { select: { platform: true, handle: true, externalId: true } } },
    orderBy: { scheduledAt: "asc" },
    take: 1000,
  });
  return json(jobs.map(({ meta: _m, ...j }) => j));
}

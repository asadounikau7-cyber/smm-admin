import { Prisma } from "@prisma/client";
import { db } from "./db";

export async function audit(
  action: string,
  entity: string,
  entityId: string | null,
  userId: string | null,
  data?: Prisma.InputJsonValue,
  tx: Prisma.TransactionClient = db,
) {
  await tx.auditEvent.create({ data: { action, entity, entityId, userId, data } });
}

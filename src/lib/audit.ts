import { Prisma, PrismaClient } from '@prisma/client';

export interface AuditEntryInput {
  companyId?: number | null;
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}

export async function writeAuditLog(
  prisma: PrismaClient,
  entry: AuditEntryInput,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      companyId: entry.companyId ?? null,
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? Prisma.JsonNull,
      ipAddress: entry.ipAddress ?? null,
    },
  });
}

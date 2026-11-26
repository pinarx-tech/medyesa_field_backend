import { PrismaClient } from '@prisma/client';

let singleton: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!singleton) {
    singleton = new PrismaClient();
  }
  return singleton;
}

export async function disconnectPrisma(): Promise<void> {
  if (singleton) {
    await singleton.$disconnect();
    singleton = null;
  }
}

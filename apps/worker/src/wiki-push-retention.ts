import type { PrismaClient } from '@prisma/client';

const BATCH_SIZE = 1000;
const MAX_BATCHES = 10;
const SUCCESS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const FAILURE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface WikiPushRetentionResult {
  subscriptions: number;
  deliveries: number;
  events: number;
}

export async function sweepWikiPushRetention(
  prisma: PrismaClient,
  now = new Date(),
): Promise<WikiPushRetentionResult> {
  const result: WikiPushRetentionResult = { subscriptions: 0, deliveries: 0, events: 0 };
  const successCutoff = new Date(now.getTime() - SUCCESS_RETENTION_MS);
  const failureCutoff = new Date(now.getTime() - FAILURE_RETENTION_MS);

  result.subscriptions = await deleteInBatches(async () => {
    const rows = await prisma.wikiPushSubscription.findMany({
      where: {
        OR: [
          { expirationTime: { lte: now } },
          { session: { expiresAt: { lte: now } } },
          { session: { account: { lifecycleStatus: { not: 'active' } } } },
          { profile: { status: { not: 'active' } } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }],
      take: BATCH_SIZE,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    return (await prisma.wikiPushSubscription.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })).count;
  });

  result.deliveries = await deleteInBatches(async () => {
    const rows = await prisma.wikiPushDelivery.findMany({
      where: {
        OR: [
          { status: 'delivered', createdAt: { lt: successCutoff } },
          { status: 'failed', createdAt: { lt: failureCutoff } },
        ],
      },
      orderBy: [{ id: 'asc' }],
      take: BATCH_SIZE,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    return (await prisma.wikiPushDelivery.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })).count;
  });

  result.events = await deleteInBatches(async () => {
    const rows = await prisma.wikiNotificationEvent.findMany({
      where: {
        OR: [
          { status: 'processed', createdAt: { lt: successCutoff } },
          { status: 'failed', createdAt: { lt: failureCutoff } },
        ],
      },
      orderBy: [{ id: 'asc' }],
      take: BATCH_SIZE,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    return (await prisma.wikiNotificationEvent.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })).count;
  });

  return result;
}

async function deleteInBatches(removeBatch: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const count = await removeBatch();
    total += count;
    if (count < BATCH_SIZE) break;
  }
  return total;
}

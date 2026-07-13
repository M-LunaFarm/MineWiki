import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

const MAX_ATTEMPTS = 10;
const LEASE_MS = 5 * 60 * 1000;

interface DeliveryPayload {
  profileId: string;
  type: string;
  pageId: string | null;
  actorProfileId: string | null;
  sourceType: string;
  sourceId: string;
  title: string;
  message: string | null;
  href: string;
  dedupeKey: string;
  createdAt: string;
}

export async function processWikiNotificationOutbox(prisma: PrismaClient, workerId = `wiki-notification-${randomUUID()}`): Promise<number> {
  const now = new Date();
  await prisma.wikiNotificationEvent.updateMany({
    where: { status: 'processing', lockedAt: { lt: new Date(now.getTime() - LEASE_MS) } },
    data: { status: 'pending', lockedAt: null, lockedBy: null, availableAt: now }
  });
  const candidates = await prisma.wikiNotificationEvent.findMany({
    where: { status: 'pending', availableAt: { lte: now } },
    orderBy: [{ id: 'asc' }],
    take: 25,
    select: { id: true }
  });
  let processed = 0;
  for (const candidate of candidates) {
    const claimed = await prisma.wikiNotificationEvent.updateMany({
      where: { id: candidate.id, status: 'pending', availableAt: { lte: now } },
      data: { status: 'processing', lockedAt: new Date(), lockedBy: workerId, attempts: { increment: 1 } }
    });
    if (claimed.count !== 1) continue;
    const event = await prisma.wikiNotificationEvent.findUnique({ where: { id: candidate.id } });
    if (!event) continue;
    try {
      const deliveries = parseDeliveries(event.payloadJson);
      await prisma.$transaction(async (tx) => {
        await tx.wikiNotification.createMany({
          data: deliveries.map((delivery) => ({
            profileId: BigInt(delivery.profileId), type: delivery.type,
            pageId: delivery.pageId ? BigInt(delivery.pageId) : null,
            actorProfileId: delivery.actorProfileId ? BigInt(delivery.actorProfileId) : null,
            sourceType: delivery.sourceType, sourceId: delivery.sourceId, title: delivery.title,
            message: delivery.message, href: delivery.href, dedupeKey: delivery.dedupeKey,
            readAt: null, createdAt: new Date(delivery.createdAt)
          })),
          skipDuplicates: true
        });
        await tx.wikiNotificationEvent.updateMany({
          where: { id: event.id, status: 'processing', lockedBy: workerId },
          data: { status: 'processed', processedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null }
        });
      });
      processed += 1;
    } catch (error) {
      const failed = event.attempts >= MAX_ATTEMPTS;
      const delaySeconds = Math.min(3600, 2 ** Math.min(event.attempts, 12));
      await prisma.wikiNotificationEvent.updateMany({
        where: { id: event.id, status: 'processing', lockedBy: workerId },
        data: {
          status: failed ? 'failed' : 'pending',
          availableAt: new Date(Date.now() + delaySeconds * 1000),
          lockedAt: null, lockedBy: null,
          lastError: (error instanceof Error ? error.message : 'Unknown notification delivery error').slice(0, 1000)
        }
      });
    }
  }
  return processed;
}

function parseDeliveries(payload: unknown): DeliveryPayload[] {
  if (!payload || typeof payload !== 'object' || !('deliveries' in payload) || !Array.isArray(payload.deliveries)) {
    throw new Error('Invalid wiki notification event payload.');
  }
  return payload.deliveries.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid wiki notification delivery.');
    const item = value as Partial<DeliveryPayload>;
    if (!item.profileId || !/^\d+$/.test(item.profileId) || !item.type || !item.sourceType || !item.sourceId || !item.title || !item.href || !item.dedupeKey || !item.createdAt) {
      throw new Error('Incomplete wiki notification delivery.');
    }
    if (Number.isNaN(new Date(item.createdAt).getTime())) throw new Error('Invalid notification delivery date.');
    return { ...item, pageId: item.pageId ?? null, actorProfileId: item.actorProfileId ?? null, message: item.message ?? null } as DeliveryPayload;
  });
}

import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

const MAX_ATTEMPTS = 10;
const LEASE_MS = 5 * 60 * 1000;
const PUSH_FRESHNESS_MS = 15 * 60 * 1000;

interface DeliveryPayload {
  profileId: string;
  type: string;
  pageId: string | null;
  actorProfileId: string | null;
  sourceType: string;
  sourceId: string;
  sourceVersion?: number;
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
      const parsedDeliveries = parseDeliveries(event.payloadJson);
      await prisma.$transaction(async (tx) => {
        const releaseAuthorized = await filterAuthorizedReleaseReviewDeliveries(tx, parsedDeliveries);
        const invitationAuthorized = await filterCurrentCollaboratorInvitationDeliveries(tx, releaseAuthorized);
        const deliveries = await filterCurrentOwnershipTransferDeliveries(tx, invitationAuthorized);
        if (deliveries.length > 0) await tx.wikiNotification.createMany({
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
        const persistedNotifications = deliveries.length > 0 ? await tx.wikiNotification.findMany({
          where: { dedupeKey: { in: deliveries.map((delivery) => delivery.dedupeKey) } },
          select: { id: true, profileId: true, createdAt: true },
        }) : [];
        if (persistedNotifications.length > 0) {
          const profileIds = [...new Set(persistedNotifications.map((notification) => notification.profileId))];
          const subscriptions = await tx.wikiPushSubscription.findMany({
            where: {
              profileId: { in: profileIds },
              disabledAt: null,
              OR: [{ expirationTime: null }, { expirationTime: { gt: new Date() } }],
              session: { expiresAt: { gt: new Date() }, account: { lifecycleStatus: 'active' } },
            },
            select: {
              id: true,
              profileId: true,
              createdAt: true,
              session: { select: { accountId: true } },
              profile: { select: { accountId: true, status: true } },
            },
          });
          const subscriptionsByProfile = new Map<bigint, typeof subscriptions>();
          for (const subscription of subscriptions) {
            if (subscription.profile.status !== 'active' || subscription.profile.accountId !== subscription.session.accountId) continue;
            const rows = subscriptionsByProfile.get(subscription.profileId) ?? [];
            rows.push(subscription);
            subscriptionsByProfile.set(subscription.profileId, rows);
          }
          await tx.wikiPushDelivery.createMany({
            data: persistedNotifications.flatMap((notification) =>
              (notification.createdAt >= new Date(now.getTime() - PUSH_FRESHNESS_MS)
                ? subscriptionsByProfile.get(notification.profileId) ?? []
                : [])
                .filter((subscription) => subscription.createdAt <= notification.createdAt)
                .map((subscription) => ({
                notificationId: notification.id,
                subscriptionId: subscription.id,
                status: 'pending',
                attempts: 0,
                availableAt: new Date(),
                lockedAt: null,
                lockedBy: null,
                deliveredAt: null,
                lastError: null,
                createdAt: new Date(),
              })),
            ),
            skipDuplicates: true,
          });
        }
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

async function filterCurrentOwnershipTransferDeliveries(
  tx: Prisma.TransactionClient,
  deliveries: readonly DeliveryPayload[],
): Promise<DeliveryPayload[]> {
  const transferDeliveries = deliveries.filter((delivery) => delivery.sourceType === 'server_ownership_transfer');
  if (transferDeliveries.length === 0) return [...deliveries];
  const ids = [...new Set(transferDeliveries
    .filter((delivery) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(delivery.sourceId))
    .map((delivery) => delivery.sourceId.toLowerCase()))];
  const transfers = ids.length > 0 ? await tx.serverOwnershipTransfer.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      status: true,
      version: true,
      expiresAt: true,
      sourceOwnerProfileId: true,
      targetProfileId: true,
    },
  }) : [];
  const transferById = new Map(transfers.map((transfer) => [transfer.id, transfer]));
  return deliveries.filter((delivery) => {
    if (delivery.sourceType !== 'server_ownership_transfer') return true;
    const transfer = transferById.get(delivery.sourceId.toLowerCase());
    if (!transfer) return false;
    const sourceVersion = delivery.sourceVersion ?? transferVersionFromDedupeKey(delivery.dedupeKey);
    if (sourceVersion !== transfer.version) return false;
    const recipientId = BigInt(delivery.profileId);
    if (delivery.type === 'server_ownership_transfer_requested') {
      return transfer.status === 'pending'
        && transfer.expiresAt > new Date()
        && transfer.targetProfileId === recipientId;
    }
    const expectedStatus = delivery.type.replace('server_ownership_transfer_', '');
    if (!['accepted', 'declined', 'cancelled'].includes(expectedStatus) || transfer.status !== expectedStatus) {
      return false;
    }
    return expectedStatus === 'cancelled'
      ? transfer.targetProfileId === recipientId
      : transfer.sourceOwnerProfileId === recipientId;
  });
}

function transferVersionFromDedupeKey(dedupeKey: string): number | null {
  const match = /^server-ownership-transfer:[^:]+:(?:requested|accepted|declined|cancelled):(\d+):profile:/u.exec(dedupeKey);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function filterCurrentCollaboratorInvitationDeliveries(
  tx: Prisma.TransactionClient,
  deliveries: readonly DeliveryPayload[],
): Promise<DeliveryPayload[]> {
  const invitationDeliveries = deliveries.filter((delivery) => delivery.sourceType === 'server_wiki_collaborator_invitation');
  if (invitationDeliveries.length === 0) return [...deliveries];
  const ids = [...new Set(invitationDeliveries
    .filter((delivery) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(delivery.sourceId))
    .map((delivery) => delivery.sourceId.toLowerCase()))];
  const invitations = ids.length > 0 ? await tx.serverWikiCollaboratorInvitation.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, targetProfileId: true },
  }) : [];
  const invitationById = new Map(invitations.map((invitation) => [invitation.id, invitation]));
  return deliveries.filter((delivery) => {
    if (delivery.sourceType !== 'server_wiki_collaborator_invitation') return true;
    const invitation = invitationById.get(delivery.sourceId.toLowerCase());
    if (!invitation) return false;
    const recipientId = BigInt(delivery.profileId);
    if (delivery.type === 'server_wiki_collaborator_invited') {
      return invitation.status === 'pending' && invitation.targetProfileId === recipientId;
    }
    if (delivery.type === 'server_wiki_collaborator_invitation_cancelled') {
      return invitation.status === 'cancelled' && invitation.targetProfileId === recipientId;
    }
    if (delivery.type === 'server_wiki_collaborator_invitation_accepted') {
      return invitation.status === 'accepted' && delivery.actorProfileId !== delivery.profileId;
    }
    if (delivery.type === 'server_wiki_collaborator_invitation_declined') {
      return invitation.status === 'declined' && delivery.actorProfileId !== delivery.profileId;
    }
    return false;
  });
}

async function filterAuthorizedReleaseReviewDeliveries(
  tx: Prisma.TransactionClient,
  deliveries: readonly DeliveryPayload[],
): Promise<DeliveryPayload[]> {
  const releaseDeliveries = deliveries.filter((delivery) => delivery.sourceType === 'server_wiki_release_candidate');
  if (releaseDeliveries.length === 0) return [...deliveries];
  const candidateIds = [...new Set(releaseDeliveries
    .filter((delivery) => /^\d+$/u.test(delivery.sourceId))
    .map((delivery) => BigInt(delivery.sourceId)))];
  const candidates = candidateIds.length > 0 ? await tx.serverWikiReleaseCandidate.findMany({
    where: { id: { in: candidateIds } },
    select: { id: true, spaceId: true, status: true, createdBy: true },
  }) : [];
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const recipientIds = [...new Set(releaseDeliveries.map((delivery) => BigInt(delivery.profileId)))];
  const profiles = recipientIds.length > 0 ? await tx.wikiProfile.findMany({
    where: { id: { in: recipientIds }, status: 'active', mergedIntoProfileId: null, accountId: { not: null } },
    select: { id: true, accountId: true },
  }) : [];
  const accountIds = profiles.flatMap((profile) => profile.accountId ? [profile.accountId] : []);
  const accounts = accountIds.length > 0 ? await tx.account.findMany({
    where: { id: { in: accountIds }, lifecycleStatus: 'active' },
    select: { id: true, canonicalAccountId: true },
  }) : [];
  const activeCanonicalAccountIds = new Set(accounts
    .filter((account) => !account.canonicalAccountId || account.canonicalAccountId === account.id)
    .map((account) => account.id));
  const activeCanonicalProfileIds = new Set(profiles
    .filter((profile) => profile.accountId && activeCanonicalAccountIds.has(profile.accountId))
    .map((profile) => profile.id));
  const submittedPairs = releaseDeliveries.flatMap((delivery) => {
    if (delivery.type !== 'server_wiki_release_submitted' || !/^\d+$/u.test(delivery.sourceId)) return [];
    const candidate = candidateById.get(BigInt(delivery.sourceId));
    return candidate ? [{ profileId: BigInt(delivery.profileId), spaceId: candidate.spaceId }] : [];
  });
  const reviewerRoles = submittedPairs.length > 0 ? await tx.subwikiRole.findMany({
    where: {
      userId: { in: [...new Set(submittedPairs.map((pair) => pair.profileId))] },
      spaceId: { in: [...new Set(submittedPairs.map((pair) => pair.spaceId))] },
      role: 'reviewer',
      status: 'active',
    },
    select: { userId: true, spaceId: true },
  }) : [];
  const reviewerKeys = new Set(reviewerRoles.map((role) => `${role.userId.toString()}:${role.spaceId.toString()}`));
  return deliveries.filter((delivery) => {
    if (delivery.sourceType !== 'server_wiki_release_candidate') return true;
    if (!/^\d+$/u.test(delivery.sourceId)) return false;
    const profileId = BigInt(delivery.profileId);
    if (!activeCanonicalProfileIds.has(profileId)) return false;
    const candidate = candidateById.get(BigInt(delivery.sourceId));
    if (!candidate) return false;
    if (delivery.type === 'server_wiki_release_submitted') {
      return candidate.status === 'pending_review'
        && reviewerKeys.has(`${profileId.toString()}:${candidate.spaceId.toString()}`);
    }
    if (
      delivery.type === 'server_wiki_release_approved'
      || delivery.type === 'server_wiki_release_revoked'
      || delivery.type === 'server_wiki_release_changes_requested'
    ) {
      return candidate.createdBy === profileId;
    }
    return false;
  });
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
    if (item.sourceVersion !== undefined && (!Number.isSafeInteger(item.sourceVersion) || item.sourceVersion < 1)) {
      throw new Error('Invalid notification source version.');
    }
    return { ...item, pageId: item.pageId ?? null, actorProfileId: item.actorProfileId ?? null, message: item.message ?? null } as DeliveryPayload;
  });
}

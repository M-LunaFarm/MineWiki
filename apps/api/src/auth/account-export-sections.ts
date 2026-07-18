import type { PrismaService } from '../common/prisma.service';
import type { AccountExportSection } from './account-export-stream';
import {
  EXPORT_PAGE_SIZE,
  afterBigInt,
  pagedSection,
  staticSection,
  type FilterReadablePageIds,
  type FilterReadableThreadIds,
} from './account-export-section-utils';
import { buildWikiExportSections } from './account-export-wiki-sections';
import { buildIntegrationExportSections } from './account-export-legacy-integration.repository';

export interface AccountExportScope {
  readonly accountIds: readonly string[];
  readonly profileIds: readonly bigint[];
  readonly canonicalAccountId: string;
}

export type { FilterReadablePageIds, FilterReadableThreadIds } from './account-export-section-utils';

export function buildAccountExportSections(
  prisma: PrismaService,
  scope: AccountExportScope,
  filterReadablePageIds?: FilterReadablePageIds,
  filterReadableThreadIds?: FilterReadableThreadIds,
): AccountExportSection[] {
  const accountIds = [...scope.accountIds];
  const profileIds = [...scope.profileIds];

  return [
    staticSection('accounts', async () => prisma.account.findMany({
      where: { id: { in: accountIds } },
      orderBy: { id: 'asc' },
      select: {
        id: true, canonicalAccountId: true, provider: true, providerUserId: true,
        email: true, displayName: true, avatarUrl: true, emailVerified: true,
        lifecycleStatus: true, deletionRequestedAt: true, anonymizedAt: true,
        suspendedAt: true, suspensionReason: true, createdAt: true, lastLoginAt: true,
      },
    })),
    staticSection('accountEmailChanges', async () => prisma.accountEmailChange.findMany({
      where: { canonicalAccountId: { in: accountIds } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, canonicalAccountId: true, credentialAccountId: true,
        previousEmail: true, newEmail: true, status: true,
        sentAt: true, resendAvailableAt: true, expiresAt: true,
        confirmedAt: true, supersededAt: true, createdAt: true, updatedAt: true,
      },
    })),
    staticSection('accountLinks', async () => prisma.accountLink.findMany({
      where: {
        OR: [
          { primaryAccountId: { in: accountIds } },
          { linkedAccountId: { in: accountIds } },
        ],
      },
      orderBy: { id: 'asc' },
      select: { id: true, primaryAccountId: true, linkedAccountId: true, createdAt: true },
    })),
    staticSection('oauthCredentials', async () => prisma.oAuthCredential.findMany({
      where: { accountId: { in: accountIds } },
      orderBy: { id: 'asc' },
      select: {
        id: true, accountId: true, provider: true, providerUserId: true,
        tokenType: true, scope: true, expiresAt: true, createdAt: true, updatedAt: true,
      },
    })),
    staticSection('mfaTotp', async () => prisma.mfaTotpCredential.findMany({
      where: { accountId: { in: accountIds } }, orderBy: { id: 'asc' },
      select: { id: true, accountId: true, enabledAt: true, createdAt: true, updatedAt: true },
    })),
    staticSection('mfaRecoveryCodeSummary', async () => prisma.mfaRecoveryCode.groupBy({
      by: ['accountId'], where: { accountId: { in: accountIds } },
      _count: { _all: true }, _max: { createdAt: true, usedAt: true },
      orderBy: { accountId: 'asc' },
    }).then((rows) => rows.map((row) => ({ id: row.accountId, ...row })))),
    staticSection('passkeys', async () => prisma.webAuthnCredential.findMany({
      where: { accountId: { in: accountIds } }, orderBy: { id: 'asc' },
      select: {
        id: true, accountId: true, name: true, transports: true, deviceType: true,
        backedUp: true, lastUsedAt: true, createdAt: true, updatedAt: true,
      },
    })),
    pagedSection('accountConsents', (after) => prisma.accountConsent.findMany({
      where: { accountId: { in: accountIds }, id: { gt: after ?? undefined } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: { id: true, accountId: true, consentType: true, policyVersion: true, consentedAt: true, ipAddress: true, userAgent: true },
    })),
    pagedSection('sessions', (after) => prisma.session.findMany({
      where: { accountId: { in: accountIds }, id: { gt: after ?? undefined } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: {
        id: true, accountId: true, issuedAt: true, expiresAt: true,
        primaryAuthenticatedAt: true, ipAddress: true, userAgent: true,
        lastActiveAt: true, createdAt: true,
      },
    })),
    pagedSection('accountRoles', (after) => prisma.accountRole.findMany({
      where: { accountId: { in: accountIds }, id: { gt: after ?? undefined } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: { id: true, accountId: true, createdAt: true, role: { select: { code: true, displayName: true } } },
    })),
    pagedSection('minecraftIdentities', (after) => prisma.minecraftIdentity.findMany({
      where: { accountId: { in: accountIds }, id: { gt: afterBigInt(after) } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: { id: true, accountId: true, uuid: true, playerName: true, msOwned: true, isPrimary: true, lastVerifiedAt: true },
    })),
    pagedSection('servers', (after) => prisma.server.findMany({
      where: {
        OR: [{ ownerAccountId: { in: accountIds } }, { registrantAccountId: { in: accountIds } }],
        id: { gt: after ?? undefined },
      },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: {
        id: true, shortCode: true, ownerAccountId: true, registrantAccountId: true,
        name: true, joinHost: true, joinPort: true, edition: true, listingStatus: true,
        supportedVersions: true, tags: true, shortDescription: true, longDescription: true,
        bannerUrl: true, websiteUrl: true, discordUrl: true, verificationGrade: true,
        verifiedAt: true, createdAt: true, updatedAt: true,
      },
    })),
    pagedSection('serverClaims', (after) => prisma.serverClaimMethod.findMany({
      where: { accountId: { in: accountIds }, id: { gt: after ?? undefined } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: { id: true, serverId: true, accountId: true, method: true, issuedAt: true, status: true, verifiedAt: true, lastCheckedAt: true, version: true },
    })),
    ...buildIntegrationExportSections(prisma, accountIds),
    pagedSection('votes', (after) => prisma.vote.findMany({
      where: { accountId: { in: accountIds }, id: { gt: after ?? undefined } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: {
        id: true, serverId: true, accountId: true, minecraftUuid: true, username: true,
        votedAt: true, createdAt: true, status: true, invalidatedAt: true, invalidationReason: true,
      },
    })),
    pagedSection('reviews', (after) => prisma.serverReview.findMany({
      where: { authorAccountId: { in: accountIds }, id: { gt: after ?? undefined } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: {
        id: true, serverId: true, authorAccountId: true, authorDisplayName: true,
        rating: true, body: true, tags: true, visibility: true, isAnonymous: true,
        helpfulCount: true, adminReplyBody: true, adminReplyCreatedAt: true,
        createdAt: true, updatedAt: true, evidenceMinecraftUuid: true,
        evidenceVoteId: true, evidenceVerifiedAt: true, evidencePolicyVersion: true,
      },
    })),
    pagedSection('reviewHelpfulVotes', (after) => prisma.reviewHelpfulVote.findMany({
      where: { accountId: { in: accountIds }, id: { gt: after ?? undefined } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: { id: true, reviewId: true, accountId: true, isHelpful: true, lastMarkedAt: true, createdAt: true },
    })),
    pagedSection('reviewReports', (after) => prisma.reviewReport.findMany({
      where: { accountId: { in: accountIds }, id: { gt: after ?? undefined } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: {
        id: true, reviewId: true, accountId: true, reason: true, status: true,
        resolution: true, statusUpdatedAt: true, resolvedAt: true, dismissedAt: true,
        createdAt: true, updatedAt: true,
      },
    })),
    pagedSection('supportTickets', (after) => prisma.supportTicket.findMany({
      where: { requesterAccountId: { in: accountIds }, id: { gt: after ?? undefined } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: {
        id: true, requesterAccountId: true, serverId: true, subject: true, status: true,
        priority: true, category: true, pageId: true, fileId: true,
        lastMessageAt: true, createdAt: true, updatedAt: true,
      },
    })),
    pagedSection('supportMessages', (after) => prisma.supportMessage.findMany({
      where: {
        ticket: { requesterAccountId: { in: accountIds } },
        isInternal: false,
        id: { gt: after ?? undefined },
      },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: { id: true, ticketId: true, authorAccountId: true, authorRole: true, body: true, createdAt: true },
    })),
    pagedSection('uploadedFiles', (after) => prisma.uploadedFile.findMany({
      where: { ownerAccountId: { in: accountIds }, id: { gt: after ?? undefined } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: {
        id: true, ownerAccountId: true, filename: true, wikiFilename: true,
        originalName: true, mimeType: true, sizeBytes: true, width: true, height: true, sha256: true,
        publicPath: true, usageContext: true, visibility: true, license: true,
        sourceUrl: true, sourceText: true, linkedResourceType: true, linkedResourceId: true,
        status: true, createdAt: true, updatedAt: true,
      },
    })),
    ...buildWikiExportSections(
      prisma,
      accountIds,
      profileIds,
      filterReadablePageIds,
      filterReadableThreadIds,
    ),
    pagedSection('billingSubjects', (after) => prisma.paddleBillingSubject.findMany({
      where: { createdByAccountId: { in: accountIds }, id: { gt: after ?? undefined } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: { id: true, serverWikiId: true, createdByAccountId: true, createdAt: true, updatedAt: true },
    })),
    pagedSection('billingSubscriptions', (after) => prisma.paddleSubscriptionShadow.findMany({
      where: {
        billingSubject: { createdByAccountId: { in: accountIds } },
        id: { gt: afterBigInt(after) },
      },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: {
        id: true, billingSubjectId: true, environment: true, providerSubscriptionId: true,
        providerCustomerId: true, providerTransactionId: true, status: true,
        nextBilledAt: true, currentPeriodStartsAt: true, currentPeriodEndsAt: true,
        scheduledChange: true, createdAt: true, updatedAt: true,
      },
    })),
    pagedSection('billingCheckoutIntents', (after) => prisma.paddleCheckoutIntent.findMany({
      where: {
        billingSubject: { createdByAccountId: { in: accountIds } },
        id: { gt: after ?? undefined },
      },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: {
        id: true, billingSubjectId: true, environment: true, layoutKey: true,
        status: true, providerTransactionId: true, expiresAt: true,
        createdAt: true, updatedAt: true,
      },
    })),
    staticSection('accountDeletionRequests', async () => prisma.accountDeletionRequest.findMany({
      where: { canonicalAccountId: scope.canonicalAccountId }, orderBy: { createdAt: 'asc' },
      select: {
        id: true, canonicalAccountId: true, accountIds: true, status: true,
        reauthMethod: true, requestedBy: true, requestedAt: true, scheduledFor: true,
        cancelledAt: true, processedAt: true,
        version: true, createdAt: true, updatedAt: true,
      },
    })),
  ];
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isPublicWikiPageStatus } from '@minewiki/wiki-core/page-status';
import { buildWikiSearchVector, hashContent } from '@minewiki/wiki-core';
import { PrismaService } from '../common/prisma.service';
import { toAuditJson } from '../events/business-event.service';
import { writeAuditRecord } from '../events/audit-event-writer';
import { buildServerWikiMainPage, buildServerWikiStarterPages, type ServerWikiScaffoldInput } from './server-wiki-scaffold';
import {
  buildServerWikiReleaseCandidate,
  type ReleaseCandidateSnapshot,
  type ServerWikiPresentationSnapshot,
  type ServerWikiReleaseCandidate,
} from './server-wiki-release-candidate';

export const SERVER_WIKI_PUBLICATION_STATUSES = ['draft', 'published', 'unpublished'] as const;
export type ServerWikiPublicationStatus = (typeof SERVER_WIKI_PUBLICATION_STATUSES)[number];

export interface ServerWikiPublicationActor {
  readonly accountId: string;
  readonly permissions?: readonly string[];
}

export interface UpdateServerWikiPublicationInput {
  readonly status: 'published' | 'unpublished';
  readonly expectedVersion: number;
  readonly expectedCandidateToken?: string;
  readonly reason: string;
}

export interface ReviewServerWikiReleaseCandidateInput {
  readonly candidateToken: string;
}

export interface ServerWikiReleaseReviewState {
  readonly required: boolean;
  readonly approved: boolean;
  readonly canApprove: boolean;
  readonly viewerApproved: boolean;
  readonly approvals: readonly {
    readonly reviewerProfileId: string;
    readonly approvedAt: string;
  }[];
}

export interface ServerWikiPublicationResponse {
  readonly serverId: string;
  readonly serverWikiId: string;
  readonly status: ServerWikiPublicationStatus;
  readonly version: number;
  readonly publishedAt: string | null;
  readonly unpublishedAt: string | null;
  readonly updatedAt: string | null;
  readonly updatedByProfileId: string | null;
  readonly release: {
    readonly id: string;
    readonly version: number;
    readonly publishedAt: string;
    readonly pageCount: number;
  } | null;
  readonly wikiUrl: string;
  readonly access: {
    readonly authority: 'server_admin' | 'owner' | 'manager' | 'reviewer';
    readonly canPublish: boolean;
    readonly canApprove: boolean;
  };
  readonly readiness: {
    readonly ready: boolean;
    readonly blockers: readonly ServerWikiPublicationReadinessBlocker[];
  };
  readonly candidate: ServerWikiReleaseCandidate;
  readonly review: ServerWikiReleaseReviewState;
}

export type ServerWikiPublicationReadinessBlocker =
  | 'invalid_link'
  | 'invalid_site_slug'
  | 'missing_root_page'
  | 'missing_public_root_revision'
  | 'missing_public_document'
  | 'missing_required_documents'
  | 'incomplete_introduction'
  | 'placeholder_rules'
  | 'missing_official_channel'
  | 'search_index_not_ready';

interface PublicationContext {
  readonly serverId: string;
  readonly serverWikiId: bigint;
  readonly spaceId: bigint;
  readonly rootPageId: bigint;
  readonly siteSlug: string;
  readonly contentSlug: string;
  readonly serverContent: ServerWikiScaffoldInput;
  readonly actorAccountId: string;
  readonly actorProfileId: bigint | null;
  readonly authority: 'server_admin' | 'owner' | 'manager' | 'reviewer';
  readonly publication: {
    readonly status: string;
    readonly version: number;
    readonly publishedAt: Date | null;
    readonly unpublishedAt: Date | null;
    readonly updatedAt: Date | null;
    readonly updatedBy: bigint | null;
    readonly publishedRelease: {
      readonly id: bigint;
      readonly version: number;
      readonly publishedAt: Date;
      readonly pageCount: number;
      readonly presentationSnapshot: Prisma.JsonValue;
    } | null;
  };
  readonly presentation: ServerWikiPresentationSnapshot;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SITE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u;
const MAX_CANONICAL_ACCOUNT_DEPTH = 16;
const MAX_SERIALIZABLE_ATTEMPTS = 3;
const REASON_MIN_LENGTH = 5;
const REASON_MAX_LENGTH = 500;
const CANDIDATE_TOKEN_PATTERN = /^[0-9a-f]{64}$/u;

@Injectable()
export class ServerWikiPublicationService {
  constructor(private readonly prisma: PrismaService) {}

  async get(
    serverIdInput: string,
    actor: ServerWikiPublicationActor,
  ): Promise<ServerWikiPublicationResponse> {
    const serverId = parseServerId(serverIdInput);
    const context = await this.resolveContext(this.prisma, serverId, actor, false);
    const blockers = await this.readinessBlockers(this.prisma, context);
    const snapshot = await buildServerWikiReleaseCandidate(this.prisma, candidateInput(context), false);
    const review = await this.releaseReviewState(this.prisma, context, snapshot.candidate.token, false);
    return toResponse(context, blockers, snapshot.candidate, review);
  }

  async approveCandidate(
    serverIdInput: string,
    input: ReviewServerWikiReleaseCandidateInput,
    actor: ServerWikiPublicationActor,
  ): Promise<ServerWikiReleaseReviewState> {
    return this.changeCandidateApproval(serverIdInput, input, actor, true);
  }

  async revokeCandidateApproval(
    serverIdInput: string,
    input: ReviewServerWikiReleaseCandidateInput,
    actor: ServerWikiPublicationActor,
  ): Promise<ServerWikiReleaseReviewState> {
    return this.changeCandidateApproval(serverIdInput, input, actor, false);
  }

  private async changeCandidateApproval(
    serverIdInput: string,
    input: ReviewServerWikiReleaseCandidateInput,
    actor: ServerWikiPublicationActor,
    approve: boolean,
  ): Promise<ServerWikiReleaseReviewState> {
    const serverId = parseServerId(serverIdInput);
    const candidateToken = parseCandidateToken(input.candidateToken);
    return this.serializable(async (tx) => {
      const context = await this.resolveContext(tx, serverId, actor, true);
      if (context.authority !== 'reviewer' || context.actorProfileId === null) throw reviewForbidden();
      const snapshot = await buildServerWikiReleaseCandidate(tx, candidateInput(context), true);
      if (snapshot.candidate.token !== candidateToken) throw candidateChanged(snapshot.candidate);
      const now = new Date();
      if (approve) {
        await tx.serverWikiReleaseApproval.upsert({
          where: {
            serverWikiId_candidateToken_reviewerProfileId: {
              serverWikiId: context.serverWikiId,
              candidateToken,
              reviewerProfileId: context.actorProfileId,
            },
          },
          create: {
            serverWikiId: context.serverWikiId,
            spaceId: context.spaceId,
            candidateToken,
            reviewerProfileId: context.actorProfileId,
            approvedAt: now,
            revokedAt: null,
            createdAt: now,
            updatedAt: now,
          },
          update: { approvedAt: now, revokedAt: null, updatedAt: now },
        });
      } else {
        await tx.serverWikiReleaseApproval.updateMany({
          where: {
            serverWikiId: context.serverWikiId,
            spaceId: context.spaceId,
            candidateToken,
            reviewerProfileId: context.actorProfileId,
            revokedAt: null,
          },
          data: { revokedAt: now, updatedAt: now },
        });
      }
      await writeAuditRecord(tx, {
        data: {
          category: 'server',
          action: approve ? 'server.wiki.release.approve' : 'server.wiki.release.approval_revoke',
          severity: 'info',
          actorAccountId: context.actorAccountId,
          actorProfileId: context.actorProfileId,
          subjectType: 'server_wiki',
          subjectId: context.serverWikiId.toString(),
          metadata: toAuditJson({
            serverId: context.serverId,
            serverWikiId: context.serverWikiId,
            candidateToken,
            candidateCounts: snapshot.candidate.counts,
          }),
        },
      });
      return this.releaseReviewState(tx, context, candidateToken, false);
    });
  }

  async update(
    serverIdInput: string,
    input: UpdateServerWikiPublicationInput,
    actor: ServerWikiPublicationActor,
  ): Promise<ServerWikiPublicationResponse> {
    const serverId = parseServerId(serverIdInput);
    const status = parseMutationStatus(input.status);
    const expectedVersion = parseVersion(input.expectedVersion);
    const expectedCandidateToken = status === 'published'
      ? parseCandidateToken(input.expectedCandidateToken)
      : null;
    const reason = parseReason(input.reason);

    try {
      return await this.serializable(async (tx) => {
        const context = await this.resolveContext(tx, serverId, actor, true);
        if (context.authority === 'reviewer') throw publicationForbidden();
        if (context.publication.version !== expectedVersion) {
          throw publicationConflict(context.publication.version);
        }
        if (context.publication.status === status && status !== 'published') {
          throw new BadRequestException(`Server wiki publication is already ${status}.`);
        }
        if (context.publication.status === 'draft' && status === 'unpublished') {
          throw new BadRequestException('A draft server wiki can only transition to published.');
        }
        const blockers = await this.readinessBlockers(tx, context);
        if (status === 'published' && blockers.length > 0) {
          throw new ConflictException({
            statusCode: 409,
            code: 'SERVER_WIKI_PUBLICATION_NOT_READY',
            message: 'Server wiki is not ready to publish.',
            blockers,
          });
        }

        const snapshot = status === 'published'
          ? await buildServerWikiReleaseCandidate(tx, candidateInput(context), true)
          : null;
        if (snapshot && snapshot.candidate.token !== expectedCandidateToken) {
          throw candidateChanged(snapshot.candidate);
        }
        if (snapshot && !snapshot.candidate.hasChanges) {
          throw new ConflictException({
            statusCode: 409,
            code: 'SERVER_WIKI_RELEASE_CANDIDATE_EMPTY',
            message: 'Server wiki release candidate has no changes.',
            candidate: snapshot.candidate,
          });
        }
        const review = snapshot
          ? await this.releaseReviewState(tx, context, snapshot.candidate.token, true)
          : null;
        if (snapshot && review?.required && !review.approved) {
          throw new ConflictException({
            statusCode: 409,
            code: 'SERVER_WIKI_RELEASE_REVIEW_REQUIRED',
            message: 'An independent reviewer must approve this release candidate before publishing.',
            review,
          });
        }

        const now = new Date();
        const version = expectedVersion + 1;
        const release = status === 'published'
          ? await this.createRelease(tx, context, snapshot!, version, reason, now)
          : context.publication.publishedRelease;
        const changed = await tx.serverWiki.updateMany({
          where: {
            id: context.serverWikiId,
            status: 'active',
            publicationVersion: expectedVersion,
          },
          data: {
            publicationStatus: status,
            publicationVersion: { increment: 1 },
            ...(status === 'published' ? { publishedAt: now } : { unpublishedAt: now }),
            publicationUpdatedAt: now,
            publicationUpdatedBy: context.actorProfileId,
            ...(release ? { publishedReleaseId: release.id } : {}),
          },
        });
        if (changed.count !== 1) {
          const latest = await tx.serverWiki.findUnique({
            where: { id: context.serverWikiId },
            select: { publicationVersion: true },
          });
          throw publicationConflict(latest?.publicationVersion ?? expectedVersion + 1);
        }

        await writeAuditRecord(tx, {
          data: {
            category: 'server',
            action: status === 'published'
              ? 'server.wiki.publication.publish'
              : 'server.wiki.publication.unpublish',
            severity: status === 'published' ? 'info' : 'warning',
            actorAccountId: context.actorAccountId,
            actorProfileId: context.actorProfileId,
            subjectType: 'server_wiki',
            subjectId: context.serverWikiId.toString(),
            metadata: toAuditJson({
              serverId: context.serverId,
              serverWikiId: context.serverWikiId,
              previousStatus: context.publication.status,
              status,
              previousVersion: expectedVersion,
              version,
              releaseId: release?.id ?? null,
              releasePageCount: release?.pageCount ?? null,
              candidateToken: snapshot?.candidate.token ?? null,
              candidateBaselineReleaseId: snapshot?.candidate.baselineReleaseId ?? null,
              candidateCounts: snapshot?.candidate.counts ?? null,
              candidatePresentation: snapshot?.candidate.presentation ?? null,
              reason,
              authority: context.authority,
            }),
          },
        });

        const responseContext = {
          ...context,
          publication: {
            status,
            version,
            publishedAt: status === 'published' ? now : context.publication.publishedAt,
            unpublishedAt: status === 'unpublished' ? now : context.publication.unpublishedAt,
            updatedAt: now,
            updatedBy: context.actorProfileId,
            publishedRelease: release,
          },
        };
        const responseCandidate = (await buildServerWikiReleaseCandidate(tx, candidateInput(responseContext), false)).candidate;
        const responseReview = await this.releaseReviewState(tx, responseContext, responseCandidate.token, false);
        return toResponse(responseContext, blockers, responseCandidate, responseReview);
      });
    } catch (error) {
      if (prismaCode(error) === 'P2034') throw publicationConflict(expectedVersion + 1);
      throw error;
    }
  }

  private async resolveContext(
    store: Prisma.TransactionClient | PrismaService,
    serverId: string,
    actor: ServerWikiPublicationActor,
    lock: boolean,
  ): Promise<PublicationContext> {
    if (lock) {
      await store.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM \`Server\` WHERE id = ${serverId} FOR UPDATE
      `;
    }
    const server = await store.server.findUnique({
      where: { id: serverId },
      select: {
        id: true,
        ownerAccountId: true,
        wikiSpaceId: true,
        wikiPageId: true,
        wikiSlug: true,
        name: true,
        joinHost: true,
        joinPort: true,
        edition: true,
        supportedVersions: true,
        tags: true,
        shortDescription: true,
        longDescription: true,
        websiteUrl: true,
        discordUrl: true,
      },
    });
    if (!server) throw new NotFoundException('Server not found.');
    if (!server.wikiSpaceId || !server.wikiPageId || !server.wikiSlug) throw invalidLink();

    if (lock) {
      await store.$queryRaw<Array<{ id: bigint }>>`
        SELECT id FROM server_wikis WHERE vote_server_id = ${server.id} FOR UPDATE
      `;
    }
    const wiki = await store.serverWiki.findUnique({
      where: { voteServerId: server.id },
      select: {
        id: true,
        voteServerId: true,
        spaceId: true,
        slug: true,
        siteSlug: true,
        status: true,
        publicationStatus: true,
        publicationVersion: true,
        publishedAt: true,
        unpublishedAt: true,
        publicationUpdatedAt: true,
        publicationUpdatedBy: true,
        layoutKey: true,
        navigationOrder: true,
        contributionPolicySource: true,
        editHelpSource: true,
        topNoticeSource: true,
        bottomNoticeSource: true,
        requireContributionPolicyAck: true,
        contributionPolicyVersion: true,
        contentSettingsVersion: true,
        navigationVersion: true,
        publishedRelease: {
          select: {
            id: true,
            version: true,
            publishedAt: true,
            presentationSnapshot: true,
            _count: { select: { items: true } },
          },
        },
      },
    });
    if (
      !wiki
      || wiki.status !== 'active'
      || wiki.voteServerId !== server.id
      || wiki.spaceId !== server.wikiSpaceId
      || wiki.slug !== server.wikiSlug
    ) throw invalidLink();

    if (lock) {
      await store.$queryRaw<Array<{ id: bigint }>>`
        SELECT id FROM wiki_spaces WHERE id = ${wiki.spaceId} FOR UPDATE
      `;
    }
    const space = await store.wikiSpace.findUnique({
      where: { id: wiki.spaceId },
      select: { id: true, spaceType: true, status: true, rootPageId: true, slug: true },
    });
    if (
      !space
      || space.status !== 'active'
      || space.spaceType !== 'server_wiki'
      || space.rootPageId !== server.wikiPageId
      || space.slug !== wiki.slug
    ) throw invalidLink();

    const actorAccountId = await this.resolveCanonicalAccount(store, actor.accountId, lock);
    const ownerAccountId = server.ownerAccountId
      ? await this.resolveCanonicalAccount(store, server.ownerAccountId, lock)
      : null;
    if (lock) {
      await store.$queryRaw<Array<{ id: bigint }>>`
        SELECT id FROM users WHERE account_id = ${actorAccountId} FOR UPDATE
      `;
    }
    const actorProfile = await store.wikiProfile.findUnique({
      where: { accountId: actorAccountId },
      select: { id: true, status: true, mergedIntoProfileId: true },
    });
    const authority = actor.permissions?.includes('server.admin') === true
      ? 'server_admin'
      : ownerAccountId !== null && ownerAccountId === actorAccountId
        ? 'owner'
        : await this.collaboratorAuthority(store, wiki.spaceId, actorProfile, lock);

    return {
      serverId: server.id,
      serverWikiId: wiki.id,
      spaceId: wiki.spaceId,
      rootPageId: space.rootPageId!,
      siteSlug: wiki.siteSlug ?? '',
      contentSlug: wiki.slug,
      serverContent: {
        name: server.name,
        joinHost: server.joinHost,
        joinPort: server.joinPort,
        edition: server.edition,
        supportedVersions: server.supportedVersions,
        tags: server.tags,
        shortDescription: server.shortDescription,
        longDescription: server.longDescription,
        websiteUrl: server.websiteUrl,
        discordUrl: server.discordUrl,
      },
      actorAccountId,
      actorProfileId: actorProfile?.id ?? null,
      authority,
      publication: {
        status: wiki.publicationStatus,
        version: wiki.publicationVersion,
        publishedAt: wiki.publishedAt,
        unpublishedAt: wiki.unpublishedAt,
        updatedAt: wiki.publicationUpdatedAt,
        updatedBy: wiki.publicationUpdatedBy,
        publishedRelease: wiki.publishedRelease
          ? {
              id: wiki.publishedRelease.id,
              version: wiki.publishedRelease.version,
              publishedAt: wiki.publishedRelease.publishedAt,
              pageCount: wiki.publishedRelease._count.items,
              presentationSnapshot: wiki.publishedRelease.presentationSnapshot,
            }
          : null,
      },
      presentation: {
        layoutKey: wiki.layoutKey,
        navigationOrder: wiki.navigationOrder,
        contributionPolicySource: wiki.contributionPolicySource,
        editHelpSource: wiki.editHelpSource,
        topNoticeSource: wiki.topNoticeSource,
        bottomNoticeSource: wiki.bottomNoticeSource,
        requireContributionPolicyAck: wiki.requireContributionPolicyAck,
        contributionPolicyVersion: wiki.contributionPolicyVersion,
        contentSettingsVersion: wiki.contentSettingsVersion,
        navigationVersion: wiki.navigationVersion,
      },
    };
  }

  private async createRelease(
    tx: Prisma.TransactionClient,
    context: PublicationContext,
    snapshot: ReleaseCandidateSnapshot,
    version: number,
    reason: string,
    now: Date,
  ): Promise<NonNullable<PublicationContext['publication']['publishedRelease']>> {
    const releasedPages = snapshot.pages;
    if (releasedPages.length === 0 || releasedPages.some((page) => page.spaceId !== context.spaceId)) {
      throw new ConflictException('Server wiki release snapshot is empty or inconsistent.');
    }
    const releaseLinks = snapshot.links;
    const release = await tx.serverWikiRelease.create({
      data: {
        serverWikiId: context.serverWikiId,
        version,
        reason,
        presentationSnapshot: context.presentation as unknown as Prisma.InputJsonValue,
        createdBy: context.actorProfileId,
        createdAt: now,
        publishedAt: now,
      },
      select: { id: true, version: true, publishedAt: true },
    });
    await tx.serverWikiReleaseItem.createMany({
      data: releasedPages.map((page) => ({
        releaseId: release.id,
        serverWikiId: context.serverWikiId,
        spaceId: context.spaceId,
        namespaceId: page.namespaceId,
        pageId: page.id,
        revisionId: page.currentRevisionId!,
        localPath: page.localPath,
        slug: page.slug,
        title: page.title,
        displayTitle: page.displayTitle,
        pageType: page.pageType,
        protectionLevel: page.protectionLevel,
        pageStatus: page.status,
        createdBy: page.createdBy,
        ownerProfileId: page.ownerProfileId,
        pageUpdatedAt: page.updatedAt,
        searchVector: buildWikiSearchVector([
          page.title,
          page.displayTitle,
          page.slug,
          page.localPath,
          snapshot.revisionContentByPageId.get(page.id) ?? '',
        ]),
        createdAt: now,
      })),
    });
    if (releaseLinks.length > 0) {
      await tx.serverWikiReleaseLink.createMany({
        data: releaseLinks.map((link) => ({
          releaseId: release.id,
          serverWikiId: context.serverWikiId,
          spaceId: context.spaceId,
          sourcePageId: link.sourcePageId,
          sourceRevisionId: link.sourceRevisionId,
          targetNamespaceCode: link.targetNamespaceCode,
          targetSlug: link.targetSlug,
          linkType: link.linkType,
          createdAt: now,
        })),
      });
    }
    return {
      ...release,
      pageCount: releasedPages.length,
      presentationSnapshot: context.presentation as unknown as Prisma.JsonValue,
    };
  }

  private async releaseReviewState(
    store: Prisma.TransactionClient | PrismaService,
    context: PublicationContext,
    candidateToken: string,
    lock: boolean,
  ): Promise<ServerWikiReleaseReviewState> {
    if (lock) {
      await store.$queryRaw<Array<{ id: bigint }>>`
        SELECT id
        FROM subwiki_roles
        WHERE space_id = ${context.spaceId} AND role = 'reviewer' AND status = 'active'
        ORDER BY id
        FOR UPDATE
      `;
      await store.$queryRaw<Array<{ id: bigint }>>`
        SELECT id
        FROM server_wiki_release_approvals
        WHERE server_wiki_id = ${context.serverWikiId} AND candidate_token = ${candidateToken}
        ORDER BY id
        FOR UPDATE
      `;
    }
    const reviewerRoles = await store.subwikiRole.findMany({
      where: { spaceId: context.spaceId, role: 'reviewer', status: 'active' },
      select: { userId: true },
    });
    const reviewerProfileIds = [...new Set(reviewerRoles.map((role) => role.userId))];
    const activeProfiles = reviewerProfileIds.length > 0
      ? await store.wikiProfile.findMany({
          where: { id: { in: reviewerProfileIds }, status: 'active', mergedIntoProfileId: null },
          select: { id: true },
        })
      : [];
    const activeReviewerIds = new Set(activeProfiles.map((profile) => profile.id));
    const approvalRows = activeReviewerIds.size > 0
      ? await store.serverWikiReleaseApproval.findMany({
          where: {
            serverWikiId: context.serverWikiId,
            spaceId: context.spaceId,
            candidateToken,
            reviewerProfileId: { in: [...activeReviewerIds] },
            revokedAt: null,
          },
          orderBy: [{ approvedAt: 'asc' }, { id: 'asc' }],
          select: { reviewerProfileId: true, approvedAt: true },
        })
      : [];
    const approvals = approvalRows.map((approval) => ({
      reviewerProfileId: approval.reviewerProfileId.toString(),
      approvedAt: approval.approvedAt.toISOString(),
    }));
    const viewerApproved = context.actorProfileId !== null
      && approvalRows.some((approval) => approval.reviewerProfileId === context.actorProfileId);
    const approved = approvalRows.length > 0;
    return {
      required: activeReviewerIds.size > 0,
      approved,
      canApprove: context.authority === 'reviewer',
      viewerApproved,
      approvals,
    };
  }

  private async collaboratorAuthority(
    store: Prisma.TransactionClient | PrismaService,
    spaceId: bigint,
    profile: { readonly id: bigint; readonly status: string; readonly mergedIntoProfileId: bigint | null } | null,
    lock: boolean,
  ): Promise<'manager' | 'reviewer'> {
    if (!profile || profile.status !== 'active' || profile.mergedIntoProfileId !== null) throw publicationForbidden();
    if (lock) {
      await store.$queryRaw<Array<{ id: bigint }>>`
        SELECT id
        FROM subwiki_roles
        WHERE space_id = ${spaceId} AND user_id = ${profile.id}
        ORDER BY id
        FOR UPDATE
      `;
    }
    const roles = await store.subwikiRole.findMany({
      where: { spaceId, userId: profile.id, status: 'active' },
      select: { role: true },
    });
    const collaboratorRoles = roles.filter((row) => ['manager', 'editor', 'reviewer'].includes(row.role));
    const role = collaboratorRoles.length === 1 ? collaboratorRoles[0]?.role : null;
    if (role !== 'manager' && role !== 'reviewer') throw publicationForbidden();
    return role;
  }

  private async readinessBlockers(
    store: Prisma.TransactionClient | PrismaService,
    context: PublicationContext,
  ): Promise<ServerWikiPublicationReadinessBlocker[]> {
    const blockers: ServerWikiPublicationReadinessBlocker[] = [];
    if (!SITE_SLUG_PATTERN.test(context.siteSlug)) blockers.push('invalid_site_slug');
    const root = await store.wikiPage.findUnique({
      where: { id: context.rootPageId },
      select: { id: true, spaceId: true, status: true, currentRevisionId: true },
    });
    if (!root || root.spaceId !== context.spaceId) {
      blockers.push('missing_root_page');
      return blockers;
    }
    const rootRevision = root.currentRevisionId
      ? await store.wikiPageRevision.findUnique({
          where: { id: root.currentRevisionId },
          select: { pageId: true, visibility: true },
        })
      : null;
    if (
      !isPublicWikiPageStatus(root.status)
      || !rootRevision
      || rootRevision.pageId !== root.id
      || rootRevision.visibility !== 'public'
    ) blockers.push('missing_public_root_revision');

    const starterPages = buildServerWikiStarterPages(context.serverContent);
    const requiredPaths = [
      context.contentSlug,
      ...starterPages.map((page) => `${context.contentSlug}/${page.path}`),
    ];
    const documents = await store.wikiPage.findMany({
      where: {
        spaceId: context.spaceId,
        localPath: { in: requiredPaths },
      },
      select: {
        id: true,
        localPath: true,
        status: true,
        currentRevisionId: true,
        searchDocument: { select: { revisionId: true } },
      },
    });
    const revisions = documents.length > 0
      ? await store.wikiPageRevision.findMany({
          where: {
            id: { in: documents.flatMap((page) => page.currentRevisionId ? [page.currentRevisionId] : []) },
            visibility: 'public',
          },
          select: { id: true, pageId: true, contentHash: true },
        })
      : [];
    const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
    const documentByPath = new Map(documents.map((page) => [page.localPath, page]));
    const isPublicCurrentDocument = (path: string): boolean => {
      const page = documentByPath.get(path);
      if (!page || !isPublicWikiPageStatus(page.status) || page.currentRevisionId === null) return false;
      const revision = revisionById.get(page.currentRevisionId);
      return Boolean(revision && revision.pageId === page.id);
    };
    const publicRequiredPaths = requiredPaths.filter(isPublicCurrentDocument);
    if (publicRequiredPaths.length === 0) blockers.push('missing_public_document');
    if (publicRequiredPaths.length !== requiredPaths.length) blockers.push('missing_required_documents');

    if (isPublicCurrentDocument(context.contentSlug)) {
      const page = documentByPath.get(context.contentSlug)!;
      const revision = revisionById.get(page.currentRevisionId!)!;
      const introductionCustomized = revision.contentHash !== hashContent(buildServerWikiMainPage(context.serverContent));
      if (!introductionCustomized && context.serverContent.longDescription.trim().length < 80) {
        blockers.push('incomplete_introduction');
      }
    }

    const rulesPath = `${context.contentSlug}/규칙`;
    if (isPublicCurrentDocument(rulesPath)) {
      const page = documentByPath.get(rulesPath)!;
      const revision = revisionById.get(page.currentRevisionId!)!;
      const starterRules = starterPages.find((page) => page.path === '규칙');
      if (starterRules && revision.contentHash === hashContent(starterRules.contentRaw)) {
        blockers.push('placeholder_rules');
      }
    }

    if (!context.serverContent.websiteUrl && !context.serverContent.discordUrl) {
      blockers.push('missing_official_channel');
    }
    if (
      publicRequiredPaths.length === requiredPaths.length
      && requiredPaths.some((path) => {
        const page = documentByPath.get(path)!;
        return page.searchDocument?.revisionId !== page.currentRevisionId;
      })
    ) blockers.push('search_index_not_ready');
    return blockers;
  }

  private async resolveCanonicalAccount(
    store: Prisma.TransactionClient | PrismaService,
    accountIdInput: string,
    lock: boolean,
  ): Promise<string> {
    let accountId = parseActorAccountId(accountIdInput);
    const visited = new Set<string>();
    for (let depth = 0; depth < MAX_CANONICAL_ACCOUNT_DEPTH; depth += 1) {
      if (visited.has(accountId)) throw new ConflictException('Account alias chain is inconsistent.');
      visited.add(accountId);
      if (lock) {
        await store.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM \`Account\` WHERE id = ${accountId} FOR UPDATE
        `;
      }
      const account = await store.account.findUnique({
        where: { id: accountId },
        select: { id: true, canonicalAccountId: true, lifecycleStatus: true },
      });
      if (!account || account.lifecycleStatus !== 'active') throw publicationForbidden();
      if (!account.canonicalAccountId || account.canonicalAccountId === account.id) return account.id;
      accountId = account.canonicalAccountId;
    }
    throw new ConflictException('Account alias chain is too deep.');
  }

  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_SERIALIZABLE_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (prismaCode(error) !== 'P2034' || attempt === MAX_SERIALIZABLE_ATTEMPTS) throw error;
      }
    }
    throw publicationConflict(0);
  }
}

function toResponse(
  context: PublicationContext,
  blockers: readonly ServerWikiPublicationReadinessBlocker[],
  candidate: ServerWikiReleaseCandidate,
  review: ServerWikiReleaseReviewState,
): ServerWikiPublicationResponse {
  if (!SERVER_WIKI_PUBLICATION_STATUSES.includes(context.publication.status as ServerWikiPublicationStatus)) {
    throw new ConflictException('Server wiki publication state is invalid.');
  }
  return {
    serverId: context.serverId,
    serverWikiId: context.serverWikiId.toString(),
    status: context.publication.status as ServerWikiPublicationStatus,
    version: context.publication.version,
    publishedAt: context.publication.publishedAt?.toISOString() ?? null,
    unpublishedAt: context.publication.unpublishedAt?.toISOString() ?? null,
    updatedAt: context.publication.updatedAt?.toISOString() ?? null,
    updatedByProfileId: context.publication.updatedBy?.toString() ?? null,
    release: context.publication.publishedRelease
      ? {
          id: context.publication.publishedRelease.id.toString(),
          version: context.publication.publishedRelease.version,
          publishedAt: context.publication.publishedRelease.publishedAt.toISOString(),
          pageCount: context.publication.publishedRelease.pageCount,
        }
      : null,
    wikiUrl: `/serverWiki/${encodeURIComponent(context.siteSlug)}`,
    access: {
      authority: context.authority,
      canPublish: context.authority !== 'reviewer',
      canApprove: context.authority === 'reviewer',
    },
    readiness: { ready: blockers.length === 0, blockers },
    candidate,
    review,
  };
}

function candidateInput(context: PublicationContext) {
  return {
    serverWikiId: context.serverWikiId,
    spaceId: context.spaceId,
    siteSlug: context.siteSlug,
    contentSlug: context.contentSlug,
    publishedRelease: context.publication.publishedRelease,
    presentation: context.presentation,
  };
}

function parseServerId(value: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new BadRequestException('serverId must be a UUID.');
  return value.toLowerCase();
}

function parseActorAccountId(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 191) throw publicationForbidden();
  return value;
}

function parseMutationStatus(value: string): 'published' | 'unpublished' {
  if (value !== 'published' && value !== 'unpublished') {
    throw new BadRequestException('status must be published or unpublished.');
  }
  return value;
}

function parseVersion(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 4_294_967_295) {
    throw new BadRequestException('expectedVersion must be an unsigned integer.');
  }
  return value;
}

function parseReason(value: string): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < REASON_MIN_LENGTH || reason.length > REASON_MAX_LENGTH) {
    throw new BadRequestException(`reason must contain between ${REASON_MIN_LENGTH} and ${REASON_MAX_LENGTH} characters.`);
  }
  return reason;
}

function parseCandidateToken(value: string | undefined): string {
  if (typeof value !== 'string' || !CANDIDATE_TOKEN_PATTERN.test(value)) {
    throw new BadRequestException('expectedCandidateToken must be a 64-character lowercase SHA-256 token.');
  }
  return value;
}

function invalidLink(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'SERVER_WIKI_PUBLICATION_INVALID_LINK',
    message: 'Server wiki linkage or lifecycle is inconsistent.',
    blockers: ['invalid_link'],
  });
}

function publicationForbidden(): ForbiddenException {
  return new ForbiddenException('Server wiki publication requires the server owner, a wiki manager, or server.admin.');
}

function reviewForbidden(): ForbiddenException {
  return new ForbiddenException('Server wiki release review requires an active reviewer role.');
}

function publicationConflict(currentVersion: number): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'SERVER_WIKI_PUBLICATION_CONFLICT',
    message: 'Server wiki publication changed concurrently. Refresh and retry.',
    currentVersion,
  });
}

function candidateChanged(candidate: ServerWikiReleaseCandidate): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'SERVER_WIKI_RELEASE_CANDIDATE_CHANGED',
    message: 'Server wiki release candidate changed. Review the latest manifest and retry.',
    candidate,
  });
}

function prismaCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : null;
}

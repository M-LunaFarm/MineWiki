import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isPublicWikiPageStatus } from '@minewiki/wiki-core/page-status';
import { hashContent } from '@minewiki/wiki-core';
import { PrismaService } from '../common/prisma.service';
import { toAuditJson } from '../events/business-event.service';
import { writeAuditRecord } from '../events/audit-event-writer';
import { buildServerWikiMainPage, buildServerWikiStarterPages, type ServerWikiScaffoldInput } from './server-wiki-scaffold';

export const SERVER_WIKI_PUBLICATION_STATUSES = ['draft', 'published', 'unpublished'] as const;
export type ServerWikiPublicationStatus = (typeof SERVER_WIKI_PUBLICATION_STATUSES)[number];

export interface ServerWikiPublicationActor {
  readonly accountId: string;
  readonly permissions?: readonly string[];
}

export interface UpdateServerWikiPublicationInput {
  readonly status: 'published' | 'unpublished';
  readonly expectedVersion: number;
  readonly reason: string;
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
  readonly wikiUrl: string;
  readonly access: {
    readonly authority: 'server_admin' | 'owner' | 'manager';
    readonly canPublish: true;
  };
  readonly readiness: {
    readonly ready: boolean;
    readonly blockers: readonly ServerWikiPublicationReadinessBlocker[];
  };
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
  readonly authority: 'server_admin' | 'owner' | 'manager';
  readonly publication: {
    readonly status: string;
    readonly version: number;
    readonly publishedAt: Date | null;
    readonly unpublishedAt: Date | null;
    readonly updatedAt: Date | null;
    readonly updatedBy: bigint | null;
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SITE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u;
const MAX_CANONICAL_ACCOUNT_DEPTH = 16;
const MAX_SERIALIZABLE_ATTEMPTS = 3;
const REASON_MIN_LENGTH = 5;
const REASON_MAX_LENGTH = 500;

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
    return toResponse(context, blockers);
  }

  async update(
    serverIdInput: string,
    input: UpdateServerWikiPublicationInput,
    actor: ServerWikiPublicationActor,
  ): Promise<ServerWikiPublicationResponse> {
    const serverId = parseServerId(serverIdInput);
    const status = parseMutationStatus(input.status);
    const expectedVersion = parseVersion(input.expectedVersion);
    const reason = parseReason(input.reason);

    try {
      return await this.serializable(async (tx) => {
        const context = await this.resolveContext(tx, serverId, actor, true);
        if (context.publication.version !== expectedVersion) {
          throw publicationConflict(context.publication.version);
        }
        if (context.publication.status === status) {
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

        const now = new Date();
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
          },
        });
        if (changed.count !== 1) {
          const latest = await tx.serverWiki.findUnique({
            where: { id: context.serverWikiId },
            select: { publicationVersion: true },
          });
          throw publicationConflict(latest?.publicationVersion ?? expectedVersion + 1);
        }

        const version = expectedVersion + 1;
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
              reason,
              authority: context.authority,
            }),
          },
        });

        return toResponse({
          ...context,
          publication: {
            status,
            version,
            publishedAt: status === 'published' ? now : context.publication.publishedAt,
            unpublishedAt: status === 'unpublished' ? now : context.publication.unpublishedAt,
            updatedAt: now,
            updatedBy: context.actorProfileId,
          },
        }, blockers);
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
        : await this.managerAuthority(store, wiki.spaceId, actorProfile, lock);

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
      },
    };
  }

  private async managerAuthority(
    store: Prisma.TransactionClient | PrismaService,
    spaceId: bigint,
    profile: { readonly id: bigint; readonly status: string; readonly mergedIntoProfileId: bigint | null } | null,
    lock: boolean,
  ): Promise<'manager'> {
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
    if (collaboratorRoles.length !== 1 || collaboratorRoles[0]?.role !== 'manager') throw publicationForbidden();
    return 'manager';
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
    wikiUrl: `/serverWiki/${encodeURIComponent(context.siteSlug)}`,
    access: { authority: context.authority, canPublish: true },
    readiness: { ready: blockers.length === 0, blockers },
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

function publicationConflict(currentVersion: number): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'SERVER_WIKI_PUBLICATION_CONFLICT',
    message: 'Server wiki publication changed concurrently. Refresh and retry.',
    currentVersion,
  });
}

function prismaCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : null;
}

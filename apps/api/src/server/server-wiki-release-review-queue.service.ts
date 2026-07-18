import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { readCanonicalAccountGroup } from '../auth/account-lifecycle-fence';
import { PrismaService } from '../common/prisma.service';
import { WikiEditService } from '../wiki/wiki-edit.service';
import type { ServerWikiReleaseCandidate } from './server-wiki-release-candidate';
import type { ServerWikiReleaseCandidatePageKind } from './server-wiki-release-candidate';
import { ServerWikiReleaseManifestCursorCodec } from './server-wiki-release-manifest-cursor';
import { serverWikiReleaseReviewState } from './server-wiki-release-review';

export interface ServerWikiReleaseReviewQueueItem {
  readonly candidateId: string;
  readonly candidateToken: string;
  readonly serverId: string;
  readonly serverWikiId: string;
  readonly serverName: string;
  readonly siteSlug: string | null;
  readonly status: string;
  readonly submittedAt: string;
  readonly submittedByProfileId: string | null;
  readonly submissionReason: string;
  readonly counts: ServerWikiReleaseCandidate['counts'];
  readonly presentation: ServerWikiReleaseCandidate['presentation'];
  readonly requiredApprovals: number;
}

@Injectable()
export class ServerWikiReleaseReviewQueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly manifestCursors: ServerWikiReleaseManifestCursorCodec = new ServerWikiReleaseManifestCursorCodec(),
    @Optional() private readonly wikiEdit?: WikiEditService,
  ) {}

  async list(accountId: string, cursorInput?: string, limitInput?: string) {
    const viewer = await this.resolveReviewer(accountId);
    const limit = parseLimit(limitInput);
    const cursor = parseCursor(cursorInput);
    if (!viewer) return { items: [], nextCursor: null, viewerProfileId: null };
    const rows = await this.prisma.serverWikiReleaseCandidate.findMany({
      where: {
        status: 'pending_review',
        spaceId: { in: [...viewer.spaceIds] },
        ...(cursor ? { id: { lt: cursor } } : {}),
        serverWiki: { status: 'active', voteServerId: { not: null } },
      },
      orderBy: [{ id: 'desc' }],
      take: limit + 1,
      select: queueCandidateSelection,
    });
    const returned = rows.slice(0, limit);
    return {
      items: returned.map(toQueueItem),
      nextCursor: rows.length > limit ? returned.at(-1)?.id.toString() ?? null : null,
      viewerProfileId: viewer.profileId.toString(),
    };
  }

  async summary(accountId: string) {
    const viewer = await this.resolveReviewer(accountId);
    if (!viewer) return { count: 0, capped: false };
    const count = await this.prisma.serverWikiReleaseCandidate.count({
      where: {
        status: 'pending_review',
        spaceId: { in: [...viewer.spaceIds] },
        serverWiki: { status: 'active', voteServerId: { not: null } },
      },
    });
    return { count: Math.min(count, 100), capped: count > 100 };
  }

  async get(accountId: string, candidateIdInput: string) {
    const candidateId = parseCandidateId(candidateIdInput);
    const viewer = await this.resolveReviewer(accountId);
    if (!viewer) throw reviewNotFound();
    const row = await this.prisma.serverWikiReleaseCandidate.findFirst({
      where: {
        id: candidateId,
        status: 'pending_review',
        spaceId: { in: [...viewer.spaceIds] },
        serverWiki: { status: 'active', voteServerId: { not: null } },
      },
      select: queueCandidateSelection,
    });
    if (!row) throw reviewNotFound();
    const manifest = parseManifest(row.manifestSnapshot, row.token);
    const review = await serverWikiReleaseReviewState(this.prisma, {
      serverWikiId: row.serverWikiId,
      spaceId: row.spaceId,
      actorProfileId: viewer.profileId,
      authority: 'reviewer',
    }, row.id, row.requiredApprovals, false);
    return {
      ...toQueueItem(row),
      manifest: manifestSummary(manifest),
      review,
      wikiUrl: `/serverWiki/${encodeURIComponent(row.serverWiki.siteSlug ?? '')}`,
    };
  }

  async pages(
    accountId: string,
    candidateIdInput: string,
    kindsInput?: string,
    cursorInput?: string,
    limitInput?: string,
  ) {
    const candidateId = parseCandidateId(candidateIdInput);
    const kinds = parseKinds(kindsInput);
    const viewer = await this.resolveReviewer(accountId);
    if (!viewer) throw reviewNotFound();
    const row = await this.prisma.serverWikiReleaseCandidate.findFirst({
      where: {
        id: candidateId,
        status: 'pending_review',
        spaceId: { in: [...viewer.spaceIds] },
        serverWiki: { status: 'active', voteServerId: { not: null } },
      },
      select: queueCandidateSelection,
    });
    if (!row) throw reviewNotFound();
    const manifest = parseManifest(row.manifestSnapshot, row.token);
    const binding = {
      candidateId: row.id.toString(),
      candidateToken: row.token,
      serverWikiId: row.serverWikiId.toString(),
      spaceId: row.spaceId.toString(),
      kinds,
    } as const;
    const afterPageId = cursorInput ? BigInt(this.manifestCursors.decode(cursorInput, binding)) : null;
    const limit = parseLimit(limitInput);
    const filtered = manifest.pages
      .filter((page) => kinds.includes(page.kind) && (afterPageId === null || BigInt(page.pageId) > afterPageId))
      .sort((left, right) => BigInt(left.pageId) < BigInt(right.pageId) ? -1 : BigInt(left.pageId) > BigInt(right.pageId) ? 1 : 0);
    const items = filtered.slice(0, limit).map((page) => ({
      ...page,
      previewPath: null,
      diffPath: page.contentChanged && page.before && page.after
        ? `/wiki/release-reviews/${row.id.toString()}/pages/${page.pageId}/diff`
        : null,
    }));
    return {
      items,
      nextCursor: filtered.length > limit && items.length > 0
        ? this.manifestCursors.encode(binding, items.at(-1)!.pageId)
        : null,
      kinds,
    };
  }

  async diff(accountId: string, candidateIdInput: string, pageIdInput: string) {
    const candidateId = parseCandidateId(candidateIdInput);
    const pageId = parseCandidateId(pageIdInput);
    const viewer = await this.resolveReviewer(accountId);
    if (!viewer) throw reviewNotFound();
    const row = await this.prisma.serverWikiReleaseCandidate.findFirst({
      where: {
        id: candidateId,
        status: 'pending_review',
        spaceId: { in: [...viewer.spaceIds] },
        serverWiki: { status: 'active', voteServerId: { not: null } },
      },
      select: {
        id: true, serverWikiId: true, spaceId: true, token: true,
        manifestSnapshot: true, releaseSnapshot: true,
      },
    });
    if (!row) throw reviewNotFound();
    const manifest = parseManifest(row.manifestSnapshot, row.token);
    const page = manifest.pages.find((item) => item.pageId === pageId.toString());
    if (!page?.contentChanged || !page.before || !page.after || !manifest.baselineReleaseId) throw reviewNotFound();
    const baselineReleaseId = parseCandidateId(manifest.baselineReleaseId);
    const beforeRevisionId = parseCandidateId(page.before.revisionId);
    const afterRevisionId = parseCandidateId(page.after.revisionId);
    const baseline = await this.prisma.serverWikiReleaseItem.findFirst({
      where: {
        releaseId: baselineReleaseId,
        serverWikiId: row.serverWikiId,
        spaceId: row.spaceId,
        pageId,
        revisionId: beforeRevisionId,
      },
      select: { id: true },
    });
    if (!baseline || !releaseSnapshotContains(row.releaseSnapshot, row.spaceId, pageId, afterRevisionId)) {
      throw corruptCandidate();
    }
    if (!this.wikiEdit) throw new ServiceUnavailableException('Candidate diff service is unavailable.');
    return this.wikiEdit.getRevisionDiff(
      beforeRevisionId.toString(),
      afterRevisionId.toString(),
      accountId,
      { allowedSpaceId: row.spaceId },
    );
  }

  private async resolveReviewer(accountId: string): Promise<{
    readonly profileId: bigint;
    readonly spaceIds: readonly bigint[];
  } | null> {
    const group = await readCanonicalAccountGroup(this.prisma, accountId);
    const activeAccounts = await this.prisma.account.count({
      where: { id: { in: [...group.accountIds] }, lifecycleStatus: 'active' },
    });
    if (activeAccounts !== group.accountIds.length) throw reviewNotFound();
    const profiles = await this.prisma.wikiProfile.findMany({
      where: {
        accountId: { in: [...group.accountIds] },
        status: 'active',
        mergedIntoProfileId: null,
      },
      select: { id: true },
    });
    if (profiles.length === 0) return null;
    if (profiles.length !== 1) throw new ConflictException('Wiki reviewer profile linkage is inconsistent.');
    const roles = await this.prisma.subwikiRole.findMany({
      where: { userId: profiles[0]!.id, role: 'reviewer', status: 'active' },
      select: { spaceId: true },
    });
    const spaceIds = [...new Set(roles.map((role) => role.spaceId))];
    return spaceIds.length > 0 ? { profileId: profiles[0]!.id, spaceIds } : null;
  }
}

const queueCandidateSelection = Prisma.validator<Prisma.ServerWikiReleaseCandidateSelect>()({
  id: true,
  serverWikiId: true,
  spaceId: true,
  token: true,
  status: true,
  submittedAt: true,
  createdBy: true,
  submissionReason: true,
  requiredApprovals: true,
  manifestSnapshot: true,
  serverWiki: { select: { voteServerId: true, serverName: true, siteSlug: true } },
});

function toQueueItem(row: Prisma.ServerWikiReleaseCandidateGetPayload<{ select: typeof queueCandidateSelection }>): ServerWikiReleaseReviewQueueItem {
  const manifest = parseManifest(row.manifestSnapshot, row.token);
  if (!row.serverWiki.voteServerId) throw corruptCandidate();
  return {
    candidateId: row.id.toString(),
    candidateToken: row.token,
    serverId: row.serverWiki.voteServerId,
    serverWikiId: row.serverWikiId.toString(),
    serverName: row.serverWiki.serverName,
    siteSlug: row.serverWiki.siteSlug,
    status: row.status,
    submittedAt: row.submittedAt.toISOString(),
    submittedByProfileId: row.createdBy?.toString() ?? null,
    submissionReason: row.submissionReason,
    counts: manifest.counts,
    presentation: manifest.presentation,
    requiredApprovals: row.requiredApprovals,
  };
}

function parseManifest(value: Prisma.JsonValue, token: string): ServerWikiReleaseCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corruptCandidate();
  const manifest = value as unknown as ServerWikiReleaseCandidate;
  if (manifest.token !== token || !Array.isArray(manifest.pages) || !manifest.counts || !manifest.presentation) {
    throw corruptCandidate();
  }
  return manifest;
}

function parseCandidateId(value: string): bigint {
  if (!/^[1-9][0-9]{0,19}$/u.test(value)) throw new BadRequestException('candidateId must be a positive integer string.');
  return BigInt(value);
}

function parseCursor(value?: string): bigint | null {
  if (value === undefined || value === '') return null;
  return parseCandidateId(value);
}

function parseLimit(value?: string): number {
  if (value === undefined || value === '') return 20;
  if (!/^[0-9]+$/u.test(value)) throw new BadRequestException('limit must be an integer between 1 and 50.');
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException('limit must be an integer between 1 and 50.');
  return limit;
}

const candidateKinds = ['added', 'updated', 'moved', 'removed', 'unchanged'] as const;
const defaultCandidateKinds: readonly ServerWikiReleaseCandidatePageKind[] = ['added', 'updated', 'moved', 'removed'];

function parseKinds(value?: string): readonly ServerWikiReleaseCandidatePageKind[] {
  if (value === undefined || value === '') return defaultCandidateKinds;
  const requested = value.split(',');
  if (requested.some((kind) => !candidateKinds.includes(kind as ServerWikiReleaseCandidatePageKind))) {
    throw new BadRequestException('kinds must contain only added, updated, moved, removed, or unchanged.');
  }
  const unique = candidateKinds.filter((kind) => requested.includes(kind));
  if (unique.length !== requested.length || unique.length === 0) {
    throw new BadRequestException('kinds must contain distinct release candidate page kinds.');
  }
  return unique;
}

function manifestSummary(manifest: ServerWikiReleaseCandidate) {
  return {
    token: manifest.token,
    baselineReleaseId: manifest.baselineReleaseId,
    generatedAt: manifest.generatedAt,
    counts: manifest.counts,
    presentation: manifest.presentation,
    hasChanges: manifest.hasChanges,
    totalPageCount: manifest.pages.length,
  };
}

function releaseSnapshotContains(value: Prisma.JsonValue, spaceId: bigint, pageId: bigint, revisionId: bigint): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pages = (value as Prisma.JsonObject).pages;
  if (!Array.isArray(pages)) return false;
  return pages.some((item) => item !== null && typeof item === 'object' && !Array.isArray(item)
    && item.id === pageId.toString()
    && item.spaceId === spaceId.toString()
    && item.currentRevisionId === revisionId.toString());
}

function reviewNotFound(): NotFoundException {
  return new NotFoundException('Release review was not found.');
}

function corruptCandidate(): ConflictException {
  return new ConflictException('Stored release candidate manifest is inconsistent.');
}

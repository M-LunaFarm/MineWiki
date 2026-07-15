import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { wikiUrl } from '@minewiki/wiki-core';
import type { Prisma, WikiEditRequest } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import type { SessionPayload } from '../session/session.service';
import { WikiEditService, type WikiEditConflictDetails } from './wiki-edit.service';
import { assertWikiSourceBounds, hasWikiConflictMarkers, mergeWikiSource, WikiMergeLimitError } from './wiki-merge';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiNotificationService } from './wiki-notification.service';
import { WikiRoutePathResolver } from './wiki-route-path.resolver';

export interface WikiEditRequestSummary {
  readonly id: string;
  readonly pageId: string;
  readonly baseRevisionId: string;
  readonly proposedContent: string;
  readonly editSummary: string;
  readonly isMinor: boolean;
  readonly status: string;
  readonly createdBy: string;
  readonly createdByName: string;
  readonly reviewedBy: string | null;
  readonly reviewedByName: string | null;
  readonly reviewNote: string | null;
  readonly acceptedRevisionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedAt: string | null;
}

export interface WikiEditRequestListResponse {
  readonly items: WikiEditRequestSummary[];
  readonly canReview: boolean;
  readonly viewerProfileId: string | null;
  readonly nextCursor: string | null;
  readonly currentRevisionId: string | null;
}

export interface WikiEditRequestDiffResponse {
  readonly requestId: string;
  readonly baseRevisionId: string;
  readonly hunks: ReadonlyArray<{ readonly type: 'context' | 'added' | 'removed'; readonly line: string; readonly leftLine: number | null; readonly rightLine: number | null }>;
}

export interface WikiEditRequestQueueItem extends WikiEditRequestSummary {
  readonly pageTitle: string;
  readonly pageDisplayTitle: string;
  readonly namespace: string;
  readonly routePath: string;
  readonly currentRevisionId: string | null;
  readonly canReview: boolean;
  readonly isStale: boolean;
}

export interface WikiEditRequestQueueResponse {
  readonly items: WikiEditRequestQueueItem[];
  readonly viewerProfileId: string | null;
  readonly nextCursor: string | null;
}

@Injectable()
export class WikiEditRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: WikiProfileService,
    private readonly permissions: WikiPermissionService,
    private readonly edits: WikiEditService,
    @Optional() private readonly events?: BusinessEventService,
    @Optional() private readonly notifications?: WikiNotificationService,
    @Optional() private readonly routePaths?: WikiRoutePathResolver
  ) {}

  async listGlobal(
    session: SessionPayload | null,
    input: {
      readonly status?: string;
      readonly scope?: string;
      readonly namespace?: string;
      readonly cursor?: string;
      readonly limit?: string | number;
    } = {}
  ): Promise<WikiEditRequestQueueResponse> {
    const status = input.status?.trim() || 'open';
    const allowedStatuses = new Set(['open', 'all', 'pending', 'reviewing', 'stale', 'accepted', 'rejected', 'closed']);
    if (!allowedStatuses.has(status)) throw new BadRequestException('Unsupported edit request status filter.');
    const scope = input.scope?.trim() || 'all';
    if (!['all', 'mine'].includes(scope)) throw new BadRequestException('Unsupported edit request scope.');
    const namespaceFilter = input.namespace?.trim() || null;
    if (namespaceFilter && !/^[a-z][a-z0-9_-]{0,31}$/u.test(namespaceFilter)) {
      throw new BadRequestException('Invalid namespace filter.');
    }
    const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 50);
    const cursor = input.cursor ? this.id(input.cursor, 'cursor') : null;
    const profile = session ? await this.profiles.ensureWikiProfile(session.userId) : null;
    if (scope === 'mine' && !profile) throw new ForbiddenException('Sign in to view your edit requests.');
    const statusFilter = status === 'all'
      ? undefined
      : status === 'open'
        ? { in: ['pending', 'reviewing', 'stale'] }
        : status;
    const scanLimit = Math.min(Math.max(limit * 4, 40), 100);
    const requests = await this.prisma.wikiEditRequest.findMany({
      where: {
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(scope === 'mine' && profile ? { createdBy: profile.id } : {}),
        ...(cursor ? { id: { lt: cursor } } : {})
      },
      orderBy: [{ id: 'desc' }],
      take: scanLimit
    });
    const pageIds = [...new Set(requests.map((request) => request.pageId))];
    const pages = pageIds.length > 0
      ? await this.prisma.wikiPage.findMany({ where: { id: { in: pageIds }, status: { not: 'deleted' } } })
      : [];
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const namespaceIds = [...new Set(pages.map((page) => page.namespaceId))];
    const namespaces = namespaceIds.length > 0
      ? await this.prisma.wikiNamespace.findMany({ where: { id: { in: namespaceIds } }, select: { id: true, code: true } })
      : [];
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    const routes = await this.routePaths?.preload(pages, namespaceById);
    const visible: Array<{ request: WikiEditRequest; page: typeof pages[number]; canReview: boolean; namespace: string }> = [];
    for (const request of requests) {
      const page = pageById.get(request.pageId);
      const namespace = page ? namespaceById.get(page.namespaceId) : null;
      if (!page || !namespace || (namespaceFilter && namespace !== namespaceFilter)) continue;
      try {
        await this.permissions.assertCanReadPage({ accountId: session?.userId ?? null, page });
        await this.permissions.assertCanUsePageAction({ accountId: session?.userId ?? null, action: 'raw', page });
      } catch {
        continue;
      }
      const canReview = Boolean(session && profile && await this.permissions.canManagePage({
        actor: this.permissions.actorFromSession(session, profile),
        page
      }));
      visible.push({ request, page, canReview, namespace });
      if (visible.length > limit) break;
    }
    const returned = visible.slice(0, limit);
    const summaries = new Map((await this.present(returned.map((item) => item.request))).map((item) => [item.id, item]));
    const items = returned.flatMap((item): WikiEditRequestQueueItem[] => {
      const summary = summaries.get(item.request.id.toString());
      if (!summary) return [];
      return [{
        ...summary,
        pageTitle: item.page.title,
        pageDisplayTitle: item.page.displayTitle,
        namespace: item.namespace,
        routePath: routes?.routePath(item.page, item.namespace) ?? wikiUrl(item.namespace as Parameters<typeof wikiUrl>[0], item.page.title),
        currentRevisionId: item.page.currentRevisionId?.toString() ?? null,
        canReview: item.canReview,
        isStale: ['pending', 'reviewing', 'stale'].includes(item.request.status) && item.page.currentRevisionId !== item.request.baseRevisionId
      }];
    });
    const hasMore = visible.length > limit || requests.length === scanLimit;
    const nextCursor = hasMore
      ? (returned.at(-1)?.request.id ?? requests.at(-1)?.id)?.toString() ?? null
      : null;
    return { items, viewerProfileId: profile?.id.toString() ?? null, nextCursor };
  }

  async list(pageId: string, session: SessionPayload | null, cursor?: string, requestedLimit: string | number = 30): Promise<WikiEditRequestListResponse> {
    const page = await this.page(pageId);
    await this.permissions.assertCanReadPage({ accountId: session?.userId ?? null, page });
    await this.permissions.assertCanUsePageAction({ accountId: session?.userId ?? null, action: 'raw', page });
    const limit = Math.min(Math.max(Number(requestedLimit) || 30, 1), 100);
    const parsedCursor = cursor ? this.id(cursor, 'cursor') : null;
    const requests = await this.prisma.wikiEditRequest.findMany({
      where: { pageId: page.id, ...(parsedCursor ? { id: { lt: parsedCursor } } : {}) },
      orderBy: [{ id: 'desc' }],
      take: limit + 1
    });
    let canReview = false;
    let viewerProfileId: string | null = null;
    if (session) {
      const profile = await this.profiles.ensureWikiProfile(session.userId);
      viewerProfileId = profile.id.toString();
      canReview = await this.permissions.canManagePage({ actor: this.permissions.actorFromSession(session, profile), page });
    }
    const hasMore = requests.length > limit;
    const pageRows = requests.slice(0, limit);
    return { items: await this.present(pageRows), canReview, viewerProfileId, nextCursor: hasMore ? pageRows.at(-1)?.id.toString() ?? null : null, currentRevisionId: page.currentRevisionId?.toString() ?? null };
  }

  async get(requestId: string, accountId?: string | null): Promise<WikiEditRequestSummary> {
    const request = await this.request(requestId);
    const page = await this.page(request.pageId.toString());
    await this.permissions.assertCanReadPage({ accountId: accountId ?? null, page });
    await this.permissions.assertCanUsePageAction({ accountId: accountId ?? null, action: 'raw', page });
    const [presented] = await this.present([request]);
    if (!presented) throw new NotFoundException('Wiki edit request not found.');
    return presented;
  }

  async diff(requestId: string, accountId?: string | null): Promise<WikiEditRequestDiffResponse> {
    const request = await this.request(requestId);
    const page = await this.page(request.pageId.toString());
    await this.permissions.assertCanReadPage({ accountId: accountId ?? null, page });
    await this.permissions.assertCanUsePageAction({ accountId: accountId ?? null, action: 'raw', page });
    const base = await this.prisma.wikiPageRevision.findUnique({ where: { id: request.baseRevisionId } });
    if (!base || base.pageId !== page.id || base.visibility !== 'public') throw new NotFoundException('Base revision not found.');
    return { requestId: request.id.toString(), baseRevisionId: base.id.toString(), hunks: this.edits.diffText(base.contentRaw, request.proposedContent) };
  }

  async create(
    session: SessionPayload,
    pageId: string,
    input: { readonly baseRevisionId?: string; readonly contentRaw?: string; readonly editSummary?: string; readonly isMinor?: boolean }
  ): Promise<WikiEditRequestSummary> {
    const parsedPageId = this.id(pageId, 'pageId');
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    const actor = this.permissions.actorFromSession(session, profile);
    if (actor.status !== 'active') throw new ForbiddenException('Blocked wiki users cannot create edit requests.');
    const baseRevisionId = this.id(this.required(input.baseRevisionId, 'baseRevisionId'), 'baseRevisionId');
    const content = this.required(input.contentRaw, 'contentRaw');
    if (hasWikiConflictMarkers(content)) throw new BadRequestException('Resolve every wiki edit conflict marker before submitting.');
    this.assertContentBounds(content);
    const summary = this.required(input.editSummary, 'editSummary');
    if (summary.length > 255) throw new BadRequestException('editSummary is too long.');
    const now = new Date();
    const request = await this.prisma.$transaction(async (tx) => {
      await this.lockPage(tx, parsedPageId);
      const page = await tx.wikiPage.findUnique({ where: { id: parsedPageId } });
      if (!page || page.status === 'deleted') throw new NotFoundException('Wiki page not found.');
      await this.permissions.assertCanReadPage({ accountId: session.userId, page, store: tx });
      if (page.currentRevisionId !== baseRevisionId) {
        throw new ConflictException('The document changed before this edit request was submitted.');
      }
      await this.assertNoOtherOpenRequest(tx, page.id, profile.id);
      return tx.wikiEditRequest.create({
        data: {
          pageId: page.id,
          baseRevisionId,
          proposedContent: content,
          editSummary: summary,
          isMinor: Boolean(input.isMinor),
          status: 'pending',
          createdBy: profile.id,
          createdAt: now,
          updatedAt: now
        }
      });
    });
    await this.audit('wiki.edit_request.create', session, profile.id, parsedPageId, request.id);
    return (await this.present([request]))[0]!;
  }

  async accept(session: SessionPayload, requestId: string, reviewNote?: string): Promise<WikiEditRequestSummary> {
    const request = await this.request(requestId);
    const page = await this.page(request.pageId.toString());
    const reviewer = await this.profiles.ensureWikiProfile(session.userId);
    const actor = this.permissions.actorFromSession(session, reviewer);
    if (!(await this.permissions.canManagePage({ actor, page }))) throw new ForbiddenException('Edit request review is not allowed.');
    if (page.currentRevisionId !== request.baseRevisionId) {
      await this.markStale(request);
      throw new ConflictException({
        code: 'wiki_edit_base_stale',
        message: 'The edit request must be rebased before review.'
      });
    }
    try {
      const { request: updated } = await this.edits.acceptEditRequest(session, { requestId: request.id, reviewNote: this.note(reviewNote) });
      await this.audit('wiki.edit_request.accept', session, reviewer.id, page.id, request.id);
      return (await this.present([updated]))[0]!;
    } catch (error) {
      if (this.conflictCode(error) === 'wiki_edit_base_stale') await this.markStale(request);
      throw error;
    }
  }

  async reject(session: SessionPayload, requestId: string, reviewNote?: string): Promise<WikiEditRequestSummary> {
    const request = await this.request(requestId);
    const page = await this.page(request.pageId.toString());
    const reviewer = await this.profiles.ensureWikiProfile(session.userId);
    const actor = this.permissions.actorFromSession(session, reviewer);
    if (!(await this.permissions.canManagePage({ actor, page }))) throw new ForbiddenException('Edit request review is not allowed.');
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.wikiEditRequest.updateMany({
        where: { id: request.id, status: 'pending' },
        data: {
          status: 'rejected', reviewedBy: reviewer.id, reviewNote: this.note(reviewNote),
          reviewedAt: new Date(), updatedAt: new Date()
        }
      });
      if (result.count !== 1) throw new ConflictException('This edit request is no longer pending.');
      await this.notifications?.notifyEditRequestReviewed(tx, {
        profileId: request.createdBy,
        pageId: page.id,
        requestId: request.id,
        reviewerProfileId: reviewer.id,
        status: 'rejected',
        title: page.displayTitle
      });
      return tx.wikiEditRequest.findUniqueOrThrow({ where: { id: request.id } });
    });
    await this.audit('wiki.edit_request.reject', session, reviewer.id, page.id, request.id);
    return (await this.present([updated]))[0]!;
  }

  async update(session: SessionPayload, requestId: string, input: { readonly baseRevisionId?: string; readonly contentRaw?: string; readonly editSummary?: string; readonly isMinor?: boolean }): Promise<WikiEditRequestSummary> {
    const parsedRequestId = this.id(requestId, 'requestId');
    const initialRequest = await this.request(requestId);
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    if (profile.status !== 'active') throw new ForbiddenException('Blocked wiki users cannot edit requests.');
    const baseRevisionId = this.id(this.required(input.baseRevisionId, 'baseRevisionId'), 'baseRevisionId');
    const content = this.required(input.contentRaw, 'contentRaw');
    if (hasWikiConflictMarkers(content)) throw new BadRequestException('Resolve every wiki edit conflict marker before saving.');
    this.assertContentBounds(content);
    const summary = this.required(input.editSummary, 'editSummary');
    if (summary.length > 255) throw new BadRequestException('editSummary is too long.');
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockPage(tx, initialRequest.pageId);
      const [page, request] = await Promise.all([
        tx.wikiPage.findUnique({ where: { id: initialRequest.pageId } }),
        tx.wikiEditRequest.findUnique({ where: { id: parsedRequestId } })
      ]);
      if (!page || page.status === 'deleted') throw new NotFoundException('Wiki page not found.');
      if (!request || request.pageId !== page.id) throw new NotFoundException('Wiki edit request not found.');
      await this.permissions.assertCanReadPage({ accountId: session.userId, page, store: tx });
      if (profile.id !== request.createdBy) throw new ForbiddenException('Only the author can edit this request.');
      if (!['pending', 'stale', 'closed'].includes(request.status)) throw new ConflictException('This edit request can no longer be edited.');
      if (baseRevisionId !== request.baseRevisionId) throw new ConflictException('Rebase the edit request before changing its base revision.');
      if (page.currentRevisionId !== request.baseRevisionId) throw new ConflictException('The document changed. Rebase this request before editing it.');
      const nextStatus = request.status === 'stale' ? 'pending' : request.status;
      if (nextStatus === 'pending') await this.assertNoOtherOpenRequest(tx, page.id, profile.id, request.id);
      const updated = await tx.wikiEditRequest.updateMany({
        where: { id: request.id, createdBy: profile.id, status: request.status, updatedAt: request.updatedAt },
        data: {
          baseRevisionId, proposedContent: content, editSummary: summary, isMinor: Boolean(input.isMinor),
          status: nextStatus,
          updatedAt: new Date()
        }
      });
      if (updated.count !== 1) throw new ConflictException('This edit request changed concurrently.');
      return tx.wikiEditRequest.findUniqueOrThrow({ where: { id: request.id } });
    });
    await this.audit('wiki.edit_request.update', session, profile.id, result.pageId, result.id);
    return (await this.present([result]))[0]!;
  }

  async rebase(
    session: SessionPayload,
    requestId: string,
    input: {
      readonly contentRaw?: string;
      readonly currentRevisionId?: string;
      readonly editSummary?: string;
      readonly isMinor?: boolean;
    } = {}
  ): Promise<WikiEditRequestSummary> {
    const parsedRequestId = this.id(requestId, 'requestId');
    const initialRequest = await this.request(requestId);
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    if (profile.status !== 'active') throw new ForbiddenException('Blocked wiki users cannot rebase requests.');
    const resolvedContent = input.contentRaw?.trim() ? input.contentRaw : null;
    if (resolvedContent !== null) {
      if (hasWikiConflictMarkers(resolvedContent)) throw new BadRequestException('Resolve every wiki edit conflict marker before rebasing.');
      this.assertContentBounds(resolvedContent);
    }
    const resolvedSummary = input.editSummary === undefined
      ? null
      : this.required(input.editSummary, 'editSummary');
    if (resolvedSummary && resolvedSummary.length > 255) throw new BadRequestException('editSummary is too long.');
    const expectedCurrentId = resolvedContent === null
      ? null
      : this.id(this.required(input.currentRevisionId, 'currentRevisionId'), 'currentRevisionId');
    const transactionResult = await this.prisma.$transaction(async (tx) => {
      await this.lockPage(tx, initialRequest.pageId);
      const [page, request] = await Promise.all([
        tx.wikiPage.findUnique({ where: { id: initialRequest.pageId } }),
        tx.wikiEditRequest.findUnique({ where: { id: parsedRequestId } })
      ]);
      if (!page || page.status === 'deleted') throw new NotFoundException('Wiki page not found.');
      if (!request || request.pageId !== page.id) throw new NotFoundException('Wiki edit request not found.');
      await this.permissions.assertCanReadPage({ accountId: session.userId, page, store: tx });
      await this.permissions.assertCanUsePageAction({ accountId: session.userId, action: 'raw', page, store: tx });
      if (profile.id !== request.createdBy) throw new ForbiddenException('Only the author can rebase this request.');
      if (!['pending', 'stale', 'closed'].includes(request.status)) throw new ConflictException('This edit request can no longer be rebased.');
      if (!page.currentRevisionId || page.currentRevisionId === request.baseRevisionId) {
        return { request, auditAction: null as string | null };
      }
      const [base, current] = await Promise.all([
        tx.wikiPageRevision.findUnique({ where: { id: request.baseRevisionId } }),
        tx.wikiPageRevision.findUnique({ where: { id: page.currentRevisionId } })
      ]);
      if (!base || base.pageId !== page.id || base.visibility !== 'public' || !current || current.pageId !== page.id || current.visibility !== 'public') {
        throw new ConflictException('The edit request base revision is no longer available.');
      }
      if (expectedCurrentId !== null && expectedCurrentId !== current.id) {
        throw new ConflictException('The document changed again. Rebase the request against the newest revision.');
      }
      let nextContent = resolvedContent;
      let auditAction = 'wiki.edit_request.rebase.resolve';
      if (nextContent === null) {
        try {
          const merged = mergeWikiSource(request.proposedContent, base.contentRaw, current.contentRaw);
          if (merged.hasConflicts) {
            const details: WikiEditConflictDetails = {
              type: 'wiki_edit_conflict', scope: 'page', baseRevisionId: base.id.toString(),
              currentRevisionId: current.id.toString(), currentRevisionNo: current.revisionNo,
              mergedContentRaw: merged.contentRaw, conflictCount: merged.conflictCount
            };
            throw new ConflictException({
              code: 'wiki_edit_conflict',
              message: 'The edit request has overlapping changes that require manual resolution.',
              details
            });
          }
          nextContent = merged.contentRaw;
          auditAction = 'wiki.edit_request.rebase';
        } catch (error) {
          if (error instanceof WikiMergeLimitError) throw new ConflictException('The edit request is too large to rebase automatically.');
          throw error;
        }
      }
      const nextStatus = request.status === 'stale' ? 'pending' : request.status;
      if (nextStatus === 'pending') await this.assertNoOtherOpenRequest(tx, page.id, profile.id, request.id);
      const updated = await tx.wikiEditRequest.updateMany({
        where: {
          id: request.id, createdBy: profile.id, status: request.status,
          baseRevisionId: request.baseRevisionId, updatedAt: request.updatedAt
        },
        data: {
          baseRevisionId: current.id,
          proposedContent: nextContent,
          editSummary: resolvedSummary ?? request.editSummary,
          isMinor: input.isMinor ?? request.isMinor,
          status: nextStatus,
          updatedAt: new Date()
        }
      });
      if (updated.count !== 1) throw new ConflictException('This edit request changed concurrently.');
      return {
        request: await tx.wikiEditRequest.findUniqueOrThrow({ where: { id: request.id } }),
        auditAction
      };
    });
    if (transactionResult.auditAction) {
      await this.audit(transactionResult.auditAction, session, profile.id, transactionResult.request.pageId, transactionResult.request.id);
    }
    return (await this.present([transactionResult.request]))[0]!;
  }

  async close(session: SessionPayload, requestId: string): Promise<WikiEditRequestSummary> {
    const request = await this.request(requestId);
    const page = await this.page(request.pageId.toString());
    await this.permissions.assertCanReadPage({ accountId: session.userId, page });
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    if (profile.id !== request.createdBy) throw new ForbiddenException('Only the author can close this request.');
    if (!['pending', 'stale'].includes(request.status)) throw new ConflictException('This edit request cannot be closed.');
    const updated = await this.prisma.wikiEditRequest.updateMany({
      where: { id: request.id, createdBy: profile.id, status: request.status },
      data: { status: 'closed', updatedAt: new Date() }
    });
    if (updated.count !== 1) throw new ConflictException('This edit request changed concurrently.');
    const result = await this.request(requestId);
    await this.audit('wiki.edit_request.close', session, profile.id, page.id, request.id);
    return (await this.present([result]))[0]!;
  }

  async reopen(session: SessionPayload, requestId: string): Promise<WikiEditRequestSummary> {
    const request = await this.request(requestId);
    const page = await this.page(request.pageId.toString());
    await this.permissions.assertCanReadPage({ accountId: session.userId, page });
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    if (profile.id !== request.createdBy) throw new ForbiddenException('Only the author can reopen this request.');
    if (profile.status !== 'active') throw new ForbiddenException('Blocked wiki users cannot reopen requests.');
    if (request.status !== 'closed') throw new ConflictException('This edit request is not closed.');
    if (page.currentRevisionId !== request.baseRevisionId) throw new ConflictException('The document changed. Update the request before reopening it.');
    const duplicate = await this.prisma.wikiEditRequest.findFirst({
      where: { pageId: page.id, createdBy: profile.id, status: { in: ['pending', 'reviewing'] }, id: { not: request.id } },
      select: { id: true }
    });
    if (duplicate) throw new ConflictException('You already have an open edit request for this document.');
    const updated = await this.prisma.wikiEditRequest.updateMany({
      where: { id: request.id, createdBy: profile.id, status: 'closed' },
      data: { status: 'pending', updatedAt: new Date() }
    });
    if (updated.count !== 1) throw new ConflictException('This edit request changed concurrently.');
    const result = await this.request(requestId);
    await this.audit('wiki.edit_request.reopen', session, profile.id, page.id, request.id);
    return (await this.present([result]))[0]!;
  }

  private async page(pageId: string) {
    const page = await this.prisma.wikiPage.findUnique({ where: { id: this.id(pageId, 'pageId') } });
    if (!page || page.status === 'deleted') throw new NotFoundException('Wiki page not found.');
    return page;
  }

  private async request(requestId: string) {
    const request = await this.prisma.wikiEditRequest.findUnique({ where: { id: this.id(requestId, 'requestId') } });
    if (!request) throw new NotFoundException('Wiki edit request not found.');
    return request;
  }

  private async present(requests: readonly WikiEditRequest[]): Promise<WikiEditRequestSummary[]> {
    const ids = [...new Set(requests.flatMap((request) => [request.createdBy, request.reviewedBy].filter((id): id is bigint => typeof id === 'bigint')))];
    const profiles = ids.length > 0 ? await this.prisma.wikiProfile.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }) : [];
    const names = new Map(profiles.map((profile) => [profile.id, profile.displayName]));
    return requests.map((request) => ({
      id: request.id.toString(), pageId: request.pageId.toString(), baseRevisionId: request.baseRevisionId.toString(),
      proposedContent: request.proposedContent, editSummary: request.editSummary, isMinor: request.isMinor, status: request.status,
      createdBy: request.createdBy.toString(), createdByName: names.get(request.createdBy) ?? '알 수 없는 사용자',
      reviewedBy: request.reviewedBy?.toString() ?? null, reviewedByName: request.reviewedBy ? names.get(request.reviewedBy) ?? '알 수 없는 사용자' : null,
      reviewNote: request.reviewNote, acceptedRevisionId: request.acceptedRevisionId?.toString() ?? null,
      createdAt: request.createdAt.toISOString(), updatedAt: request.updatedAt.toISOString(), reviewedAt: request.reviewedAt?.toISOString() ?? null
    }));
  }

  private required(value: string | undefined, label: string) { const result = value?.trim(); if (!result) throw new BadRequestException(`${label} is required.`); return result; }
  private id(value: string, label: string) { if (!/^\d+$/.test(value)) throw new BadRequestException(`${label} must be an unsigned integer.`); return BigInt(value); }
  private note(value?: string) { const note = value?.trim() || null; if (note && note.length > 1000) throw new BadRequestException('reviewNote is too long.'); return note; }
  private assertContentBounds(contentRaw: string): void {
    try {
      assertWikiSourceBounds(contentRaw);
    } catch (error) {
      if (error instanceof WikiMergeLimitError) throw new BadRequestException('contentRaw is too long.');
      throw error;
    }
  }
  private async lockPage(tx: Prisma.TransactionClient, pageId: bigint): Promise<void> {
    await tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id
      FROM pages
      WHERE id = ${pageId}
      FOR UPDATE
    `;
  }
  private async assertNoOtherOpenRequest(
    tx: Prisma.TransactionClient,
    pageId: bigint,
    createdBy: bigint,
    excludeId?: bigint
  ): Promise<void> {
    const duplicate = await tx.wikiEditRequest.findFirst({
      where: {
        pageId,
        createdBy,
        status: { in: ['pending', 'reviewing'] },
        ...(excludeId ? { id: { not: excludeId } } : {})
      },
      select: { id: true }
    });
    if (duplicate) throw new ConflictException('You already have an open edit request for this document.');
  }
  private async markStale(request: WikiEditRequest) {
    await this.prisma.wikiEditRequest.updateMany({
      where: { id: request.id, status: 'pending', baseRevisionId: request.baseRevisionId },
      data: { status: 'stale', reviewedBy: null, updatedAt: new Date() }
    });
  }
  private conflictCode(error: unknown): string | null {
    if (!(error instanceof ConflictException)) return null;
    const response = error.getResponse();
    return response && typeof response === 'object' && 'code' in response && typeof response.code === 'string'
      ? response.code
      : null;
  }
  private async audit(action: string, session: SessionPayload, profileId: bigint, pageId: bigint, requestId: bigint) {
    await this.events?.audit(action, { category: 'wiki', actorAccountId: session.userId, actorProfileId: profileId, subjectType: 'wiki_edit_request', subjectId: requestId.toString(), metadata: { pageId: pageId.toString() } });
  }
}

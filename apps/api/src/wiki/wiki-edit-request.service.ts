import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { WikiEditRequest } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import type { SessionPayload } from '../session/session.service';
import { WikiEditService } from './wiki-edit.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiNotificationService } from './wiki-notification.service';

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

@Injectable()
export class WikiEditRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: WikiProfileService,
    private readonly permissions: WikiPermissionService,
    private readonly edits: WikiEditService,
    @Optional() private readonly events?: BusinessEventService,
    @Optional() private readonly notifications?: WikiNotificationService
  ) {}

  async list(pageId: string, session: SessionPayload | null, cursor?: string, requestedLimit: string | number = 30): Promise<WikiEditRequestListResponse> {
    const page = await this.page(pageId);
    await this.permissions.assertCanReadPage({ accountId: session?.userId ?? null, page });
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

  async diff(requestId: string, accountId?: string | null): Promise<WikiEditRequestDiffResponse> {
    const request = await this.request(requestId);
    const page = await this.page(request.pageId.toString());
    await this.permissions.assertCanReadPage({ accountId: accountId ?? null, page });
    const base = await this.prisma.wikiPageRevision.findUnique({ where: { id: request.baseRevisionId } });
    if (!base || base.pageId !== page.id || base.visibility !== 'public') throw new NotFoundException('Base revision not found.');
    return { requestId: request.id.toString(), baseRevisionId: base.id.toString(), hunks: this.edits.diffText(base.contentRaw, request.proposedContent) };
  }

  async create(
    session: SessionPayload,
    pageId: string,
    input: { readonly baseRevisionId?: string; readonly contentRaw?: string; readonly editSummary?: string; readonly isMinor?: boolean }
  ): Promise<WikiEditRequestSummary> {
    const page = await this.page(pageId);
    await this.permissions.assertCanReadPage({ accountId: session.userId, page });
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    const actor = this.permissions.actorFromSession(session, profile);
    if (actor.status !== 'active') throw new ForbiddenException('Blocked wiki users cannot create edit requests.');
    const baseRevisionId = this.id(this.required(input.baseRevisionId, 'baseRevisionId'), 'baseRevisionId');
    if (page.currentRevisionId !== baseRevisionId) throw new ConflictException('The document changed before this edit request was submitted.');
    const content = this.required(input.contentRaw, 'contentRaw');
    if (content.length > 1_000_000) throw new BadRequestException('contentRaw is too long.');
    const summary = this.required(input.editSummary, 'editSummary');
    if (summary.length > 255) throw new BadRequestException('editSummary is too long.');
    const duplicate = await this.prisma.wikiEditRequest.findFirst({
      where: { pageId: page.id, createdBy: profile.id, status: { in: ['pending', 'reviewing'] } },
      select: { id: true }
    });
    if (duplicate) throw new ConflictException('You already have an open edit request for this document.');
    const now = new Date();
    const request = await this.prisma.wikiEditRequest.create({
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
    await this.audit('wiki.edit_request.create', session, profile.id, page.id, request.id);
    return (await this.present([request]))[0]!;
  }

  async accept(session: SessionPayload, requestId: string, reviewNote?: string): Promise<WikiEditRequestSummary> {
    const request = await this.request(requestId);
    const page = await this.page(request.pageId.toString());
    const reviewer = await this.profiles.ensureWikiProfile(session.userId);
    const actor = this.permissions.actorFromSession(session, reviewer);
    if (!(await this.permissions.canManagePage({ actor, page }))) throw new ForbiddenException('Edit request review is not allowed.');
    try {
      const { request: updated } = await this.edits.acceptEditRequest(session, { requestId: request.id, reviewNote: this.note(reviewNote) });
      await this.audit('wiki.edit_request.accept', session, reviewer.id, page.id, request.id);
      return (await this.present([updated]))[0]!;
    } catch (error) {
      if (error instanceof ConflictException) {
        await this.prisma.wikiEditRequest.updateMany({
          where: { id: request.id, status: 'pending', baseRevisionId: request.baseRevisionId },
          data: { status: 'stale', reviewedBy: null, updatedAt: new Date() }
        });
      }
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
    const request = await this.request(requestId);
    const page = await this.page(request.pageId.toString());
    await this.permissions.assertCanReadPage({ accountId: session.userId, page });
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    if (profile.id !== request.createdBy) throw new ForbiddenException('Only the author can edit this request.');
    if (profile.status !== 'active') throw new ForbiddenException('Blocked wiki users cannot edit requests.');
    if (!['pending', 'stale', 'closed'].includes(request.status)) throw new ConflictException('This edit request can no longer be edited.');
    const baseRevisionId = this.id(this.required(input.baseRevisionId, 'baseRevisionId'), 'baseRevisionId');
    if (page.currentRevisionId !== baseRevisionId) throw new ConflictException('The document changed. Refresh the editor before updating this request.');
    const content = this.required(input.contentRaw, 'contentRaw');
    if (content.length > 1_000_000) throw new BadRequestException('contentRaw is too long.');
    const summary = this.required(input.editSummary, 'editSummary');
    if (summary.length > 255) throw new BadRequestException('editSummary is too long.');
    const updated = await this.prisma.wikiEditRequest.updateMany({
      where: { id: request.id, createdBy: profile.id, status: request.status },
      data: {
        baseRevisionId, proposedContent: content, editSummary: summary, isMinor: Boolean(input.isMinor),
        status: request.status === 'stale' ? 'pending' : request.status,
        updatedAt: new Date()
      }
    });
    if (updated.count !== 1) throw new ConflictException('This edit request changed concurrently.');
    const result = await this.request(requestId);
    await this.audit('wiki.edit_request.update', session, profile.id, page.id, request.id);
    return (await this.present([result]))[0]!;
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
  private async audit(action: string, session: SessionPayload, profileId: bigint, pageId: bigint, requestId: bigint) {
    await this.events?.audit(action, { category: 'wiki', actorAccountId: session.userId, actorProfileId: profileId, subjectType: 'wiki_edit_request', subjectId: requestId.toString(), metadata: { pageId: pageId.toString() } });
  }
}

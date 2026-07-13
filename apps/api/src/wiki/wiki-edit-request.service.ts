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

  async list(pageId: string, session: SessionPayload | null): Promise<WikiEditRequestListResponse> {
    const page = await this.page(pageId);
    await this.permissions.assertCanReadPage({ accountId: session?.userId ?? null, page });
    const requests = await this.prisma.wikiEditRequest.findMany({
      where: { pageId: page.id },
      orderBy: [{ createdAt: 'desc' }],
      take: 100
    });
    let canReview = false;
    if (session) {
      const profile = await this.profiles.ensureWikiProfile(session.userId);
      canReview = await this.permissions.canManagePage({ actor: this.permissions.actorFromSession(session, profile), page });
    }
    return { items: await this.present(requests), canReview };
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
    const claimed = await this.prisma.wikiEditRequest.updateMany({
      where: { id: request.id, status: 'pending' },
      data: { status: 'reviewing', reviewedBy: reviewer.id, updatedAt: new Date() }
    });
    if (claimed.count !== 1) throw new ConflictException('This edit request is no longer pending.');
    let appliedRevisionId: bigint | null = null;
    try {
      const revision = await this.edits.updatePage(session, page.id.toString(), {
        contentRaw: request.proposedContent,
        editSummary: request.editSummary,
        isMinor: request.isMinor,
        baseRevisionId: request.baseRevisionId.toString()
      });
      appliedRevisionId = BigInt(revision.revisionId);
      const updated = await this.prisma.$transaction(async (tx) => {
        const completed = await tx.wikiEditRequest.updateMany({
          where: { id: request.id, status: 'reviewing', reviewedBy: reviewer.id },
          data: {
            status: 'accepted',
            acceptedRevisionId: appliedRevisionId,
            reviewNote: this.note(reviewNote),
            reviewedAt: new Date(),
            updatedAt: new Date()
          }
        });
        if (completed.count !== 1) throw new ConflictException('This edit request is no longer being reviewed.');
        await this.notifications?.notifyEditRequestReviewed(tx, {
          profileId: request.createdBy,
          pageId: page.id,
          requestId: request.id,
          reviewerProfileId: reviewer.id,
          status: 'accepted',
          title: page.displayTitle
        });
        return tx.wikiEditRequest.findUniqueOrThrow({ where: { id: request.id } });
      });
      await this.audit('wiki.edit_request.accept', session, reviewer.id, page.id, request.id);
      return (await this.present([updated]))[0]!;
    } catch (error) {
      if (appliedRevisionId === null) {
        await this.prisma.wikiEditRequest.updateMany({
          where: { id: request.id, status: 'reviewing' },
          data: { status: error instanceof ConflictException ? 'stale' : 'pending', reviewedBy: null, updatedAt: new Date() }
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

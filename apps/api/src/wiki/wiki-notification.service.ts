import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';

export interface WikiNotificationItem {
  readonly id: string;
  readonly type: string;
  readonly pageId: string | null;
  readonly actorProfileId: string | null;
  readonly actorName: string | null;
  readonly title: string;
  readonly message: string | null;
  readonly href: string;
  readonly read: boolean;
  readonly createdAt: string;
}

export interface WikiNotificationListResponse {
  readonly items: WikiNotificationItem[];
  readonly unreadCount: number;
  readonly nextCursor: string | null;
}

@Injectable()
export class WikiNotificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: WikiProfileService,
    private readonly permissions: WikiPermissionService
  ) {}

  async list(session: SessionPayload, cursor?: string, requestedLimit = 30): Promise<WikiNotificationListResponse> {
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    const limit = Math.min(Math.max(requestedLimit, 1), 50);
    const cursorId = cursor ? this.id(cursor, 'cursor') : null;
    const rows = await this.prisma.wikiNotification.findMany({
      where: { profileId: profile.id, ...(cursorId ? { id: { lt: cursorId } } : {}) },
      orderBy: [{ id: 'desc' }],
      take: limit + 1
    });
    const pageIds = [...new Set(rows.flatMap((row) => row.pageId ? [row.pageId] : []))];
    const pages = pageIds.length > 0
      ? await this.prisma.wikiPage.findMany({ where: { id: { in: pageIds } } })
      : [];
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const visible = [];
    const hiddenIds: bigint[] = [];
    for (const row of rows) {
      if (row.pageId) {
        const page = pageById.get(row.pageId);
        if (!page || page.status === 'deleted') {
          hiddenIds.push(row.id);
          continue;
        }
        try {
          await this.permissions.assertCanReadPage({ accountId: session.userId, page });
        } catch {
          hiddenIds.push(row.id);
          continue;
        }
      }
      visible.push(row);
    }
    if (hiddenIds.length > 0) {
      await this.prisma.wikiNotification.deleteMany({ where: { profileId: profile.id, id: { in: hiddenIds } } });
    }
    const hasMore = rows.length > limit;
    const pageRows = visible.slice(0, limit);
    const actorIds = [...new Set(pageRows.flatMap((row) => row.actorProfileId ? [row.actorProfileId] : []))];
    const actors = actorIds.length > 0
      ? await this.prisma.wikiProfile.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } })
      : [];
    const actorNames = new Map(actors.map((actor) => [actor.id, actor.displayName]));
    const unreadCount = await this.prisma.wikiNotification.count({ where: { profileId: profile.id, readAt: null } });
    return {
      items: pageRows.map((row) => ({
        id: row.id.toString(),
        type: row.type,
        pageId: row.pageId?.toString() ?? null,
        actorProfileId: row.actorProfileId?.toString() ?? null,
        actorName: row.actorProfileId ? actorNames.get(row.actorProfileId) ?? '알 수 없는 사용자' : null,
        title: row.title,
        message: row.message,
        href: row.href,
        read: row.readAt !== null,
        createdAt: row.createdAt.toISOString()
      })),
      unreadCount,
      nextCursor: hasMore ? rows[limit - 1]?.id.toString() ?? null : null
    };
  }

  async markRead(session: SessionPayload, notificationId: string): Promise<{ readonly read: true }> {
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    const result = await this.prisma.wikiNotification.updateMany({
      where: { id: this.id(notificationId, 'notificationId'), profileId: profile.id },
      data: { readAt: new Date() }
    });
    if (result.count !== 1) throw new NotFoundException('Wiki notification not found.');
    return { read: true };
  }

  async markAllRead(session: SessionPayload, throughId: string): Promise<{ readonly count: number }> {
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    const result = await this.prisma.wikiNotification.updateMany({
      where: { profileId: profile.id, readAt: null, id: { lte: this.id(throughId, 'throughId') } },
      data: { readAt: new Date() }
    });
    return { count: result.count };
  }

  async notifyWatchedRevision(
    tx: Prisma.TransactionClient,
    input: { readonly pageId: bigint; readonly revisionId: bigint; readonly actorProfileId: bigint; readonly title: string }
  ): Promise<void> {
    const watches = await tx.wikiPageWatch.findMany({
      where: { pageId: input.pageId, profileId: { not: input.actorProfileId } },
      select: { profileId: true }
    });
    if (watches.length === 0) return;
    const now = new Date();
    await tx.wikiNotification.createMany({
      data: watches.map((watch) => ({
        profileId: watch.profileId,
        type: 'page_revision',
        pageId: input.pageId,
        actorProfileId: input.actorProfileId,
        sourceType: 'revision',
        sourceId: input.revisionId.toString(),
        title: input.title,
        message: '관심 문서에 새 리비전이 등록되었습니다.',
        href: `/wiki/revision/${input.revisionId.toString()}`,
        dedupeKey: `revision:${input.revisionId.toString()}:profile:${watch.profileId.toString()}`,
        readAt: null,
        createdAt: now
      })),
      skipDuplicates: true
    });
  }

  async notifyDiscussionReply(
    tx: Prisma.TransactionClient,
    input: { readonly pageId: bigint; readonly threadId: bigint; readonly commentId: bigint; readonly actorProfileId: bigint; readonly title: string }
  ): Promise<void> {
    const [thread, comments] = await Promise.all([
      tx.wikiDiscussionThread.findUnique({ where: { id: input.threadId }, select: { createdBy: true } }),
      tx.wikiDiscussionComment.findMany({ where: { threadId: input.threadId }, select: { createdBy: true } })
    ]);
    const recipients = [...new Set([thread?.createdBy, ...comments.map((comment) => comment.createdBy)])]
      .filter((profileId): profileId is bigint => typeof profileId === 'bigint' && profileId !== input.actorProfileId);
    if (recipients.length === 0) return;
    const now = new Date();
    await tx.wikiNotification.createMany({
      data: recipients.map((profileId) => ({
        profileId,
        type: 'discussion_reply',
        pageId: input.pageId,
        actorProfileId: input.actorProfileId,
        sourceType: 'discussion_comment',
        sourceId: input.commentId.toString(),
        title: input.title,
        message: '참여한 토론에 새 댓글이 등록되었습니다.',
        href: `/wiki/discuss/${input.pageId.toString()}?thread=${input.threadId.toString()}&comment=${input.commentId.toString()}`,
        dedupeKey: `discussion-comment:${input.commentId.toString()}:profile:${profileId.toString()}`,
        readAt: null,
        createdAt: now
      })),
      skipDuplicates: true
    });
  }

  async notifyEditRequestReviewed(tx: Prisma.TransactionClient, input: {
    readonly profileId: bigint;
    readonly pageId: bigint;
    readonly requestId: bigint;
    readonly reviewerProfileId: bigint;
    readonly status: 'accepted' | 'rejected';
    readonly title: string;
  }): Promise<void> {
    if (input.profileId === input.reviewerProfileId) return;
    await tx.wikiNotification.createMany({
      data: [{
        profileId: input.profileId,
        type: `edit_request_${input.status}`,
        pageId: input.pageId,
        actorProfileId: input.reviewerProfileId,
        sourceType: 'edit_request',
        sourceId: input.requestId.toString(),
        title: input.title,
        message: input.status === 'accepted' ? '편집 요청이 승인되었습니다.' : '편집 요청이 반려되었습니다.',
        href: `/wiki/edit-requests/${input.pageId.toString()}`,
        dedupeKey: `edit-request:${input.requestId.toString()}:${input.status}:profile:${input.profileId.toString()}`,
        readAt: null,
        createdAt: new Date()
      }],
      skipDuplicates: true
    });
  }

  private id(value: string, label: string): bigint {
    if (!/^\d+$/.test(value)) throw new BadRequestException(`${label} must be an unsigned integer.`);
    return BigInt(value);
  }
}

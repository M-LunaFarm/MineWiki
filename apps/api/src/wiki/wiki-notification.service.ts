import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { buildServerWikiToolPath } from './wiki-read.service';

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

interface PendingNotificationDelivery {
  readonly profileId: bigint;
  readonly type: string;
  readonly pageId: bigint | null;
  readonly actorProfileId: bigint | null;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly title: string;
  readonly message: string | null;
  readonly href: string;
  readonly dedupeKey: string;
  readonly readAt: null;
  readonly createdAt: Date;
}

const MAX_DISCUSSION_NOTIFICATION_RECIPIENTS = 500;
const DISCUSSION_ACL_RECIPIENT_CHUNK = 20;

@Injectable()
export class WikiNotificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: WikiProfileService,
    private readonly permissions: WikiPermissionService
  ) {}

  async list(session: SessionPayload, cursor?: string, requestedLimit = 30): Promise<WikiNotificationListResponse> {
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    await this.purgeUnreadDiscussionNotifications(session, profile.id);
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
    const namespaces = pages.length > 0
      ? await this.prisma.wikiNamespace.findMany({
          where: { id: { in: [...new Set(pages.map((page) => page.namespaceId))] } },
          select: { id: true, code: true }
        })
      : [];
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    const serverSpaceIds = [...new Set(pages
      .filter((page) => namespaceById.get(page.namespaceId) === 'server')
      .map((page) => page.spaceId))];
    const serverWikis = serverSpaceIds.length > 0
      ? await this.prisma.serverWiki.findMany({
          where: { spaceId: { in: serverSpaceIds }, status: { not: 'disabled' } },
          select: { spaceId: true, slug: true }
        })
      : [];
    const serverSlugBySpace = new Map(serverWikis.map((wiki) => [wiki.spaceId, wiki.slug]));
    const permissionActor = typeof (this.permissions as Partial<WikiPermissionService>).actorFromSession === 'function'
      ? this.permissions.actorFromSession(session, profile)
      : null;
    const readablePages = typeof (this.permissions as Partial<WikiPermissionService>).filterReadablePages === 'function'
      ? await this.permissions.filterReadablePages({ accountId: session.userId, actor: permissionActor, pages })
      : await this.legacyReadablePages(session.userId, pages);
    const readablePageIds = new Set(readablePages.map((page) => page.id));
    const discussionCommentIds = rows.flatMap((row) =>
      row.sourceType === 'discussion_comment' && /^\d+$/.test(row.sourceId) ? [BigInt(row.sourceId)] : []
    );
    const discussionSurface = this.prisma as unknown as { wikiDiscussionComment?: unknown; wikiDiscussionThread?: unknown };
    const canFilterDiscussions = Boolean(
      discussionSurface.wikiDiscussionComment && discussionSurface.wikiDiscussionThread &&
      typeof (this.permissions as Partial<WikiPermissionService>).filterReadableThreads === 'function'
    );
    const discussionComments = canFilterDiscussions && discussionCommentIds.length > 0
      ? await this.prisma.wikiDiscussionComment.findMany({
          where: { id: { in: [...new Set(discussionCommentIds)] } },
          select: { id: true, threadId: true, status: true }
        })
      : [];
    const commentById = new Map(discussionComments.map((comment) => [comment.id, comment]));
    const discussionThreads = canFilterDiscussions && discussionComments.length > 0
      ? await this.prisma.wikiDiscussionThread.findMany({
          where: { id: { in: [...new Set(discussionComments.map((comment) => comment.threadId))] } }
        })
      : [];
    const actor = canFilterDiscussions ? permissionActor : null;
    const visibleDiscussionRows = canFilterDiscussions
      ? await this.permissions.filterReadableThreads({
          accountId: session.userId,
          actor,
          items: discussionThreads.flatMap((thread) => {
            const page = pageById.get(thread.pageId);
            return page ? [{ thread, page }] : [];
          })
        })
      : [];
    const visibleThreadIds = new Set(visibleDiscussionRows.map((item) => item.thread.id));
    const visible = [];
    const hiddenIds: bigint[] = [];
    for (const row of rows) {
      if (row.pageId) {
        const page = pageById.get(row.pageId);
        if (!page || page.status === 'deleted' || !readablePageIds.has(page.id)) {
          hiddenIds.push(row.id);
          continue;
        }
      }
      if (canFilterDiscussions && row.sourceType === 'discussion_comment') {
        const comment = /^\d+$/.test(row.sourceId) ? commentById.get(BigInt(row.sourceId)) : undefined;
        if (!comment || comment.status !== 'normal' || !visibleThreadIds.has(comment.threadId)) {
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
      items: pageRows.map((row) => {
        const page = row.pageId ? pageById.get(row.pageId) : undefined;
        return {
          id: row.id.toString(),
          type: row.type,
          pageId: row.pageId?.toString() ?? null,
          actorProfileId: row.actorProfileId?.toString() ?? null,
          actorName: row.actorProfileId ? actorNames.get(row.actorProfileId) ?? '알 수 없는 사용자' : null,
          title: row.title,
          message: row.message,
          href: this.canonicalNotificationHref(row.href, row.type, row.sourceId, page, page ? serverSlugBySpace.get(page.spaceId) : undefined),
          read: row.readAt !== null,
          createdAt: row.createdAt.toISOString()
        };
      }),
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
    await this.persistDeliveries(tx, `revision:${input.revisionId.toString()}`, 'page_revision', watches.map((watch) => ({
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
      })));
  }

  async notifyDiscussionReply(
    tx: Prisma.TransactionClient,
    input: { readonly pageId: bigint; readonly threadId: bigint; readonly commentId: bigint; readonly actorProfileId: bigint; readonly title: string; readonly excludeProfileIds?: readonly bigint[] }
  ): Promise<void> {
    const [thread, page, comments, subscriptions] = await Promise.all([
      tx.wikiDiscussionThread.findUnique({ where: { id: input.threadId } }),
      tx.wikiPage.findUnique({ where: { id: input.pageId } }),
      tx.wikiDiscussionComment.findMany({ where: { threadId: input.threadId }, select: { createdBy: true } }),
      tx.wikiDiscussionSubscription.findMany({ where: { threadId: input.threadId }, select: { profileId: true, muted: true } })
    ]);
    const muted = new Set(subscriptions.filter((subscription) => subscription.muted).map((subscription) => subscription.profileId));
    const recipients = [...new Set([thread?.createdBy, ...comments.map((comment) => comment.createdBy), ...subscriptions.filter((subscription) => !subscription.muted).map((subscription) => subscription.profileId)])]
      .filter((profileId): profileId is bigint => typeof profileId === 'bigint' && profileId !== input.actorProfileId);
    const excluded = new Set(input.excludeProfileIds ?? []);
    const candidateRecipients = recipients
      .filter((profileId) => !muted.has(profileId) && !excluded.has(profileId))
      .slice(0, MAX_DISCUSSION_NOTIFICATION_RECIPIENTS);
    if (!thread || !page || thread.pageId !== page.id) return;
    const activeRecipients = await this.filterReadableRecipientIds(tx, candidateRecipients, thread, page);
    if (activeRecipients.length === 0) return;
    const now = new Date();
    const href = await this.discussionReplyHref(tx, input);
    await this.persistDeliveries(tx, `discussion-comment:${input.commentId.toString()}`, 'discussion_reply', activeRecipients.map((profileId) => ({
        profileId,
        type: 'discussion_reply',
        pageId: input.pageId,
        actorProfileId: input.actorProfileId,
        sourceType: 'discussion_comment',
        sourceId: input.commentId.toString(),
        title: input.title,
        message: '참여한 토론에 새 댓글이 등록되었습니다.',
        href,
        dedupeKey: `discussion-comment:${input.commentId.toString()}:profile:${profileId.toString()}`,
        readAt: null,
        createdAt: now
      })));
  }

  async notifyDiscussionMentions(
    tx: Prisma.TransactionClient,
    input: {
      readonly pageId: bigint;
      readonly threadId: bigint;
      readonly commentId: bigint;
      readonly actorProfileId: bigint;
      readonly title: string;
      readonly usernames: readonly string[];
    }
  ): Promise<readonly bigint[]> {
    if (input.usernames.length === 0) return [];
    const [thread, page, profiles, subscriptions] = await Promise.all([
      tx.wikiDiscussionThread.findUnique({ where: { id: input.threadId } }),
      tx.wikiPage.findUnique({ where: { id: input.pageId } }),
      tx.wikiProfile.findMany({
        where: { username: { in: [...input.usernames] }, status: 'active' },
        select: { id: true, username: true }
      }),
      tx.wikiDiscussionSubscription.findMany({
        where: { threadId: input.threadId }, select: { profileId: true, muted: true }
      })
    ]);
    if (!thread || !page || thread.pageId !== page.id) return [];
    const muted = new Set(subscriptions.filter((subscription) => subscription.muted).map((subscription) => subscription.profileId));
    const requested = new Set(input.usernames.map((username) => username.toLocaleLowerCase('en-US')));
    const candidates = [...new Set(profiles
      .filter((profile) => requested.has(profile.username.toLocaleLowerCase('en-US')))
      .map((profile) => profile.id))]
      .filter((profileId) => profileId !== input.actorProfileId && !muted.has(profileId));
    const activeRecipients = await this.filterReadableRecipientIds(tx, candidates, thread, page);
    if (activeRecipients.length === 0) return [];
    const now = new Date();
    const href = await this.discussionReplyHref(tx, input);
    await this.persistDeliveries(tx, `discussion-mention:${input.commentId.toString()}`, 'discussion_mention', activeRecipients.map((profileId) => ({
      profileId,
      type: 'discussion_mention',
      pageId: input.pageId,
      actorProfileId: input.actorProfileId,
      sourceType: 'discussion_comment',
      sourceId: input.commentId.toString(),
      title: input.title,
      message: '토론 댓글에서 회원님을 언급했습니다.',
      href,
      dedupeKey: `discussion-mention:${input.commentId.toString()}:profile:${profileId.toString()}`,
      readAt: null,
      createdAt: now
    })));
    return activeRecipients;
  }

  private async discussionReplyHref(
    tx: Prisma.TransactionClient,
    input: { readonly pageId: bigint; readonly threadId: bigint; readonly commentId: bigint }
  ): Promise<string> {
    const fallback = `/wiki/discuss/${input.pageId.toString()}?thread=${input.threadId.toString()}&comment=${input.commentId.toString()}`;
    const page = await tx.wikiPage.findUnique({
      where: { id: input.pageId },
      select: { namespaceId: true, spaceId: true, localPath: true }
    });
    if (!page) return fallback;
    const namespace = await tx.wikiNamespace.findUnique({
      where: { id: page.namespaceId },
      select: { code: true }
    });
    if (namespace?.code !== 'server') return fallback;
    const serverWiki = await tx.serverWiki.findFirst({
      where: { spaceId: page.spaceId, status: { not: 'disabled' } },
      select: { slug: true }
    });
    if (!serverWiki) return fallback;
    return `${buildServerWikiToolPath(serverWiki.slug, page.localPath, 'discuss')}?thread=${input.threadId.toString()}&comment=${input.commentId.toString()}`;
  }

  private canonicalNotificationHref(
    href: string,
    type: string,
    sourceId: string,
    page?: { readonly localPath: string },
    serverSlug?: string
  ): string {
    if (!page || !serverSlug) return href;
    if ((type === 'edit_request_accepted' || type === 'edit_request_rejected') && /^\d+$/.test(sourceId)) {
      return `${buildServerWikiToolPath(serverSlug, page.localPath, 'requests')}?request=${sourceId}`;
    }
    if (type !== 'discussion_reply' && type !== 'discussion_mention') return href;
    try {
      const parsed = new URL(href, 'https://minewiki.invalid');
      const threadId = parsed.searchParams.get('thread');
      const commentId = parsed.searchParams.get('comment');
      if (!threadId || !commentId || !/^\d+$/.test(threadId) || !/^\d+$/.test(commentId)) return href;
      return `${buildServerWikiToolPath(serverSlug, page.localPath, 'discuss')}?thread=${threadId}&comment=${commentId}`;
    } catch {
      return href;
    }
  }

  async notifyEditRequestReviewed(tx: Prisma.TransactionClient, input: {
    readonly profileId: bigint;
    readonly pageId: bigint | null;
    readonly requestId: bigint;
    readonly reviewerProfileId: bigint;
    readonly status: 'accepted' | 'rejected';
    readonly title: string;
  }): Promise<void> {
    if (input.profileId === input.reviewerProfileId) return;
    const href = await this.editRequestHref(tx, input);
    await this.persistDeliveries(tx, `edit-request:${input.requestId.toString()}:${input.status}`, `edit_request_${input.status}`, [{
        profileId: input.profileId,
        type: `edit_request_${input.status}`,
        pageId: input.pageId,
        actorProfileId: input.reviewerProfileId,
        sourceType: 'edit_request',
        sourceId: input.requestId.toString(),
        title: input.title,
        message: input.status === 'accepted' ? '편집 요청이 승인되었습니다.' : '편집 요청이 반려되었습니다.',
        href,
        dedupeKey: `edit-request:${input.requestId.toString()}:${input.status}:profile:${input.profileId.toString()}`,
        readAt: null,
        createdAt: new Date()
      }]);
  }

  private async editRequestHref(
    tx: Prisma.TransactionClient,
    input: { readonly pageId: bigint | null; readonly requestId: bigint }
  ): Promise<string> {
    if (input.pageId === null) return `/wiki/edit-requests/request/${input.requestId.toString()}`;
    const fallback = `/wiki/edit-requests/${input.pageId.toString()}?request=${input.requestId.toString()}`;
    const page = await tx.wikiPage.findUnique({
      where: { id: input.pageId },
      select: { namespaceId: true, spaceId: true, localPath: true }
    });
    if (!page) return fallback;
    const namespace = await tx.wikiNamespace.findUnique({
      where: { id: page.namespaceId },
      select: { code: true }
    });
    if (namespace?.code !== 'server') return fallback;
    const serverWiki = await tx.serverWiki.findFirst({
      where: { spaceId: page.spaceId, status: { not: 'disabled' } },
      select: { slug: true }
    });
    if (!serverWiki) return fallback;
    return `${buildServerWikiToolPath(serverWiki.slug, page.localPath, 'requests')}?request=${input.requestId.toString()}`;
  }

  private async persistDeliveries(
    tx: Prisma.TransactionClient,
    eventKey: string,
    eventType: string,
    deliveries: PendingNotificationDelivery[]
  ): Promise<void> {
    if (deliveries.length === 0) return;
    if (process.env.WIKI_NOTIFICATION_DELIVERY_MODE === 'direct') {
      await tx.wikiNotification.createMany({ data: deliveries, skipDuplicates: true });
      return;
    }
    await tx.wikiNotificationEvent.createMany({
      data: [{
        eventKey,
        eventType,
        payloadJson: {
          deliveries: deliveries.map((delivery) => ({
            ...delivery,
            profileId: delivery.profileId.toString(),
            pageId: delivery.pageId?.toString() ?? null,
            actorProfileId: delivery.actorProfileId?.toString() ?? null,
            createdAt: delivery.createdAt.toISOString()
          }))
        },
        status: 'pending', attempts: 0, availableAt: new Date(), lockedAt: null,
        lockedBy: null, processedAt: null, lastError: null, createdAt: new Date()
      }],
      skipDuplicates: true
    });
  }

  private async purgeUnreadDiscussionNotifications(session: SessionPayload, profileId: bigint): Promise<void> {
    const surface = this.prisma as unknown as { wikiDiscussionComment?: unknown; wikiDiscussionThread?: unknown };
    if (!surface.wikiDiscussionComment || !surface.wikiDiscussionThread) return;
    const rows = await this.prisma.wikiNotification.findMany({
      where: { profileId, readAt: null, sourceType: 'discussion_comment' },
      select: { id: true, sourceId: true, pageId: true }
    });
    if (rows.length === 0) return;
    const commentIds = rows.flatMap((row) => /^\d+$/.test(row.sourceId) ? [BigInt(row.sourceId)] : []);
    const comments = commentIds.length > 0
      ? await this.prisma.wikiDiscussionComment.findMany({
          where: { id: { in: [...new Set(commentIds)] } }, select: { id: true, threadId: true, status: true }
        })
      : [];
    const commentById = new Map(comments.map((comment) => [comment.id, comment]));
    const threads = comments.length > 0
      ? await this.prisma.wikiDiscussionThread.findMany({
          where: { id: { in: [...new Set(comments.map((comment) => comment.threadId))] } }
        })
      : [];
    const pages = threads.length > 0
      ? await this.prisma.wikiPage.findMany({ where: { id: { in: [...new Set(threads.map((thread) => thread.pageId))] } } })
      : [];
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const profile = await this.prisma.wikiProfile.findUnique({ where: { id: profileId } });
    if (!profile?.accountId) {
      await this.prisma.wikiNotification.deleteMany({ where: { id: { in: rows.map((row) => row.id) }, profileId } });
      return;
    }
    const actor = this.permissions.actorFromSession(session, profile);
    const visible = await this.permissions.filterReadableThreads({
      accountId: session.userId,
      actor,
      items: threads.flatMap((thread) => {
        const page = pageById.get(thread.pageId);
        return page ? [{ thread, page }] : [];
      })
    });
    const visibleThreadIds = new Set(visible.map((item) => item.thread.id));
    const hiddenIds = rows.flatMap((row) => {
      const comment = /^\d+$/.test(row.sourceId) ? commentById.get(BigInt(row.sourceId)) : undefined;
      return comment && comment.status === 'normal' && visibleThreadIds.has(comment.threadId) ? [] : [row.id];
    });
    if (hiddenIds.length > 0) {
      await this.prisma.wikiNotification.deleteMany({ where: { id: { in: hiddenIds }, profileId } });
    }
  }

  private async filterReadableRecipientIds(
    tx: Prisma.TransactionClient,
    profileIds: readonly bigint[],
    thread: { readonly id: bigint; readonly pageId: bigint; readonly status: string },
    page: {
      readonly id: bigint; readonly spaceId: bigint; readonly namespaceId: number;
      readonly title: string; readonly protectionLevel: string; readonly status: string; readonly createdBy: bigint | null;
    }
  ): Promise<bigint[]> {
    if (profileIds.length === 0) return [];
    const surface = tx as unknown as { wikiProfile?: unknown; accountRole?: unknown };
    if (!surface.wikiProfile || !surface.accountRole || typeof (this.permissions as Partial<WikiPermissionService>).filterReadableThreads !== 'function') {
      return [...profileIds];
    }
    const profiles = await tx.wikiProfile.findMany({
      where: { id: { in: [...profileIds] }, accountId: { not: null }, status: 'active' },
      select: { id: true, accountId: true, status: true }
    });
    const accountIds = profiles.flatMap((profile) => profile.accountId ? [profile.accountId] : []);
    const accessRows = accountIds.length > 0
      ? await tx.accountRole.findMany({
          where: { accountId: { in: accountIds } },
          include: { role: { include: { rolePermissions: { include: { permission: true } } } } }
        })
      : [];
    const groupsByAccount = new Map<string, Set<string>>();
    const permissionsByAccount = new Map<string, Set<string>>();
    for (const row of accessRows) {
      const groups = groupsByAccount.get(row.accountId) ?? new Set<string>();
      groups.add(row.role.code);
      groupsByAccount.set(row.accountId, groups);
      const permissions = permissionsByAccount.get(row.accountId) ?? new Set<string>();
      for (const entry of row.role.rolePermissions) permissions.add(entry.permission.code);
      permissionsByAccount.set(row.accountId, permissions);
    }
    const decisions: Array<bigint | null> = [];
    for (let offset = 0; offset < profiles.length; offset += DISCUSSION_ACL_RECIPIENT_CHUNK) {
      const chunk = profiles.slice(offset, offset + DISCUSSION_ACL_RECIPIENT_CHUNK);
      decisions.push(...await Promise.all(chunk.map(async (profile) => {
        if (!profile.accountId) return null;
        const actor = {
          accountId: profile.accountId,
          profileId: profile.id,
          status: profile.status,
          groups: [...(groupsByAccount.get(profile.accountId) ?? [])],
          permissions: [...(permissionsByAccount.get(profile.accountId) ?? [])]
        };
        const visible = await this.permissions.filterReadableThreads({
          accountId: profile.accountId,
          actor,
          items: [{ thread, page }],
          store: tx
        });
        return visible.length === 1 ? profile.id : null;
      })));
    }
    return decisions.filter((profileId): profileId is bigint => profileId !== null);
  }

  private async legacyReadablePages<T extends { readonly id: bigint }>(accountId: string, pages: readonly T[]): Promise<T[]> {
    const readable: T[] = [];
    for (const page of pages) {
      try {
        await this.permissions.assertCanReadPage({ accountId, page: page as never });
        readable.push(page);
      } catch {
        // The legacy permission surface exposes only single-page checks.
      }
    }
    return readable;
  }

  private id(value: string, label: string): bigint {
    if (!/^\d+$/.test(value)) throw new BadRequestException(`${label} must be an unsigned integer.`);
    return BigInt(value);
  }
}

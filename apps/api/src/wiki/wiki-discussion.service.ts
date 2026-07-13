import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { wikiUrl } from '@minewiki/wiki-core';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import type { SessionPayload } from '../session/session.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiNotificationService } from './wiki-notification.service';
import { buildServerWikiPagePath } from './wiki-read.service';

export interface WikiThreadSummary {
  readonly id: string;
  readonly pageId: string;
  readonly title: string;
  readonly status: string;
  readonly createdBy: string;
  readonly createdByName: string;
  readonly commentCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WikiRecentThreadSummary extends WikiThreadSummary {
  readonly pageTitle: string;
  readonly namespace: string;
  readonly routePath: string;
  readonly discussionHref: string;
}

export interface WikiRecentThreadListResponse {
  readonly items: WikiRecentThreadSummary[];
  readonly nextCursor: string | null;
}

export interface WikiThreadDetail extends WikiThreadSummary {
  readonly canModerate: boolean;
  readonly canReply: boolean;
  readonly subscribed: boolean;
  readonly pinnedCommentId: string | null;
  readonly nextCommentCursor: string | null;
  readonly comments: ReadonlyArray<{
    readonly id: string;
    readonly content: string | null;
    readonly status: string;
    readonly createdBy: string;
    readonly createdByName: string;
    readonly createdAt: string;
    readonly canDelete: boolean;
    readonly pinned: boolean;
  }>;
}

@Injectable()
export class WikiDiscussionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiProfiles: WikiProfileService,
    private readonly wikiPermissions: WikiPermissionService,
    @Optional() private readonly events?: BusinessEventService,
    @Optional() private readonly notifications?: WikiNotificationService
  ) {}

  async listThreads(pageId: string, accountId?: string | null): Promise<WikiThreadSummary[]> {
    const page = await this.readablePage(pageId, accountId ?? null);
    const threads = await this.prisma.wikiDiscussionThread.findMany({
      where: { pageId: page.id },
      orderBy: [{ updatedAt: 'desc' }],
      take: 100
    });
    const profileById = await this.profileNames(threads.map((thread) => thread.createdBy));
    const countRows = threads.length > 0
      ? await this.prisma.wikiDiscussionComment.groupBy({
          by: ['threadId'],
          where: { threadId: { in: threads.map((thread) => thread.id) } },
          _count: { _all: true }
        })
      : [];
    const countByThreadId = new Map(countRows.map((row) => [row.threadId, row._count._all]));
    return threads.map((thread) => this.toThreadSummary(thread, profileById, countByThreadId.get(thread.id) ?? 0));
  }

  async listRecent(
    accountId: string | null,
    cursor?: string,
    requestedLimit = 30
  ): Promise<WikiRecentThreadListResponse> {
    const limit = Math.min(Math.max(requestedLimit, 1), 50);
    const decoded = cursor ? this.decodeRecentCursor(cursor) : null;
    const snapshotAt = decoded?.snapshotAt ?? new Date();
    const position = decoded ? { updatedAt: decoded.updatedAt, id: decoded.id } : null;
    const where: Prisma.WikiDiscussionThreadWhereInput = {
      updatedAt: { lte: snapshotAt },
      ...(position ? {
        OR: [
          { updatedAt: { lt: position.updatedAt } },
          { updatedAt: position.updatedAt, id: { lt: position.id } }
        ]
      } : {})
    };
    const take = Math.min(limit * 5 + 1, 251);
    const threads = await this.prisma.wikiDiscussionThread.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take
    });
    if (threads.length === 0) return { items: [], nextCursor: null };
    const pages = await this.prisma.wikiPage.findMany({ where: { id: { in: [...new Set(threads.map((thread) => thread.pageId))] } } });
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const namespaces = await this.prisma.wikiNamespace.findMany({
      where: { id: { in: [...new Set(pages.map((page) => page.namespaceId))] } },
      select: { id: true, code: true }
    });
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    const serverSpaces = [...new Set(pages.filter((page) => namespaceById.get(page.namespaceId) === 'server').map((page) => page.spaceId))];
    const serverWikis = serverSpaces.length > 0
      ? await this.prisma.serverWiki.findMany({ where: { spaceId: { in: serverSpaces } }, select: { spaceId: true, slug: true } })
      : [];
    const serverSlugBySpace = new Map(serverWikis.map((wiki) => [wiki.spaceId, wiki.slug]));
    const readableByPageId = new Map<bigint, boolean>();
    const visibleThreads = [];
    for (const thread of threads) {
      const page = pageById.get(thread.pageId);
      if (!page || page.status === 'deleted') continue;
      let readable = readableByPageId.get(page.id);
      if (readable === undefined) {
        try {
          await this.wikiPermissions.assertCanReadPage({ accountId, page });
          readable = true;
        } catch {
          readable = false;
        }
        readableByPageId.set(page.id, readable);
      }
      if (readable) visibleThreads.push({ thread, page });
      if (visibleThreads.length > limit) break;
    }
    const pageRows = visibleThreads.slice(0, limit);
    const profileById = await this.profileNames(pageRows.map(({ thread }) => thread.createdBy));
    const countRows = pageRows.length > 0
      ? await this.prisma.wikiDiscussionComment.groupBy({
          by: ['threadId'],
          where: { threadId: { in: pageRows.map(({ thread }) => thread.id) } },
          _count: { _all: true }
        })
      : [];
    const countByThreadId = new Map(countRows.map((row) => [row.threadId, row._count._all]));
    const items = pageRows.map(({ thread, page }) => {
      const namespace = namespaceById.get(page.namespaceId) ?? 'main';
      const serverSlug = serverSlugBySpace.get(page.spaceId);
      const routePath = namespace === 'server' && serverSlug
        ? buildServerWikiPagePath(serverSlug, page.localPath)
        : wikiUrl(namespace as Parameters<typeof wikiUrl>[0], page.title);
      return {
        ...this.toThreadSummary(thread, profileById, countByThreadId.get(thread.id) ?? 0),
        pageTitle: page.displayTitle,
        namespace,
        routePath,
        discussionHref: namespace === 'server'
          ? `${routePath}/discuss?thread=${thread.id.toString()}`
          : `/wiki/discuss/${page.id.toString()}?returnTo=${encodeURIComponent(routePath)}&thread=${thread.id.toString()}`
      };
    });
    const cursorRow = pageRows.at(-1)?.thread ?? threads.at(-1);
    const hasMore = visibleThreads.length > limit || threads.length === take;
    return {
      items,
      nextCursor: hasMore && cursorRow ? this.encodeRecentCursor(snapshotAt, cursorRow.updatedAt, cursorRow.id) : null
    };
  }

  async getThread(
    threadId: string,
    session?: SessionPayload | null,
    commentCursor?: string,
    requestedLimit = 100,
    focusCommentId?: string
  ): Promise<WikiThreadDetail> {
    const id = this.parseId(threadId, 'threadId');
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id } });
    if (!thread) throw new NotFoundException('Wiki discussion thread not found.');
    const page = await this.readablePage(thread.pageId.toString(), session?.userId ?? null);
    const commentLimit = Math.min(Math.max(requestedLimit, 1), 200);
    const cursorId = commentCursor ? this.parseId(commentCursor, 'commentCursor') : null;
    const focusId = focusCommentId ? this.parseId(focusCommentId, 'focusCommentId') : null;
    if (cursorId && focusId) throw new BadRequestException('commentCursor and focusCommentId cannot be combined.');
    if (focusId) {
      const focused = await this.prisma.wikiDiscussionComment.findUnique({ where: { id: focusId }, select: { threadId: true } });
      if (!focused || focused.threadId !== thread.id) throw new NotFoundException('Wiki discussion comment not found.');
    }
    const comments = await this.prisma.wikiDiscussionComment.findMany({
      where: {
        threadId: thread.id,
        ...(cursorId ? { id: { lt: cursorId } } : focusId ? { id: { lte: focusId } } : {})
      },
      orderBy: [{ id: 'desc' }],
      take: commentLimit + 1
    });
    const hasOlderComments = comments.length > commentLimit;
    const pageComments = comments.slice(0, commentLimit);
    const pinnedComment = thread.pinnedCommentId && !pageComments.some((comment) => comment.id === thread.pinnedCommentId)
      ? await this.prisma.wikiDiscussionComment.findUnique({ where: { id: thread.pinnedCommentId } })
      : null;
    const displayComments = pinnedComment && pinnedComment.threadId === thread.id ? [...pageComments, pinnedComment] : pageComments;
    const commentCount = await this.prisma.wikiDiscussionComment.count({ where: { threadId: thread.id } });
    const profileById = await this.profileNames([thread.createdBy, ...displayComments.map((comment) => comment.createdBy)]);
    const viewer = session ? await this.wikiProfiles.ensureWikiProfile(session.userId) : null;
    const subscription = viewer ? await this.prisma.wikiDiscussionSubscription.findUnique({
      where: { threadId_profileId: { threadId: thread.id, profileId: viewer.id } }, select: { muted: true }
    }) : null;
    const canManage = viewer && session
      ? await this.wikiPermissions.canManagePage({ actor: this.wikiPermissions.actorFromSession(session, viewer), page })
      : false;
    let canReply = false;
    if (viewer && session && thread.status === 'open') {
      try {
        await this.wikiPermissions.assertCanDiscussPage({
          actor: this.wikiPermissions.actorFromSession(session, viewer),
          page
        });
        canReply = true;
      } catch {
        canReply = false;
      }
    }
    const canModerate = Boolean(viewer && (thread.createdBy === viewer.id || canManage));
    return {
      ...this.toThreadSummary(thread, profileById, commentCount),
      canModerate,
      canReply,
      subscribed: Boolean(subscription && !subscription.muted),
      pinnedCommentId: thread.pinnedCommentId?.toString() ?? null,
      nextCommentCursor: hasOlderComments ? pageComments.at(-1)?.id.toString() ?? null : null,
      comments: displayComments.sort((left, right) => {
        if (left.id === thread.pinnedCommentId) return -1;
        if (right.id === thread.pinnedCommentId) return 1;
        return left.id < right.id ? -1 : 1;
      }).map((comment) => ({
        id: comment.id.toString(),
        content: comment.status === 'deleted' ? null : comment.content,
        status: comment.status,
        createdBy: comment.createdBy.toString(),
        createdByName: profileById.get(comment.createdBy) ?? '알 수 없는 사용자',
        createdAt: comment.createdAt.toISOString(),
        canDelete: Boolean(comment.status !== 'deleted' && viewer && (comment.createdBy === viewer.id || canManage)),
        pinned: comment.id === thread.pinnedCommentId
      }))
    };
  }

  async createThread(
    session: SessionPayload,
    pageId: string,
    input: { readonly title?: string; readonly content?: string }
  ): Promise<WikiThreadDetail> {
    const parsedPageId = this.parseId(pageId, 'pageId');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: parsedPageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    await this.wikiPermissions.assertCanDiscussPage({
      actor: this.wikiPermissions.actorFromSession(session, profile),
      page
    });
    const title = this.requiredText(input.title, 'title', 255);
    const content = this.requiredText(input.content, 'content', 10_000);
    const now = new Date();
    const thread = await this.prisma.$transaction(async (tx) => {
      const created = await tx.wikiDiscussionThread.create({
        data: { pageId: page.id, title, status: 'open', createdBy: profile.id, createdAt: now, updatedAt: now }
      });
      await tx.wikiDiscussionComment.create({
        data: { threadId: created.id, content, status: 'normal', createdBy: profile.id, createdAt: now }
      });
      await tx.wikiDiscussionSubscription.create({
        data: { threadId: created.id, profileId: profile.id, muted: false, createdAt: now, updatedAt: now }
      });
      return created;
    });
    await this.audit('wiki.discussion.create', session, profile.id, page.id, thread.id);
    return this.getThread(thread.id.toString(), session);
  }

  async addComment(
    session: SessionPayload,
    threadId: string,
    input: { readonly content?: string }
  ): Promise<WikiThreadDetail> {
    const id = this.parseId(threadId, 'threadId');
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id } });
    if (!thread) throw new NotFoundException('Wiki discussion thread not found.');
    if (thread.status !== 'open') throw new BadRequestException('Wiki discussion thread is closed.');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: thread.pageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    await this.wikiPermissions.assertCanDiscussPage({ actor: this.wikiPermissions.actorFromSession(session, profile), page });
    const content = this.requiredText(input.content, 'content', 10_000);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const comment = await tx.wikiDiscussionComment.create({
        data: { threadId: thread.id, content, status: 'normal', createdBy: profile.id, createdAt: now }
      });
      await tx.wikiDiscussionSubscription.upsert({
        where: { threadId_profileId: { threadId: thread.id, profileId: profile.id } },
        create: { threadId: thread.id, profileId: profile.id, muted: false, createdAt: now, updatedAt: now },
        update: {}
      });
      await tx.wikiDiscussionThread.update({ where: { id: thread.id }, data: { updatedAt: now } });
      await this.notifications?.notifyDiscussionReply(tx, {
        pageId: page.id,
        threadId: thread.id,
        commentId: comment.id,
        actorProfileId: profile.id,
        title: thread.title
      });
    });
    await this.audit('wiki.discussion.comment', session, profile.id, page.id, thread.id);
    return this.getThread(thread.id.toString(), session);
  }

  async setSubscription(session: SessionPayload, threadId: string, subscribed: boolean): Promise<{ readonly subscribed: boolean }> {
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id: this.parseId(threadId, 'threadId') } });
    if (!thread) throw new NotFoundException('Wiki discussion thread not found.');
    const page = await this.readablePage(thread.pageId.toString(), session.userId);
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    await this.wikiPermissions.assertCanDiscussPage({ actor: this.wikiPermissions.actorFromSession(session, profile), page });
    const now = new Date();
    await this.prisma.wikiDiscussionSubscription.upsert({
      where: { threadId_profileId: { threadId: thread.id, profileId: profile.id } },
      create: { threadId: thread.id, profileId: profile.id, muted: !subscribed, createdAt: now, updatedAt: now },
      update: { muted: !subscribed, updatedAt: now }
    });
    return { subscribed };
  }

  async setThreadStatus(
    session: SessionPayload,
    threadId: string,
    status: 'open' | 'closed'
  ): Promise<WikiThreadDetail> {
    const id = this.parseId(threadId, 'threadId');
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id } });
    if (!thread) throw new NotFoundException('Wiki discussion thread not found.');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: thread.pageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    if (thread.createdBy !== profile.id && !(await this.wikiPermissions.canManagePage({ actor, page }))) {
      throw new ForbiddenException('Wiki discussion moderation is not allowed.');
    }
    await this.prisma.wikiDiscussionThread.update({ where: { id }, data: { status, updatedAt: new Date() } });
    await this.audit(`wiki.discussion.${status}`, session, profile.id, page.id, thread.id);
    return this.getThread(thread.id.toString(), session);
  }

  async updateThreadTopic(session: SessionPayload, threadId: string, titleInput?: string): Promise<WikiThreadDetail> {
    const thread = await this.moderatableThread(session, threadId);
    const title = this.requiredText(titleInput, 'title', 255);
    await this.prisma.wikiDiscussionThread.update({ where: { id: thread.id }, data: { title, updatedAt: new Date() } });
    await this.audit('wiki.discussion.topic', session, thread.profileId, thread.pageId, thread.id);
    return this.getThread(thread.id.toString(), session);
  }

  async setPinnedComment(session: SessionPayload, threadId: string, commentId: string | null): Promise<WikiThreadDetail> {
    const thread = await this.moderatableThread(session, threadId);
    const parsedCommentId = commentId ? this.parseId(commentId, 'commentId') : null;
    if (parsedCommentId) {
      const comment = await this.prisma.wikiDiscussionComment.findUnique({ where: { id: parsedCommentId } });
      if (!comment || comment.threadId !== thread.id || comment.status === 'deleted') throw new NotFoundException('Wiki discussion comment not found.');
    }
    await this.prisma.wikiDiscussionThread.update({ where: { id: thread.id }, data: { pinnedCommentId: parsedCommentId, updatedAt: new Date() } });
    await this.audit(parsedCommentId ? 'wiki.discussion.pin' : 'wiki.discussion.unpin', session, thread.profileId, thread.pageId, thread.id);
    return this.getThread(thread.id.toString(), session);
  }

  async deleteComment(session: SessionPayload, threadId: string, commentId: string): Promise<WikiThreadDetail> {
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id: this.parseId(threadId, 'threadId') } });
    if (!thread) throw new NotFoundException('Wiki discussion thread not found.');
    const comment = await this.prisma.wikiDiscussionComment.findUnique({ where: { id: this.parseId(commentId, 'commentId') } });
    if (!comment || comment.threadId !== thread.id) throw new NotFoundException('Wiki discussion comment not found.');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: thread.pageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    if (comment.createdBy !== profile.id && !(await this.wikiPermissions.canManagePage({ actor, page }))) {
      throw new ForbiddenException('Wiki discussion comment deletion is not allowed.');
    }
    await this.prisma.wikiDiscussionComment.update({
      where: { id: comment.id },
      data: { status: 'deleted', content: '', updatedAt: new Date() }
    });
    await this.audit('wiki.discussion.comment_delete', session, profile.id, page.id, thread.id);
    return this.getThread(thread.id.toString(), session);
  }

  private async readablePage(pageId: string, accountId: string | null) {
    const page = await this.prisma.wikiPage.findUnique({ where: { id: this.parseId(pageId, 'pageId') } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    await this.wikiPermissions.assertCanReadPage({ accountId, page });
    return page;
  }

  private async moderatableThread(session: SessionPayload, threadId: string) {
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id: this.parseId(threadId, 'threadId') } });
    if (!thread) throw new NotFoundException('Wiki discussion thread not found.');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: thread.pageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    if (thread.createdBy !== profile.id && !(await this.wikiPermissions.canManagePage({ actor, page }))) {
      throw new ForbiddenException('Wiki discussion moderation is not allowed.');
    }
    return { ...thread, profileId: profile.id };
  }

  private async profileNames(ids: readonly bigint[]) {
    const unique = [...new Set(ids)];
    const profiles = unique.length > 0
      ? await this.prisma.wikiProfile.findMany({ where: { id: { in: unique } }, select: { id: true, displayName: true } })
      : [];
    return new Map(profiles.map((profile) => [profile.id, profile.displayName]));
  }

  private toThreadSummary(
    thread: { id: bigint; pageId: bigint; title: string; status: string; createdBy: bigint; createdAt: Date; updatedAt: Date },
    profileById: ReadonlyMap<bigint, string>,
    commentCount: number
  ): WikiThreadSummary {
    return {
      id: thread.id.toString(), pageId: thread.pageId.toString(), title: thread.title, status: thread.status,
      createdBy: thread.createdBy.toString(), createdByName: profileById.get(thread.createdBy) ?? '알 수 없는 사용자',
      commentCount, createdAt: thread.createdAt.toISOString(), updatedAt: thread.updatedAt.toISOString()
    };
  }

  private requiredText(value: string | undefined, label: string, maxLength: number): string {
    const text = value?.trim();
    if (!text) throw new BadRequestException(`${label} is required.`);
    if (text.length > maxLength) throw new BadRequestException(`${label} is too long.`);
    return text;
  }

  private parseId(value: string, label: string): bigint {
    if (!/^\d+$/.test(value)) throw new BadRequestException(`${label} must be an unsigned integer.`);
    return BigInt(value);
  }

  private encodeRecentCursor(snapshotAt: Date, updatedAt: Date, id: bigint): string {
    return Buffer.from(JSON.stringify({ snapshotAt: snapshotAt.toISOString(), updatedAt: updatedAt.toISOString(), id: id.toString() })).toString('base64url');
  }

  private decodeRecentCursor(value: string): { snapshotAt: Date; updatedAt: Date; id: bigint } {
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { snapshotAt?: string; updatedAt?: string; id?: string };
      const snapshotAt = new Date(decoded.snapshotAt ?? '');
      const updatedAt = new Date(decoded.updatedAt ?? '');
      if (Number.isNaN(snapshotAt.getTime()) || Number.isNaN(updatedAt.getTime()) || !decoded.id || !/^\d+$/.test(decoded.id)) throw new Error('invalid');
      return { snapshotAt, updatedAt, id: BigInt(decoded.id) };
    } catch {
      throw new BadRequestException('Invalid recent discussion cursor.');
    }
  }

  private async audit(action: string, session: SessionPayload, profileId: bigint, pageId: bigint, threadId: bigint) {
    await this.events?.audit(action, {
      category: 'wiki', actorAccountId: session.userId, actorProfileId: profileId,
      subjectType: 'wiki_discussion', subjectId: threadId.toString(), metadata: { pageId: pageId.toString() }
    });
  }
}

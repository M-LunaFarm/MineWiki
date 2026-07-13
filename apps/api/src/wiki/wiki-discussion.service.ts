import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import type { SessionPayload } from '../session/session.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';

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

export interface WikiThreadDetail extends WikiThreadSummary {
  readonly comments: ReadonlyArray<{
    readonly id: string;
    readonly content: string | null;
    readonly status: string;
    readonly createdBy: string;
    readonly createdByName: string;
    readonly createdAt: string;
  }>;
}

@Injectable()
export class WikiDiscussionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiProfiles: WikiProfileService,
    private readonly wikiPermissions: WikiPermissionService,
    @Optional() private readonly events?: BusinessEventService
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

  async getThread(threadId: string, accountId?: string | null): Promise<WikiThreadDetail> {
    const id = this.parseId(threadId, 'threadId');
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id } });
    if (!thread) throw new NotFoundException('Wiki discussion thread not found.');
    await this.readablePage(thread.pageId.toString(), accountId ?? null);
    const comments = await this.prisma.wikiDiscussionComment.findMany({
      where: { threadId: thread.id },
      orderBy: [{ id: 'asc' }],
      take: 500
    });
    const profileById = await this.profileNames([thread.createdBy, ...comments.map((comment) => comment.createdBy)]);
    return {
      ...this.toThreadSummary(thread, profileById, comments.length),
      comments: comments.map((comment) => ({
        id: comment.id.toString(),
        content: comment.status === 'deleted' ? null : comment.content,
        status: comment.status,
        createdBy: comment.createdBy.toString(),
        createdByName: profileById.get(comment.createdBy) ?? '알 수 없는 사용자',
        createdAt: comment.createdAt.toISOString()
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
      return created;
    });
    await this.audit('wiki.discussion.create', session, profile.id, page.id, thread.id);
    return this.getThread(thread.id.toString(), session.userId);
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
    await this.prisma.$transaction([
      this.prisma.wikiDiscussionComment.create({
        data: { threadId: thread.id, content, status: 'normal', createdBy: profile.id, createdAt: now }
      }),
      this.prisma.wikiDiscussionThread.update({ where: { id: thread.id }, data: { updatedAt: now } })
    ]);
    await this.audit('wiki.discussion.comment', session, profile.id, page.id, thread.id);
    return this.getThread(thread.id.toString(), session.userId);
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
    return this.getThread(thread.id.toString(), session.userId);
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
    return this.getThread(thread.id.toString(), session.userId);
  }

  private async readablePage(pageId: string, accountId: string | null) {
    const page = await this.prisma.wikiPage.findUnique({ where: { id: this.parseId(pageId, 'pageId') } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    await this.wikiPermissions.assertCanReadPage({ accountId, page });
    return page;
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

  private async audit(action: string, session: SessionPayload, profileId: bigint, pageId: bigint, threadId: bigint) {
    await this.events?.audit(action, {
      category: 'wiki', actorAccountId: session.userId, actorProfileId: profileId,
      subjectType: 'wiki_discussion', subjectId: threadId.toString(), metadata: { pageId: pageId.toString() }
    });
  }
}

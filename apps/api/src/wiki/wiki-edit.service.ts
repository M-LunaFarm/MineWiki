import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional
} from '@nestjs/common';
import { hashContent, parseMarkup, renderDocument, slugifyTitle, WIKI_RENDERER_VERSION } from '@minewiki/wiki-core';
import type { Prisma, WikiEditRequest } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import type { SessionPayload } from '../session/session.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiLinkIndexService } from './wiki-link-index.service';
import { WikiNotificationService } from './wiki-notification.service';

type ChangeType = 'create' | 'edit' | 'move' | 'delete' | 'restore' | 'revert';

export interface WikiPageMutationRequest {
  readonly namespace?: string;
  readonly title?: string;
  readonly displayTitle?: string;
  readonly spaceId?: string;
  readonly pageType?: string;
  readonly contentRaw?: string;
  readonly editSummary?: string;
  readonly isMinor?: boolean;
  readonly baseRevisionId?: string;
}

export interface WikiSectionMutationRequest {
  readonly heading?: string;
  readonly contentRaw?: string;
  readonly editSummary?: string;
  readonly isMinor?: boolean;
  readonly baseRevisionId?: string;
}

export interface WikiMoveRequest {
  readonly title?: string;
  readonly displayTitle?: string;
  readonly reason?: string;
  readonly leaveRedirect?: boolean;
}

export interface WikiRevertRequest {
  readonly revisionId?: string;
  readonly baseRevisionId?: string;
  readonly reason?: string;
}

export interface WikiStatusMutationRequest {
  readonly reason?: string;
}

export interface WikiMutationResponse {
  readonly pageId: string;
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly namespace: string;
  readonly title: string;
  readonly slug: string;
}

export interface WikiMoveResponse extends WikiMutationResponse {
  readonly previousTitle: string;
  readonly redirectPageId: string | null;
}

export interface WikiStatusMutationResponse {
  readonly pageId: string;
  readonly status: 'normal' | 'deleted';
}

export interface WikiRevisionResponse {
  readonly id: string;
  readonly pageId: string;
  readonly revisionNo: number;
  readonly parentRevisionId: string | null;
  readonly contentRaw: string;
  readonly contentHash: string;
  readonly contentSize: number;
  readonly syntaxVersion: string;
  readonly editSummary: string | null;
  readonly isMinor: boolean;
  readonly createdBy: string | null;
  readonly actorUserId: string | null;
  readonly createdAt: string;
  readonly visibility: string;
}

export interface WikiRevisionDiffResponse {
  readonly left: WikiRevisionResponse;
  readonly right: WikiRevisionResponse;
  readonly hunks: Array<{
    readonly type: 'context' | 'added' | 'removed';
    readonly line: string;
    readonly leftLine: number | null;
    readonly rightLine: number | null;
  }>;
}

export interface WikiPreviewResponse {
  readonly html: string;
  readonly links: string[];
  readonly categories: string[];
  readonly errors: string[];
  readonly blockingErrors: string[];
}

@Injectable()
export class WikiEditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiProfiles: WikiProfileService,
    private readonly wikiPermissions: WikiPermissionService,
    @Optional() private readonly events?: BusinessEventService,
    @Optional() private readonly wikiLinks?: WikiLinkIndexService,
    @Optional() private readonly notifications?: WikiNotificationService
  ) {}

  async createPage(session: SessionPayload, request: WikiPageMutationRequest): Promise<WikiMutationResponse> {
    const namespaceCode = this.cleanNamespace(request.namespace);
    const title = this.requiredString(request.title, 'title');
    const contentRaw = this.requiredString(request.contentRaw, 'contentRaw');
    const namespace = await this.prisma.wikiNamespace.findUnique({
      where: { code: namespaceCode }
    });
    if (!namespace) {
      throw new NotFoundException('Wiki namespace not found.');
    }
    const createTarget = await this.resolveCreateTarget(namespaceCode, title, request.spaceId);
    const spaceId = createTarget.spaceId;
    const actor = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const slug = slugifyTitle(title);
    const now = new Date();
    await this.wikiPermissions.assertCanCreatePage({
      actor: this.wikiPermissions.actorFromSession(session, actor),
      namespaceCode,
      spaceId,
      title,
      pageType: this.cleanOptional(request.pageType) ?? createTarget.pageType
    });

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.wikiPage.findUnique({
        where: {
          namespaceId_slug: {
            namespaceId: namespace.id,
            slug
          }
        }
      });
      if (existing) {
        throw new ConflictException('Wiki page already exists.');
      }
      const page = await tx.wikiPage.create({
        data: {
          namespaceId: namespace.id,
          spaceId,
          localPath: slug,
          slug,
          title,
          displayTitle: this.cleanOptional(request.displayTitle) ?? createTarget.displayTitle,
          pageType: this.cleanOptional(request.pageType) ?? createTarget.pageType,
          protectionLevel: 'open',
          status: 'normal',
          createdBy: actor.id,
          createdAt: now,
          updatedAt: now
        }
      });
      const revision = await this.createRevision(tx, {
        pageId: page.id,
        revisionNo: 1,
        parentRevisionId: null,
        contentRaw,
        editSummary: this.cleanOptional(request.editSummary),
        isMinor: Boolean(request.isMinor),
        actorId: actor.id,
        title: page.displayTitle,
        createdAt: now
      });
      await tx.wikiPage.update({
        where: { id: page.id },
        data: {
          currentRevisionId: revision.id,
          updatedAt: now
        }
      });
      await this.insertRecentChange(tx, {
        pageId: page.id,
        revisionId: revision.id,
        actorId: actor.id,
        changeType: 'create',
        title: page.title,
        namespaceCode,
        summary: revision.editSummary,
        isMinor: revision.isMinor,
        createdAt: now
      });
      return {
        pageId: page.id.toString(),
        revisionId: revision.id.toString(),
        revisionNo: revision.revisionNo,
        namespace: namespaceCode,
        title: page.title,
        slug: page.slug
      };
    });
    await this.events?.audit('wiki.create', {
      category: 'wiki',
      actorAccountId: session.userId,
      actorProfileId: actor.id,
      subjectType: 'wiki_page',
      subjectId: result.pageId,
      metadata: {
        namespace: result.namespace,
        title: result.title,
        revisionId: result.revisionId,
        revisionNo: result.revisionNo
      }
    });
    return result;
  }

  private async resolveCreateTarget(namespaceCode: string, title: string, requestedSpaceId?: string) {
    if (requestedSpaceId) {
      return {
        spaceId: this.parseBigIntId(requestedSpaceId, 'spaceId'),
        displayTitle: title.split('/').at(-1) ?? title,
        pageType: namespaceCode === 'server' ? 'server' : 'article',
      };
    }
    if (namespaceCode === 'server') {
      const [serverSlug, ...relativeParts] = slugifyTitle(title).split('/');
      if (!serverSlug || relativeParts.length === 0) {
        throw new BadRequestException('Server wiki child pages require a server slug and document path.');
      }
      const serverWiki = await this.prisma.serverWiki.findUnique({
        where: { slug: serverSlug },
        select: { spaceId: true },
      });
      if (!serverWiki) {
        throw new NotFoundException('Server wiki not found.');
      }
      return {
        spaceId: serverWiki.spaceId,
        displayTitle: relativeParts.at(-1) ?? title,
        pageType: 'server',
      };
    }
    return {
      spaceId: await this.findDefaultSpaceId(namespaceCode),
      displayTitle: title,
      pageType: 'article',
    };
  }

  async updatePage(session: SessionPayload, pageId: string, request: WikiPageMutationRequest, options: { readonly attributionProfileId?: bigint } = {}): Promise<WikiMutationResponse> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const contentRaw = this.requiredString(request.contentRaw, 'contentRaw');
    const actor = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const attributionProfileId = options.attributionProfileId ?? actor.id;
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const page = await tx.wikiPage.findUnique({ where: { id: parsedPageId } });
      if (!page || page.status === 'deleted') {
        throw new NotFoundException('Wiki page not found.');
      }
      const namespace = await tx.wikiNamespace.findUnique({ where: { id: page.namespaceId } });
      if (!namespace) {
        throw new NotFoundException('Wiki namespace not found.');
      }
      await this.wikiPermissions.assertCanEditPage({
        actor: this.wikiPermissions.actorFromSession(session, actor),
        page,
        store: tx
      });
      if (request.baseRevisionId && page.currentRevisionId?.toString() !== request.baseRevisionId) {
        throw new ConflictException('Base revision does not match current revision.');
      }
      const latest = await this.findLatestRevision(tx, page.id);
      await this.assertLockedSectionsUnchanged({
        actor: this.wikiPermissions.actorFromSession(session, actor),
        page,
        currentContent: latest?.contentRaw ?? '',
        nextContent: contentRaw,
        store: tx
      });
      const revision = await this.createRevision(tx, {
        pageId: page.id,
        revisionNo: latest ? latest.revisionNo + 1 : 1,
        parentRevisionId: latest?.id ?? null,
        contentRaw,
        editSummary: this.cleanOptional(request.editSummary),
        isMinor: Boolean(request.isMinor),
        actorId: attributionProfileId,
        title: page.displayTitle,
        createdAt: now
      });
      await tx.wikiPage.update({
        where: { id: page.id },
        data: {
          currentRevisionId: revision.id,
          updatedAt: now
        }
      });
      await this.insertRecentChange(tx, {
        pageId: page.id,
        revisionId: revision.id,
        actorId: attributionProfileId,
        changeType: 'edit',
        title: page.title,
        namespaceCode: namespace.code,
        summary: revision.editSummary,
        isMinor: revision.isMinor,
        createdAt: now
      });
      return {
        pageId: page.id.toString(),
        revisionId: revision.id.toString(),
        revisionNo: revision.revisionNo,
        namespace: namespace.code,
        title: page.title,
        slug: page.slug
      };
    });
    await this.events?.audit('wiki.edit', {
      category: 'wiki',
      actorAccountId: session.userId,
      actorProfileId: actor.id,
      subjectType: 'wiki_page',
      subjectId: result.pageId,
      metadata: {
        namespace: result.namespace,
        title: result.title,
        revisionId: result.revisionId,
        attributionProfileId: attributionProfileId.toString(),
        revisionNo: result.revisionNo
      }
    });
    return result;
  }

  async acceptEditRequest(session: SessionPayload, input: { readonly requestId: bigint; readonly reviewNote: string | null }): Promise<{ readonly mutation: WikiMutationResponse; readonly request: WikiEditRequest }> {
    const reviewer = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const editRequest = await tx.wikiEditRequest.findUnique({ where: { id: input.requestId } });
      if (!editRequest) throw new NotFoundException('Wiki edit request not found.');
      const page = await tx.wikiPage.findUnique({ where: { id: editRequest.pageId } });
      if (!page || page.status === 'deleted') throw new NotFoundException('Wiki page not found.');
      const namespace = await tx.wikiNamespace.findUnique({ where: { id: page.namespaceId } });
      if (!namespace) throw new NotFoundException('Wiki namespace not found.');
      const reviewerActor = this.wikiPermissions.actorFromSession(session, reviewer);
      if (!(await this.wikiPermissions.canManagePage({ actor: reviewerActor, page, store: tx }))) {
        throw new ForbiddenException('Edit request review is not allowed.');
      }
      const claimed = await tx.wikiEditRequest.updateMany({
        where: { id: editRequest.id, status: 'pending' },
        data: { status: 'reviewing', reviewedBy: reviewer.id, updatedAt: now }
      });
      if (claimed.count !== 1) throw new ConflictException('This edit request is no longer pending.');
      if (page.currentRevisionId !== editRequest.baseRevisionId) throw new ConflictException('Base revision does not match current revision.');
      const latest = await this.findLatestRevision(tx, page.id);
      await this.assertLockedSectionsUnchanged({
        actor: reviewerActor,
        page,
        currentContent: latest?.contentRaw ?? '',
        nextContent: editRequest.proposedContent,
        store: tx
      });
      const revision = await this.createRevision(tx, {
        pageId: page.id,
        revisionNo: latest ? latest.revisionNo + 1 : 1,
        parentRevisionId: latest?.id ?? null,
        contentRaw: editRequest.proposedContent,
        editSummary: editRequest.editSummary,
        isMinor: editRequest.isMinor,
        actorId: editRequest.createdBy,
        title: page.displayTitle,
        createdAt: now
      });
      await tx.wikiPage.update({ where: { id: page.id }, data: { currentRevisionId: revision.id, updatedAt: now } });
      await this.insertRecentChange(tx, {
        pageId: page.id, revisionId: revision.id, actorId: editRequest.createdBy, changeType: 'edit',
        title: page.title, namespaceCode: namespace.code, summary: revision.editSummary, isMinor: revision.isMinor, createdAt: now
      });
      const completed = await tx.wikiEditRequest.updateMany({
        where: { id: editRequest.id, status: 'reviewing', reviewedBy: reviewer.id },
        data: { status: 'accepted', acceptedRevisionId: revision.id, reviewNote: input.reviewNote, reviewedAt: now, updatedAt: now }
      });
      if (completed.count !== 1) throw new ConflictException('This edit request is no longer being reviewed.');
      await this.notifications?.notifyEditRequestReviewed(tx, {
        profileId: editRequest.createdBy, pageId: page.id, requestId: editRequest.id,
        reviewerProfileId: reviewer.id, status: 'accepted', title: page.displayTitle
      });
      return {
        mutation: { pageId: page.id.toString(), revisionId: revision.id.toString(), revisionNo: revision.revisionNo, namespace: namespace.code, title: page.title, slug: page.slug },
        request: await tx.wikiEditRequest.findUniqueOrThrow({ where: { id: editRequest.id } })
      };
    });
    await this.events?.audit('wiki.edit', {
      category: 'wiki', actorAccountId: session.userId, actorProfileId: reviewer.id,
      subjectType: 'wiki_page', subjectId: result.mutation.pageId,
      metadata: { namespace: result.mutation.namespace, title: result.mutation.title, revisionId: result.mutation.revisionId, revisionNo: result.mutation.revisionNo, attributionProfileId: result.request.createdBy.toString(), editRequestId: result.request.id.toString() }
    });
    return result;
  }

  async movePage(session: SessionPayload, pageId: string, request: WikiMoveRequest): Promise<WikiMoveResponse> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const nextTitle = this.requiredString(request.title, 'title');
    const nextSlug = slugifyTitle(nextTitle);
    const actor = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const page = await tx.wikiPage.findUnique({ where: { id: parsedPageId } });
      if (!page || page.status === 'deleted') {
        throw new NotFoundException('Wiki page not found.');
      }
      const namespace = await tx.wikiNamespace.findUnique({ where: { id: page.namespaceId } });
      if (!namespace) {
        throw new NotFoundException('Wiki namespace not found.');
      }
      await this.wikiPermissions.assertCanMutatePageAction({
        actor: this.wikiPermissions.actorFromSession(session, actor),
        action: 'move',
        page,
        store: tx
      });
      await this.assertPageIsNotSpaceRoot(tx, page, 'move');
      await this.wikiPermissions.assertCanCreatePage({
        actor: this.wikiPermissions.actorFromSession(session, actor),
        namespaceCode: namespace.code,
        spaceId: page.spaceId,
        title: nextTitle,
        pageType: page.pageType,
        store: tx
      });
      if (nextSlug === page.slug) {
        throw new BadRequestException('The destination title is the same as the current title.');
      }
      await this.assertMoveStaysInSpace(tx, page, nextSlug);
      const conflict = await tx.wikiPage.findUnique({
        where: {
          namespaceId_slug: {
            namespaceId: page.namespaceId,
            slug: nextSlug
          }
        },
        select: { id: true }
      });
      if (conflict) {
        throw new ConflictException('A wiki page already exists at the destination title.');
      }

      const moved = await tx.wikiPage.update({
        where: { id: page.id },
        data: {
          localPath: nextSlug,
          slug: nextSlug,
          title: nextTitle,
          displayTitle: this.cleanOptional(request.displayTitle) ?? nextTitle.split('/').at(-1) ?? nextTitle,
          updatedAt: now
        }
      });
      let redirectPageId: bigint | null = null;
      if (request.leaveRedirect !== false) {
        const redirect = await tx.wikiPage.create({
          data: {
            namespaceId: page.namespaceId,
            spaceId: page.spaceId,
            localPath: page.localPath,
            slug: page.slug,
            title: page.title,
            displayTitle: page.displayTitle,
            pageType: 'redirect',
            protectionLevel: page.protectionLevel,
            status: 'normal',
            createdBy: actor.id,
            createdAt: now,
            updatedAt: now
          }
        });
        const redirectRevision = await this.createRevision(tx, {
          pageId: redirect.id,
          revisionNo: 1,
          parentRevisionId: null,
          contentRaw: this.redirectMarkup(namespace.code, nextTitle),
          editSummary: this.cleanOptional(request.reason) ?? `${page.title} 문서 이동`,
          isMinor: false,
          actorId: actor.id,
          title: redirect.displayTitle,
          createdAt: now
        });
        await tx.wikiPage.update({
          where: { id: redirect.id },
          data: { currentRevisionId: redirectRevision.id }
        });
        redirectPageId = redirect.id;
      }
      await this.insertRecentChange(tx, {
        pageId: moved.id,
        revisionId: moved.currentRevisionId,
        actorId: actor.id,
        changeType: 'move',
        title: moved.title,
        namespaceCode: namespace.code,
        summary: this.cleanOptional(request.reason) ?? `${page.title} -> ${moved.title}`,
        isMinor: false,
        createdAt: now
      });
      const latest = await this.findLatestRevision(tx, moved.id);
      if (!latest) {
        throw new NotFoundException('Public wiki revision not found.');
      }
      return {
        pageId: moved.id.toString(),
        revisionId: latest.id.toString(),
        revisionNo: latest.revisionNo,
        namespace: namespace.code,
        title: moved.title,
        slug: moved.slug,
        previousTitle: page.title,
        redirectPageId: redirectPageId?.toString() ?? null
      };
    });
    await this.events?.audit('wiki.move', {
      category: 'wiki',
      actorAccountId: session.userId,
      actorProfileId: actor.id,
      subjectType: 'wiki_page',
      subjectId: result.pageId,
      metadata: {
        previousTitle: result.previousTitle,
        title: result.title,
        redirectPageId: result.redirectPageId,
        reason: this.cleanOptional(request.reason)
      }
    });
    return result;
  }

  async deletePage(
    session: SessionPayload,
    pageId: string,
    request: WikiStatusMutationRequest
  ): Promise<WikiStatusMutationResponse> {
    return this.setPageStatus(session, pageId, 'deleted', request);
  }

  async restorePage(
    session: SessionPayload,
    pageId: string,
    request: WikiStatusMutationRequest
  ): Promise<WikiStatusMutationResponse> {
    return this.setPageStatus(session, pageId, 'normal', request);
  }

  async revertPage(session: SessionPayload, pageId: string, request: WikiRevertRequest): Promise<WikiMutationResponse> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const sourceRevisionId = this.parseBigIntId(this.requiredString(request.revisionId, 'revisionId'), 'revisionId');
    const actor = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const page = await tx.wikiPage.findUnique({ where: { id: parsedPageId } });
      if (!page || page.status === 'deleted') {
        throw new NotFoundException('Wiki page not found.');
      }
      const namespace = await tx.wikiNamespace.findUnique({ where: { id: page.namespaceId } });
      if (!namespace) {
        throw new NotFoundException('Wiki namespace not found.');
      }
      await this.wikiPermissions.assertCanMutatePageAction({
        actor: this.wikiPermissions.actorFromSession(session, actor),
        action: 'revert',
        page,
        store: tx
      });
      if (request.baseRevisionId && page.currentRevisionId?.toString() !== request.baseRevisionId) {
        throw new ConflictException('Base revision does not match current revision.');
      }
      const [source, latest] = await Promise.all([
        tx.wikiPageRevision.findUnique({ where: { id: sourceRevisionId } }),
        this.findLatestRevision(tx, page.id)
      ]);
      if (!source || source.pageId !== page.id || source.visibility !== 'public') {
        throw new NotFoundException('Revert source revision not found.');
      }
      if (latest?.id === source.id) {
        throw new BadRequestException('The selected revision is already current.');
      }
      await this.assertLockedSectionsUnchanged({
        actor: this.wikiPermissions.actorFromSession(session, actor),
        page,
        currentContent: latest?.contentRaw ?? '',
        nextContent: source.contentRaw,
        store: tx
      });
      const revision = await this.createRevision(tx, {
        pageId: page.id,
        revisionNo: latest ? latest.revisionNo + 1 : 1,
        parentRevisionId: latest?.id ?? null,
        contentRaw: source.contentRaw,
        editSummary: this.cleanOptional(request.reason) ?? `r${source.revisionNo} 판으로 되돌리기`,
        isMinor: false,
        actorId: actor.id,
        title: page.displayTitle,
        createdAt: now
      });
      await tx.wikiPage.update({
        where: { id: page.id },
        data: { currentRevisionId: revision.id, updatedAt: now }
      });
      await this.insertRecentChange(tx, {
        pageId: page.id,
        revisionId: revision.id,
        actorId: actor.id,
        changeType: 'revert',
        title: page.title,
        namespaceCode: namespace.code,
        summary: revision.editSummary,
        isMinor: false,
        createdAt: now
      });
      return {
        pageId: page.id.toString(),
        revisionId: revision.id.toString(),
        revisionNo: revision.revisionNo,
        namespace: namespace.code,
        title: page.title,
        slug: page.slug
      };
    });
    await this.events?.audit('wiki.revert', {
      category: 'wiki',
      actorAccountId: session.userId,
      actorProfileId: actor.id,
      subjectType: 'wiki_page',
      subjectId: result.pageId,
      metadata: {
        sourceRevisionId: sourceRevisionId.toString(),
        revisionId: result.revisionId,
        revisionNo: result.revisionNo,
        reason: this.cleanOptional(request.reason)
      }
    });
    return result;
  }

  private async setPageStatus(
    session: SessionPayload,
    pageId: string,
    status: 'normal' | 'deleted',
    request: WikiStatusMutationRequest
  ): Promise<WikiStatusMutationResponse> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const actor = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const page = await tx.wikiPage.findUnique({ where: { id: parsedPageId } });
      if (!page) {
        throw new NotFoundException('Wiki page not found.');
      }
      if (page.status === status) {
        throw new BadRequestException(`Wiki page is already ${status}.`);
      }
      const permissionActor = this.wikiPermissions.actorFromSession(session, actor);
      if (status === 'deleted') {
        await this.wikiPermissions.assertCanMutatePageAction({
          actor: permissionActor,
          action: 'delete',
          page,
          store: tx
        });
        await this.assertPageIsNotSpaceRoot(tx, page, 'delete');
      } else {
        await this.wikiPermissions.assertCanRestorePage({ actor: permissionActor, page, store: tx });
      }
      const namespace = await tx.wikiNamespace.findUnique({ where: { id: page.namespaceId } });
      if (!namespace) {
        throw new NotFoundException('Wiki namespace not found.');
      }
      const updated = await tx.wikiPage.update({
        where: { id: page.id },
        data: { status, updatedAt: now }
      });
      await this.insertRecentChange(tx, {
        pageId: updated.id,
        revisionId: updated.currentRevisionId,
        actorId: actor.id,
        changeType: status === 'deleted' ? 'delete' : 'restore',
        title: updated.title,
        namespaceCode: namespace.code,
        summary: this.cleanOptional(request.reason) ?? (status === 'deleted' ? '문서 삭제' : '문서 복구'),
        isMinor: false,
        createdAt: now
      });
      return { pageId: updated.id.toString(), status };
    });
    await this.events?.audit(status === 'deleted' ? 'wiki.delete' : 'wiki.restore', {
      category: 'wiki',
      actorAccountId: session.userId,
      actorProfileId: actor.id,
      subjectType: 'wiki_page',
      subjectId: result.pageId,
      metadata: {
        status,
        reason: this.cleanOptional(request.reason)
      }
    });
    return result;
  }

  private async assertPageIsNotSpaceRoot(
    tx: Prisma.TransactionClient,
    page: { readonly id: bigint; readonly spaceId: bigint; readonly slug: string },
    action: 'move' | 'delete'
  ): Promise<void> {
    const [space, serverWiki] = await Promise.all([
      tx.wikiSpace.findUnique({ where: { id: page.spaceId }, select: { rootPageId: true } }),
      tx.serverWiki.findFirst({ where: { spaceId: page.spaceId }, select: { slug: true } })
    ]);
    if (space?.rootPageId === page.id || (serverWiki && slugifyTitle(serverWiki.slug) === page.slug)) {
      throw new ForbiddenException(`A wiki space root page cannot be ${action === 'move' ? 'moved' : 'deleted'}.`);
    }
  }

  private async assertMoveStaysInSpace(
    tx: Prisma.TransactionClient,
    page: { readonly spaceId: bigint },
    nextSlug: string
  ): Promise<void> {
    const serverWiki = await tx.serverWiki.findFirst({
      where: { spaceId: page.spaceId },
      select: { slug: true }
    });
    if (!serverWiki) {
      return;
    }
    const serverSlug = slugifyTitle(serverWiki.slug);
    if (!nextSlug.startsWith(`${serverSlug}/`)) {
      throw new BadRequestException('Server wiki pages must stay under their server path.');
    }
  }

  private redirectMarkup(namespaceCode: string, title: string): string {
    return namespaceCode === 'main'
      ? `#넘겨주기 [[${title}]]`
      : `#넘겨주기 [[${namespaceCode}:${title}]]`;
  }

  async appendSection(session: SessionPayload, pageId: string, request: WikiSectionMutationRequest): Promise<WikiMutationResponse> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const heading = this.requiredString(request.heading, 'heading');
    const sectionContent = this.requiredString(request.contentRaw, 'contentRaw');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: parsedPageId } });
    if (!page) {
      throw new NotFoundException('Wiki page not found.');
    }
    const actor = await this.wikiProfiles.ensureWikiProfile(session.userId);
    await this.wikiPermissions.assertCanEditPage({
      actor: this.wikiPermissions.actorFromSession(session, actor),
      page
    });
    const latest = await this.findLatestRevision(this.prisma, page.id);
    if (!latest) {
      throw new NotFoundException('Public wiki revision not found.');
    }
    const appended = `${latest.contentRaw.trimEnd()}\n\n== ${heading} ==\n${sectionContent.trim()}\n`;
    return this.updatePage(session, pageId, {
      contentRaw: appended,
      editSummary: request.editSummary ?? `섹션 추가: ${heading}`,
      isMinor: request.isMinor,
      baseRevisionId: request.baseRevisionId
    });
  }

  async getRevision(revisionId: string, accountId?: string | null): Promise<WikiRevisionResponse> {
    return this.getRevisionForAction(revisionId, accountId ?? null, 'raw');
  }

  async getRawPage(
    pageId: string,
    accountId?: string | null,
    revisionId?: string | null
  ): Promise<WikiRevisionResponse> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: parsedPageId } });
    if (!page) {
      throw new NotFoundException('Wiki page not found.');
    }
    await this.wikiPermissions.assertCanReadPage({ accountId: accountId ?? null, page });
    await this.wikiPermissions.assertCanUsePageAction({
      accountId: accountId ?? null,
      action: 'raw',
      page
    });
    const revision = revisionId
      ? await this.prisma.wikiPageRevision.findUnique({
          where: { id: this.parseBigIntId(revisionId, 'revisionId') }
        })
      : page.currentRevisionId
        ? await this.prisma.wikiPageRevision.findUnique({ where: { id: page.currentRevisionId } })
        : await this.findLatestRevision(this.prisma, page.id);
    if (!revision || revision.pageId !== page.id || revision.visibility !== 'public') {
      throw new NotFoundException('Wiki revision not found.');
    }
    return this.toRevisionResponse(revision);
  }

  private async getRevisionForAction(
    revisionId: string,
    accountId: string | null,
    action: 'raw' | 'history'
  ): Promise<WikiRevisionResponse> {
    const id = this.parseBigIntId(revisionId, 'revisionId');
    const revision = await this.prisma.wikiPageRevision.findUnique({ where: { id } });
    if (!revision || revision.visibility !== 'public') {
      throw new NotFoundException('Wiki revision not found.');
    }
    const page = await this.prisma.wikiPage.findUnique({ where: { id: revision.pageId } });
    await this.wikiPermissions.assertCanReadPage({
      accountId,
      page,
      revision
    });
    await this.wikiPermissions.assertCanUsePageAction({ accountId, action, page });
    return this.toRevisionResponse(revision);
  }

  async getRevisionDiff(leftId: string, rightId: string, accountId?: string | null): Promise<WikiRevisionDiffResponse> {
    const [left, right] = await Promise.all([
      this.getRevisionForAction(leftId, accountId ?? null, 'history'),
      this.getRevisionForAction(rightId, accountId ?? null, 'history')
    ]);
    return {
      left,
      right,
      hunks: this.diffText(left.contentRaw, right.contentRaw)
    };
  }

  preview(contentRaw: string | undefined): WikiPreviewResponse {
    const parsed = parseMarkup(contentRaw ?? '');
    return {
      html: renderDocument(parsed.ast),
      links: parsed.links,
      categories: parsed.categories,
      errors: parsed.errors,
      blockingErrors: parsed.blockingErrors
    };
  }

  private async assertLockedSectionsUnchanged(input: {
    readonly actor: ReturnType<WikiPermissionService['actorFromSession']>;
    readonly page: {
      readonly id: bigint;
      readonly namespaceId: number;
      readonly spaceId: bigint;
      readonly title: string;
      readonly protectionLevel: string;
      readonly status: string;
      readonly createdBy: bigint | null;
    };
    readonly currentContent: string;
    readonly nextContent: string;
    readonly store: Prisma.TransactionClient;
  }): Promise<void> {
    const locks = await input.store.pageSectionLock.findMany({
      where: { pageId: input.page.id },
      orderBy: [{ id: 'asc' }]
    });
    for (const lock of locks) {
      const allowed = await this.wikiPermissions.canEditSectionLock({
        actor: input.actor,
        page: input.page,
        lock,
        store: input.store
      });
      if (allowed) continue;
      const before = sectionContentsByAnchor(input.currentContent, lock.anchor);
      const after = sectionContentsByAnchor(input.nextContent, lock.anchor);
      if (before.length !== 1 || after.length !== 1 || before[0] !== after[0]) {
        throw new ForbiddenException(`Wiki section is locked: ${lock.heading}`);
      }
    }
  }

  private async findDefaultSpaceId(namespaceCode: string): Promise<bigint> {
    const direct = await this.prisma.wikiSpace.findFirst({
      where: {
        rootNamespaceCode: namespaceCode,
        status: 'active'
      },
      orderBy: [{ id: 'asc' }]
    });
    if (direct) {
      return direct.id;
    }
    const fallback = await this.prisma.wikiSpace.findFirst({
      where: { status: 'active' },
      orderBy: [{ id: 'asc' }]
    });
    if (!fallback) {
      throw new NotFoundException('Wiki space not found.');
    }
    return fallback.id;
  }

  private async findLatestRevision(tx: Pick<PrismaService, 'wikiPageRevision'>, pageId: bigint) {
    return tx.wikiPageRevision.findFirst({
      where: {
        pageId,
        visibility: 'public'
      },
      orderBy: [{ revisionNo: 'desc' }]
    });
  }

  private async createRevision(
    tx: Pick<PrismaService, 'wikiPageRenderCache' | 'wikiPageRevision'>,
    input: {
      pageId: bigint;
      revisionNo: number;
      parentRevisionId: bigint | null;
      contentRaw: string;
      editSummary?: string | null;
      isMinor: boolean;
      actorId: bigint;
      title: string;
      createdAt: Date;
    }
  ) {
    const parsed = parseMarkup(input.contentRaw);
    if (parsed.blockingErrors.length > 0) {
      throw new BadRequestException(`Wiki markup contains blocking errors: ${parsed.blockingErrors.join(', ')}`);
    }
    const revision = await tx.wikiPageRevision.create({
      data: {
        pageId: input.pageId,
        revisionNo: input.revisionNo,
        parentRevisionId: input.parentRevisionId,
        contentRaw: input.contentRaw,
        contentAst: JSON.parse(JSON.stringify(parsed.ast)),
        contentHash: hashContent(input.contentRaw),
        contentSize: Buffer.byteLength(input.contentRaw, 'utf8'),
        syntaxVersion: 'bwm-0.3',
        editSummary: input.editSummary ?? null,
        isMinor: input.isMinor,
        editTags: null,
        createdBy: input.actorId,
        actorType: 'user',
        actorUserId: input.actorId,
        actorIp: null,
        actorIpText: null,
        actorIpHash: null,
        createdAt: input.createdAt,
        visibility: 'public'
      }
    });
    await tx.wikiPageRenderCache.create({
      data: {
        pageId: input.pageId,
        revisionId: revision.id,
        rendererVersion: WIKI_RENDERER_VERSION,
        html: renderDocument(parsed.ast),
        createdAt: input.createdAt
      }
    });
    await this.wikiLinks?.replaceForRevision(tx as Prisma.TransactionClient, input.pageId, revision.id, parsed.links);
    await this.notifications?.notifyWatchedRevision(tx as Prisma.TransactionClient, {
      pageId: input.pageId,
      revisionId: revision.id,
      actorProfileId: input.actorId,
      title: input.title
    });
    return revision;
  }

  private async insertRecentChange(
    tx: Pick<PrismaService, 'wikiRecentChange'>,
    input: {
      pageId: bigint;
      revisionId: bigint | null;
      actorId: bigint;
      changeType: ChangeType;
      title: string;
      namespaceCode: string;
      summary?: string | null;
      isMinor: boolean;
      createdAt: Date;
    }
  ): Promise<void> {
    await tx.wikiRecentChange.create({
      data: {
        pageId: input.pageId,
        revisionId: input.revisionId,
        actorId: input.actorId,
        changeType: input.changeType,
        title: input.title,
        namespaceCode: input.namespaceCode,
        summary: input.summary ?? null,
        isMinor: input.isMinor,
        createdAt: input.createdAt
      }
    });
  }

  private toRevisionResponse(revision: {
    id: bigint;
    pageId: bigint;
    revisionNo: number;
    parentRevisionId: bigint | null;
    contentRaw: string;
    contentHash: string;
    contentSize: number;
    syntaxVersion: string;
    editSummary: string | null;
    isMinor: boolean;
    createdBy: bigint | null;
    actorUserId: bigint | null;
    createdAt: Date;
    visibility: string;
  }): WikiRevisionResponse {
    return {
      id: revision.id.toString(),
      pageId: revision.pageId.toString(),
      revisionNo: revision.revisionNo,
      parentRevisionId: revision.parentRevisionId?.toString() ?? null,
      contentRaw: revision.contentRaw,
      contentHash: revision.contentHash,
      contentSize: revision.contentSize,
      syntaxVersion: revision.syntaxVersion,
      editSummary: revision.editSummary,
      isMinor: revision.isMinor,
      createdBy: revision.createdBy?.toString() ?? null,
      actorUserId: revision.actorUserId?.toString() ?? null,
      createdAt: revision.createdAt.toISOString(),
      visibility: revision.visibility
    };
  }

  diffText(left: string, right: string): WikiRevisionDiffResponse['hunks'] {
    const leftLines = left.split('\n');
    const rightLines = right.split('\n');
    const max = Math.max(leftLines.length, rightLines.length);
    const hunks: WikiRevisionDiffResponse['hunks'] = [];
    for (let index = 0; index < max; index += 1) {
      const leftLine = leftLines[index];
      const rightLine = rightLines[index];
      if (leftLine === rightLine) {
        if (leftLine !== undefined) {
          hunks.push({ type: 'context', line: leftLine, leftLine: index + 1, rightLine: index + 1 });
        }
        continue;
      }
      if (leftLine !== undefined) {
        hunks.push({ type: 'removed', line: leftLine, leftLine: index + 1, rightLine: null });
      }
      if (rightLine !== undefined) {
        hunks.push({ type: 'added', line: rightLine, leftLine: null, rightLine: index + 1 });
      }
    }
    return hunks;
  }

  private cleanNamespace(value?: string): string {
    return this.cleanOptional(value) ?? 'main';
  }

  private cleanOptional(value?: string | null): string | null {
    const cleaned = value?.trim();
    return cleaned ? cleaned : null;
  }

  private requiredString(value: string | undefined, label: string): string {
    const cleaned = this.cleanOptional(value);
    if (!cleaned) {
      throw new BadRequestException(`${label} is required.`);
    }
    return cleaned;
  }

  private parseBigIntId(value: string, label: string): bigint {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException(`${label} must be an unsigned integer.`);
    }
    return BigInt(value);
  }
}

function sectionContentsByAnchor(content: string, anchor: string): string[] {
  const parsed = parseMarkup(content);
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  return parsed.headings
    .filter((heading) => heading.anchor === anchor)
    .map((heading) => lines.slice(heading.startLine - 1, heading.endLine).join('\n'));
}

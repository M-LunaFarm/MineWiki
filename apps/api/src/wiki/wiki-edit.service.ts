import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional
} from '@nestjs/common';
import { hashContent, parseMarkup, renderDocument, slugifyTitle, WIKI_RENDERER_VERSION, type AstNode } from '@minewiki/wiki-core';
import type { Prisma, WikiEditRequest } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import type { SessionPayload } from '../session/session.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiLinkIndexService } from './wiki-link-index.service';
import { WikiNotificationService } from './wiki-notification.service';
import { hasWikiConflictMarkers, mergeWikiSource, WikiMergeLimitError } from './wiki-merge';

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

export interface WikiSectionEditResponse {
  readonly pageId: string;
  readonly anchor: string;
  readonly title: string;
  readonly contentRaw: string;
  readonly baseRevisionId: string;
}

export interface WikiSectionMutationResponse extends WikiMutationResponse {
  readonly sectionAnchor: string;
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
  readonly autoMerged?: boolean;
}

export interface WikiEditConflictDetails {
  readonly type: 'wiki_edit_conflict';
  readonly scope: 'page' | 'section';
  readonly baseRevisionId: string;
  readonly currentRevisionId: string;
  readonly currentRevisionNo: number;
  readonly mergedContentRaw: string;
  readonly conflictCount: number;
}

export interface AuthorizedWikiFileDocumentRequest {
  readonly filename: string;
  readonly linkedPageId: string;
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
    return this.createPageInternal(session, request, false);
  }

  async createFileDocumentAfterAuthorizedUpload(
    session: SessionPayload,
    request: AuthorizedWikiFileDocumentRequest
  ): Promise<WikiMutationResponse> {
    const filename = this.requiredString(request.filename, 'filename');
    if (!/^[a-f0-9-]{16,64}\.(?:png|jpe?g|webp)$/i.test(filename)) {
      throw new BadRequestException('Stored wiki filename is invalid.');
    }
    const linkedPageId = this.parseBigIntId(request.linkedPageId, 'linkedPageId');
    const [actor, linkedPage] = await Promise.all([
      this.wikiProfiles.ensureWikiProfile(session.userId),
      this.prisma.wikiPage.findUnique({ where: { id: linkedPageId } })
    ]);
    const permissionActor = this.wikiPermissions.actorFromSession(session, actor);
    await this.wikiPermissions.assertCanEditPage({ actor: permissionActor, page: linkedPage });
    await this.wikiPermissions.assertCanUsePageAction({
      accountId: session.userId,
      action: 'upload_file',
      page: linkedPage
    });
    return this.createPageInternal(session, {
      namespace: 'file',
      title: filename,
      displayTitle: filename,
      contentRaw: `== 파일 ==\n[[파일:${filename}|섬네일|업로드 파일]]\n\n== 이용 안내 ==\n라이선스와 출처는 이미지 아래에 표시됩니다.\n\n[[분류:파일]]`,
      editSummary: '위키 파일 업로드'
    }, true);
  }

  private async createPageInternal(
    session: SessionPayload,
    request: WikiPageMutationRequest,
    authorizedFileUpload: boolean
  ): Promise<WikiMutationResponse> {
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
    const requestedPageType = this.cleanOptional(request.pageType);
    if (requestedPageType && requestedPageType !== createTarget.pageType) {
      throw new BadRequestException(`Page type must be ${createTarget.pageType} in this wiki space.`);
    }
    const actor = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const slug = slugifyTitle(title);
    const now = new Date();
    if (!authorizedFileUpload) {
      await this.wikiPermissions.assertCanCreatePage({
        actor: this.wikiPermissions.actorFromSession(session, actor),
        namespaceCode,
        spaceId,
        title,
        pageType: createTarget.pageType
      });
    } else if (namespaceCode !== 'file') {
      throw new ForbiddenException('Authorized file uploads can only create file documents.');
    }

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
          pageType: createTarget.pageType,
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
        namespaceCode,
        pageTitle: page.title,
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
      const spaceId = this.parseBigIntId(requestedSpaceId, 'spaceId');
      const space = await this.prisma.wikiSpace.findUnique({
        where: { id: spaceId },
        select: { id: true, status: true, spaceType: true, rootNamespaceCode: true }
      });
      if (!space || space.status !== 'active') {
        throw new NotFoundException('Active wiki space not found.');
      }
      if (space.rootNamespaceCode !== namespaceCode) {
        throw new BadRequestException('Wiki namespace does not belong to the requested space.');
      }
      if (namespaceCode === 'server') {
        if (space.spaceType !== 'server_wiki') {
          throw new BadRequestException('Server pages require a server wiki space.');
        }
        const serverWiki = await this.prisma.serverWiki.findFirst({
          where: { spaceId: space.id, status: { not: 'deleted' } },
          select: { slug: true }
        });
        const normalizedTitle = slugifyTitle(title);
        const serverSlug = serverWiki ? slugifyTitle(serverWiki.slug) : '';
        if (!serverWiki || (normalizedTitle !== serverSlug && !normalizedTitle.startsWith(`${serverSlug}/`))) {
          throw new BadRequestException('Server wiki page path does not belong to this server.');
        }
      } else if (space.spaceType === 'server_wiki') {
        throw new BadRequestException('A server wiki space cannot contain another namespace.');
      }
      return {
        spaceId,
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
        select: { spaceId: true, status: true },
      });
      if (!serverWiki || serverWiki.status === 'deleted') {
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

  async updatePage(
    session: SessionPayload,
    pageId: string,
    request: WikiPageMutationRequest,
    options: {
      readonly attributionProfileId?: bigint;
      readonly conflictScope?: 'page' | 'section';
    } = {}
  ): Promise<WikiMutationResponse> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const requestedBaseRevisionId = this.requiredString(request.baseRevisionId, 'baseRevisionId');
    this.parseBigIntId(requestedBaseRevisionId, 'baseRevisionId');
    const contentRaw = this.requiredString(request.contentRaw, 'contentRaw');
    if (hasWikiConflictMarkers(contentRaw)) {
      throw new BadRequestException('Resolve every wiki edit conflict marker before saving.');
    }
    const actor = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const attributionProfileId = options.attributionProfileId ?? actor.id;
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockPageForRevision(tx, parsedPageId);
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
      await this.wikiPermissions.assertCanUsePageAction({
        accountId: session.userId,
        action: 'raw',
        page,
        store: tx
      });
      const [latest, latestStored] = await Promise.all([
        this.findCurrentRevision(tx, page),
        this.findLatestStoredRevision(tx, page.id)
      ]);
      let nextContentRaw = contentRaw;
      let autoMerged = false;
      if (latest?.id.toString() !== requestedBaseRevisionId) {
        const baseRevisionId = this.parseBigIntId(requestedBaseRevisionId, 'baseRevisionId');
        const base = await tx.wikiPageRevision.findUnique({ where: { id: baseRevisionId } });
        if (!base || base.pageId !== page.id || base.visibility !== 'public' || !latest) {
          throw new ConflictException('Base revision does not match current revision.');
        }
        let merged;
        try {
          merged = mergeWikiSource(contentRaw, base.contentRaw, latest.contentRaw);
        } catch (error) {
          if (error instanceof WikiMergeLimitError) {
            throw new ConflictException('The document is too large to merge automatically. Reload the latest revision and retry.');
          }
          throw error;
        }
        if (merged.hasConflicts) {
          const details: WikiEditConflictDetails = {
            type: 'wiki_edit_conflict',
            scope: options.conflictScope ?? 'page',
            baseRevisionId: base.id.toString(),
            currentRevisionId: latest.id.toString(),
            currentRevisionNo: latest.revisionNo,
            mergedContentRaw: merged.contentRaw,
            conflictCount: merged.conflictCount
          };
          throw new ConflictException({
            code: 'wiki_edit_conflict',
            message: 'The document changed and overlapping edits require manual resolution.',
            details
          });
        }
        nextContentRaw = merged.contentRaw;
        autoMerged = true;
      }
      await this.assertLockedSectionsUnchanged({
        actor: this.wikiPermissions.actorFromSession(session, actor),
        page,
        currentContent: latest?.contentRaw ?? '',
        nextContent: nextContentRaw,
        store: tx
      });
      const revision = await this.createRevision(tx, {
        pageId: page.id,
        revisionNo: latestStored ? latestStored.revisionNo + 1 : 1,
        parentRevisionId: latest?.id ?? null,
        contentRaw: nextContentRaw,
        editSummary: this.cleanOptional(request.editSummary),
        isMinor: Boolean(request.isMinor),
        actorId: attributionProfileId,
        title: page.displayTitle,
        namespaceCode: namespace.code,
        pageTitle: page.title,
        createdAt: now,
        editTags: autoMerged
          ? {
              autoMerged: true,
              baseRevisionId: requestedBaseRevisionId,
              currentRevisionId: latest?.id.toString() ?? null
            }
          : null
      });
      const claimed = await tx.wikiPage.updateMany({
        where: {
          id: page.id,
          currentRevisionId: latest?.id ?? null
        },
        data: {
          currentRevisionId: revision.id,
          updatedAt: now
        }
      });
      if (claimed.count !== 1) {
        throw new ConflictException('The document changed while this revision was being saved.');
      }
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
        slug: page.slug,
        autoMerged
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
        revisionNo: result.revisionNo,
        autoMerged: Boolean(result.autoMerged),
        baseRevisionId: requestedBaseRevisionId
      }
    });
    return result;
  }

  async acceptEditRequest(session: SessionPayload, input: { readonly requestId: bigint; readonly reviewNote: string | null }): Promise<{ readonly mutation: WikiMutationResponse; readonly request: WikiEditRequest }> {
    const reviewer = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const initialRequest = await tx.wikiEditRequest.findUnique({ where: { id: input.requestId } });
      if (!initialRequest) throw new NotFoundException('Wiki edit request not found.');
      await this.lockPageForRevision(tx, initialRequest.pageId);
      const editRequest = await tx.wikiEditRequest.findUnique({ where: { id: input.requestId } });
      if (!editRequest || editRequest.pageId !== initialRequest.pageId) {
        throw new NotFoundException('Wiki edit request not found.');
      }
      const page = await tx.wikiPage.findUnique({ where: { id: editRequest.pageId } });
      if (!page || page.status === 'deleted') throw new NotFoundException('Wiki page not found.');
      const namespace = await tx.wikiNamespace.findUnique({ where: { id: page.namespaceId } });
      if (!namespace) throw new NotFoundException('Wiki namespace not found.');
      const reviewerActor = this.wikiPermissions.actorFromSession(session, reviewer);
      if (!(await this.wikiPermissions.canManagePage({ actor: reviewerActor, page, store: tx }))) {
        throw new ForbiddenException('Edit request review is not allowed.');
      }
      const claimed = await tx.wikiEditRequest.updateMany({
        where: {
          id: editRequest.id,
          status: 'pending',
          baseRevisionId: editRequest.baseRevisionId,
          proposedContent: editRequest.proposedContent,
          editSummary: editRequest.editSummary,
          isMinor: editRequest.isMinor,
          updatedAt: editRequest.updatedAt
        },
        data: { status: 'reviewing', reviewedBy: reviewer.id, updatedAt: now }
      });
      if (claimed.count !== 1) throw new ConflictException('This edit request is no longer pending.');
      if (page.currentRevisionId !== editRequest.baseRevisionId) {
        throw new ConflictException({
          code: 'wiki_edit_base_stale',
          message: 'Base revision does not match current revision.'
        });
      }
      const [latest, latestStored] = await Promise.all([
        this.findCurrentRevision(tx, page),
        this.findLatestStoredRevision(tx, page.id)
      ]);
      await this.assertLockedSectionsUnchanged({
        actor: reviewerActor,
        page,
        currentContent: latest?.contentRaw ?? '',
        nextContent: editRequest.proposedContent,
        store: tx
      });
      const revision = await this.createRevision(tx, {
        pageId: page.id,
        revisionNo: latestStored ? latestStored.revisionNo + 1 : 1,
        parentRevisionId: latest?.id ?? null,
        contentRaw: editRequest.proposedContent,
        editSummary: editRequest.editSummary,
        isMinor: editRequest.isMinor,
        actorId: editRequest.createdBy,
        title: page.displayTitle,
        namespaceCode: namespace.code,
        pageTitle: page.title,
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
      await this.lockPageForRevision(tx, parsedPageId);
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
      if (nextSlug.startsWith(`${page.slug}/`)) {
        throw new BadRequestException('A wiki page tree cannot be moved inside itself.');
      }
      await this.assertMoveStaysInSpace(tx, page, nextSlug);
      const subtree = await tx.wikiPage.findMany({
        where: {
          namespaceId: page.namespaceId,
          spaceId: page.spaceId,
          status: { not: 'deleted' },
          pageType: { not: 'redirect' },
          OR: [{ id: page.id }, { localPath: { startsWith: `${page.localPath}/` } }]
        }
      });
      const permissionActor = this.wikiPermissions.actorFromSession(session, actor);
      const moves = subtree.map((item) => {
        const suffix = item.localPath === page.localPath ? '' : item.localPath.slice(page.localPath.length);
        return { source: item, slug: `${nextSlug}${suffix}` };
      });
      for (const move of moves) {
        if (move.source.id === page.id) continue;
        await this.wikiPermissions.assertCanMutatePageAction({ actor: permissionActor, action: 'move', page: move.source, store: tx });
        await this.wikiPermissions.assertCanCreatePage({
          actor: permissionActor, namespaceCode: namespace.code, spaceId: page.spaceId,
          title: move.slug, pageType: move.source.pageType, store: tx
        });
      }
      const conflicts = await tx.wikiPage.findMany({
        where: {
          namespaceId: page.namespaceId,
          slug: { in: moves.map((move) => move.slug) },
          id: { notIn: moves.map((move) => move.source.id) }
        },
        select: { id: true }
      });
      if (conflicts.length > 0) {
        throw new ConflictException('A wiki page already exists at the destination title.');
      }

      let moved = page;
      for (const move of [...moves].sort((left, right) => right.source.localPath.length - left.source.localPath.length)) {
        const updated = await tx.wikiPage.update({
          where: { id: move.source.id },
          data: {
            localPath: move.slug,
            slug: move.slug,
            title: move.source.id === page.id ? nextTitle : move.slug,
            displayTitle: move.source.id === page.id
              ? this.cleanOptional(request.displayTitle) ?? nextTitle.split('/').at(-1) ?? nextTitle
              : move.source.displayTitle,
            updatedAt: now
          }
        });
        if (move.source.id === page.id) moved = updated;
      }
      let redirectPageId: bigint | null = null;
      if (request.leaveRedirect !== false) for (const move of moves) {
        const redirect = await tx.wikiPage.create({
          data: {
            namespaceId: move.source.namespaceId,
            spaceId: move.source.spaceId,
            localPath: move.source.localPath,
            slug: move.source.slug,
            title: move.source.title,
            displayTitle: move.source.displayTitle,
            pageType: 'redirect',
            protectionLevel: move.source.protectionLevel,
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
          contentRaw: this.redirectMarkup(namespace.code, move.source.id === page.id ? nextTitle : move.slug),
          editSummary: this.cleanOptional(request.reason) ?? `${move.source.title} 문서 이동`,
          isMinor: false,
          actorId: actor.id,
          title: redirect.displayTitle,
          namespaceCode: namespace.code,
          pageTitle: redirect.title,
          createdAt: now
        });
        await tx.wikiPage.update({
          where: { id: redirect.id },
          data: { currentRevisionId: redirectRevision.id }
        });
        if (move.source.id === page.id) redirectPageId = redirect.id;
      }
      for (const move of moves) {
        const targetTitle = move.source.id === page.id ? nextTitle : move.slug;
        await this.insertRecentChange(tx, {
          pageId: move.source.id, revisionId: move.source.currentRevisionId, actorId: actor.id,
          changeType: 'move', title: targetTitle, namespaceCode: namespace.code,
          summary: this.cleanOptional(request.reason) ?? `${move.source.title} -> ${targetTitle}`,
          isMinor: false, createdAt: now
        });
      }
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
      await this.lockPageForRevision(tx, parsedPageId);
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
      const [source, latest, latestStored] = await Promise.all([
        tx.wikiPageRevision.findUnique({ where: { id: sourceRevisionId } }),
        this.findCurrentRevision(tx, page),
        this.findLatestStoredRevision(tx, page.id)
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
        revisionNo: latestStored ? latestStored.revisionNo + 1 : 1,
        parentRevisionId: latest?.id ?? null,
        contentRaw: source.contentRaw,
        editSummary: this.cleanOptional(request.reason) ?? `r${source.revisionNo} 판으로 되돌리기`,
        isMinor: false,
        actorId: actor.id,
        title: page.displayTitle,
        namespaceCode: namespace.code,
        pageTitle: page.title,
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
        const descendants = await tx.wikiPage.count({
          where: {
            namespaceId: page.namespaceId,
            spaceId: page.spaceId,
            status: { not: 'deleted' },
            localPath: { startsWith: `${page.localPath}/` }
          }
        });
        if (descendants > 0) {
          throw new ConflictException('A wiki page with child documents cannot be deleted. Move or delete its children first.');
        }
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

  async getSectionForEdit(
    session: SessionPayload,
    pageId: string,
    anchor: string
  ): Promise<WikiSectionEditResponse> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const normalizedAnchor = this.requiredString(anchor, 'anchor');
    if (normalizedAnchor.length > 255) throw new BadRequestException('anchor is too long.');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: parsedPageId } });
    if (!page || page.status === 'deleted') throw new NotFoundException('Wiki page not found.');
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    await this.wikiPermissions.assertCanReadPage({ accountId: session.userId, page });
    await this.wikiPermissions.assertCanUsePageAction({ accountId: session.userId, action: 'raw', page });
    await this.wikiPermissions.assertCanEditPage({
      actor: this.wikiPermissions.actorFromSession(session, profile),
      page
    });
    const revision = page.currentRevisionId
      ? await this.prisma.wikiPageRevision.findFirst({
          where: { id: page.currentRevisionId, pageId: page.id, visibility: 'public' }
        })
      : null;
    if (!revision) throw new NotFoundException('Public wiki revision not found.');
    const section = sectionByAnchor(revision.contentRaw, normalizedAnchor);
    if (!section) throw new NotFoundException('Wiki section not found.');
    return {
      pageId: page.id.toString(),
      anchor: section.anchor,
      title: section.title,
      contentRaw: section.contentRaw,
      baseRevisionId: revision.id.toString()
    };
  }

  async updateSection(
    session: SessionPayload,
    pageId: string,
    anchor: string,
    request: WikiPageMutationRequest
  ): Promise<WikiSectionMutationResponse> {
    const baseRevisionId = this.requiredString(request.baseRevisionId, 'baseRevisionId');
    const parsedBaseRevisionId = this.parseBigIntId(baseRevisionId, 'baseRevisionId');
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: parsedPageId } });
    if (!page || page.status === 'deleted') throw new NotFoundException('Wiki page not found.');
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    await this.wikiPermissions.assertCanReadPage({ accountId: session.userId, page });
    await this.wikiPermissions.assertCanUsePageAction({ accountId: session.userId, action: 'raw', page });
    await this.wikiPermissions.assertCanEditPage({
      actor: this.wikiPermissions.actorFromSession(session, profile),
      page
    });
    const baseRevision = await this.prisma.wikiPageRevision.findUnique({
      where: { id: parsedBaseRevisionId }
    });
    if (!baseRevision || baseRevision.pageId !== parsedPageId || baseRevision.visibility !== 'public') {
      throw new ConflictException('Base revision does not match this document.');
    }
    const baseSection = sectionByAnchor(baseRevision.contentRaw, anchor);
    if (!baseSection) {
      throw new ConflictException('Wiki section changed. Reload and try again.');
    }
    const replacement = request.contentRaw?.replace(/\r\n/g, '\n');
    if (!replacement?.trim()) throw new BadRequestException('contentRaw is required.');
    const replacementParsed = parseMarkup(replacement);
    const nextHeading = replacementParsed.headings.find((heading) => heading.startLine === 1);
    if (!nextHeading) {
      throw new BadRequestException('Section content must begin with a wiki heading.');
    }
    const fullContent = replaceSectionByAnchor(
      baseRevision.contentRaw,
      baseSection.anchor,
      replacement
    );
    if (fullContent === null) throw new ConflictException('Wiki section changed. Reload and try again.');
    const mutation = await this.updatePage(
      session,
      pageId,
      {
        contentRaw: fullContent,
        editSummary: request.editSummary ?? `섹션 편집: ${baseSection.title}`,
        isMinor: request.isMinor,
        baseRevisionId
      },
      { conflictScope: 'section' }
    );
    return { ...mutation, sectionAnchor: nextHeading.anchor };
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
    throw new NotFoundException('Active wiki space for namespace not found.');
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

  private async findCurrentRevision(
    tx: Pick<PrismaService, 'wikiPageRevision'>,
    page: { readonly id: bigint; readonly currentRevisionId: bigint | null }
  ) {
    if (!page.currentRevisionId) return null;
    const revision = await tx.wikiPageRevision.findUnique({ where: { id: page.currentRevisionId } });
    return revision?.pageId === page.id && revision.visibility === 'public' ? revision : null;
  }

  private async findLatestStoredRevision(tx: Pick<PrismaService, 'wikiPageRevision'>, pageId: bigint) {
    return tx.wikiPageRevision.findFirst({
      where: { pageId },
      orderBy: [{ revisionNo: 'desc' }]
    });
  }

  private async lockPageForRevision(
    tx: Prisma.TransactionClient,
    pageId: bigint
  ): Promise<void> {
    await tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id
      FROM pages
      WHERE id = ${pageId}
      FOR UPDATE
    `;
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
      namespaceCode: string;
      pageTitle: string;
      createdAt: Date;
      editTags?: Prisma.InputJsonValue | null;
    }
  ) {
    const parsed = parseMarkup(input.contentRaw);
    if (parsed.blockingErrors.length > 0) {
      throw new BadRequestException(`Wiki markup contains blocking errors: ${parsed.blockingErrors.join(', ')}`);
    }
    if (categoryDocumentReferencesSelf(input.namespaceCode, input.pageTitle, parsed.categories)) {
      throw new BadRequestException('A category document cannot list itself as a parent category.');
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
        editTags: input.editTags ?? null,
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
    if (!astContainsFile(parsed.ast) && parsed.includes.length === 0) {
      await tx.wikiPageRenderCache.create({
        data: {
          pageId: input.pageId,
          revisionId: revision.id,
          rendererVersion: WIKI_RENDERER_VERSION,
          html: renderDocument(parsed.ast),
          createdAt: input.createdAt
        }
      });
    }
    await this.wikiLinks?.replaceForRevision(
      tx as Prisma.TransactionClient,
      input.pageId,
      revision.id,
      parsed.links,
      parsed.categories,
      parsed.includes,
      { contentSize: revision.contentSize, contentRaw: revision.contentRaw }
    );
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

export function astContainsFile(ast: readonly AstNode[]): boolean {
  return ast.some((node) => node.type === 'file' || (node.type === 'folding' && astContainsFile(node.children)));
}

export function categoryDocumentReferencesSelf(
  namespaceCode: string,
  pageTitle: string,
  categories: readonly string[]
): boolean {
  if (namespaceCode !== 'category') return false;
  const pageSlug = slugifyTitle(pageTitle);
  return categories.some((category) => slugifyTitle(category) === pageSlug);
}

function sectionContentsByAnchor(content: string, anchor: string): string[] {
  const parsed = parseMarkup(content);
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  return parsed.headings
    .filter((heading) => heading.anchor === anchor)
    .map((heading) => lines.slice(heading.startLine - 1, heading.endLine).join('\n'));
}

export function sectionByAnchor(content: string, anchor: string): {
  anchor: string;
  title: string;
  contentRaw: string;
  startLine: number;
  endLine: number;
} | null {
  const normalized = content.replace(/\r\n/g, '\n');
  const parsed = parseMarkup(normalized);
  const matches = parsed.headings.filter((heading) => heading.anchor === anchor);
  if (matches.length !== 1) return null;
  const heading = matches[0]!;
  const lines = normalized.split('\n');
  return {
    anchor: heading.anchor,
    title: heading.title,
    contentRaw: lines.slice(heading.startLine - 1, heading.endLine).join('\n'),
    startLine: heading.startLine,
    endLine: heading.endLine
  };
}

export function replaceSectionByAnchor(content: string, anchor: string, replacement: string): string | null {
  const normalized = content.replace(/\r\n/g, '\n');
  const section = sectionByAnchor(normalized, anchor);
  if (!section) return null;
  const lines = normalized.split('\n');
  lines.splice(
    section.startLine - 1,
    section.endLine - section.startLine + 1,
    ...replacement.replace(/\r\n/g, '\n').split('\n')
  );
  return lines.join('\n');
}

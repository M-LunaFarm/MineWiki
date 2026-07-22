import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional
} from '@nestjs/common';
import { collectWikiFileNames, hashContent, parseMarkup, renderDocument, slugifyTitle, WIKI_RENDERER_VERSION, type AstNode, type InlineNode } from '@minewiki/wiki-core';
import type { Prisma, WikiEditRequest } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import type { SessionPayload } from '../session/session.service';
import {
  WikiPermissionService,
  type WikiPublishedPageBoundary,
  type WikiPublishedRevisionProof,
} from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiLinkIndexService } from './wiki-link-index.service';
import { WikiNotificationService } from './wiki-notification.service';
import { WikiIncludeService } from './wiki-include.service';
import { wikiLinkResolutionContext } from './wiki-link-context';
import { publicWikiRevisionEditSummary } from './wiki-revision-summary';
import { hasWikiConflictMarkers, mergeWikiSource, WikiMergeLimitError } from './wiki-merge';
import {
  WikiContributionPolicyService,
  type WikiPolicyAcceptance,
} from './wiki-contribution-policy.service';
import {
  resolveWikiAccessContext,
  type WikiAccessContext,
  type WikiAccessViewer,
} from './wiki-read.service';
import { matchCommonLines } from './wiki-line-diff';

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
  readonly policyAcceptance?: WikiPolicyAcceptance;
}

export interface WikiSectionMutationRequest {
  readonly heading?: string;
  readonly contentRaw?: string;
  readonly editSummary?: string;
  readonly isMinor?: boolean;
  readonly baseRevisionId?: string;
  readonly policyAcceptance?: WikiPolicyAcceptance;
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
  readonly namespace?: string;
  readonly spaceId?: string;
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
  readonly revisionId?: string;
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

export interface ResolvedWikiCreateTarget {
  readonly namespaceId: number;
  readonly namespaceCode: string;
  readonly spaceId: bigint;
  readonly title: string;
  readonly slug: string;
  readonly displayTitle: string;
  readonly pageType: string;
  readonly ownerProfileId: bigint | null;
}

export interface WikiCreateContextResponse {
  readonly namespace: string;
  readonly namespaceId: number;
  readonly spaceId: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly pageType: string;
  readonly canCreate: boolean;
  readonly canRequest: boolean;
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

export function isUserDocumentRoot(page: {
  readonly ownerProfileId?: bigint | null;
  readonly localPath: string;
}): boolean {
  return page.ownerProfileId !== null
    && page.ownerProfileId !== undefined
    && !page.localPath.includes('/');
}

export function userDocumentTreeHasSingleOwner(
  ownerProfileId: bigint | null | undefined,
  destinationOwnerProfileId: bigint | null | undefined,
  subtree: ReadonlyArray<{ readonly ownerProfileId?: bigint | null }>
): boolean {
  return ownerProfileId !== null
    && ownerProfileId !== undefined
    && destinationOwnerProfileId === ownerProfileId
    && subtree.every((page) => page.ownerProfileId === ownerProfileId);
}

export interface AuthorizedWikiFileDocumentRequest {
  readonly filename: string;
  readonly linkedPageId?: string;
  readonly linkedSpaceId?: string;
}

export interface AuthorizedWikiFileReplacementRequest {
  readonly filename: string;
  readonly expectedFileId: string;
  readonly uploadedFileId: string;
}

export interface WikiMoveResponse extends WikiMutationResponse {
  readonly previousTitle: string;
  readonly previousNamespace: string;
  readonly previousSpaceId: string;
  readonly spaceId: string;
  readonly movedPageCount: number;
  readonly redirectPageId: string | null;
}

export interface WikiStatusMutationResponse {
  readonly pageId: string;
  readonly status: 'normal' | 'deleted';
  readonly revisionId?: string;
  readonly sourceRevisionId?: string | null;
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
  readonly editSummaryHidden: boolean;
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

export interface WikiPreviewContext {
  readonly pageId?: string;
  readonly namespace?: string;
  readonly localPath?: string;
}

@Injectable()
export class WikiEditService {
  private readonly contributionPolicies: WikiContributionPolicyService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiProfiles: WikiProfileService,
    private readonly wikiPermissions: WikiPermissionService,
    @Optional() private readonly events?: BusinessEventService,
    @Optional() private readonly wikiLinks?: WikiLinkIndexService,
    @Optional() private readonly notifications?: WikiNotificationService,
    @Optional() contributionPolicies?: WikiContributionPolicyService,
    @Optional() private readonly wikiIncludes?: WikiIncludeService,
  ) {
    this.contributionPolicies = contributionPolicies
      ?? new WikiContributionPolicyService(prisma);
  }

  async createPage(
    session: SessionPayload,
    request: WikiPageMutationRequest,
    options: { readonly allowedSpaceId?: bigint } = {}
  ): Promise<WikiMutationResponse> {
    return this.createPageInternal(session, request, false, options.allowedSpaceId);
  }

  async createFileDocumentAfterAuthorizedUpload(
    session: SessionPayload,
    request: AuthorizedWikiFileDocumentRequest
  ): Promise<WikiMutationResponse> {
    const filename = this.requiredString(request.filename, 'filename');
    const hasForbiddenCharacter = Array.from(filename).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 || /\p{Cf}/u.test(character) || '<>:"|?*\\/[]'.includes(character);
    });
    if (filename.length > 255 || hasForbiddenCharacter) {
      throw new BadRequestException('Wiki filename is invalid.');
    }
    const linkedPageId = request.linkedPageId
      ? this.parseBigIntId(request.linkedPageId, 'linkedPageId')
      : null;
    const linkedSpaceId = request.linkedSpaceId
      ? this.parseBigIntId(request.linkedSpaceId, 'linkedSpaceId')
      : null;
    if ((linkedPageId === null) === (linkedSpaceId === null)) {
      throw new BadRequestException('Exactly one linked wiki page or space is required.');
    }
    const actor = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const permissionActor = this.wikiPermissions.actorFromSession(session, actor);
    const permissionPage = linkedPageId !== null
      ? await this.prisma.wikiPage.findUnique({ where: { id: linkedPageId } })
      : await this.buildWikiSpacePermissionPage(linkedSpaceId!);
    await this.wikiPermissions.assertCanEditPage({ actor: permissionActor, page: permissionPage });
    await this.wikiPermissions.assertCanUsePageAction({
      accountId: session.userId,
      action: 'upload_file',
      page: permissionPage
    });
    return this.createPageInternal(session, {
      namespace: 'file',
      title: filename,
      displayTitle: filename,
      contentRaw: `== 파일 ==\n[[파일:${filename}|섬네일|업로드 파일]]\n\n== 이용 안내 ==\n라이선스와 출처는 이미지 아래에 표시됩니다.\n\n[[분류:파일]]`,
      editSummary: '위키 파일 업로드'
    }, true);
  }

  async replaceFileDocumentAfterAuthorizedUpload(
    session: SessionPayload,
    request: AuthorizedWikiFileReplacementRequest,
  ): Promise<WikiMutationResponse> {
    const filename = this.requiredString(request.filename, 'filename');
    const actor = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const namespace = await tx.wikiNamespace.findUnique({ where: { code: 'file' } });
      if (!namespace) throw new NotFoundException('File namespace not found.');
      const page = await tx.wikiPage.findFirst({
        where: { namespaceId: namespace.id, title: filename, status: 'normal' },
      });
      if (!page) throw new NotFoundException('Wiki file document not found.');
      await this.lockPageForRevision(tx, page.id);
      await this.wikiPermissions.assertCanEditPage({
        actor: this.wikiPermissions.actorFromSession(session, actor),
        page,
        store: tx,
      });
      await this.wikiPermissions.assertCanUsePageAction({
        accountId: session.userId,
        action: 'upload_file',
        page,
        store: tx,
      });
      const [latest, latestStored, currentVersion, pendingFile] = await Promise.all([
        this.findCurrentRevision(tx, page),
        this.findLatestStoredRevision(tx, page.id),
        tx.wikiFileVersion.findFirst({ where: { filePageId: page.id, isCurrent: true } }),
        tx.uploadedFile.findUnique({ where: { id: request.uploadedFileId } }),
      ]);
      if (!latest || !latestStored || !currentVersion) {
        throw new ConflictException('The current wiki file version is incomplete.');
      }
      if (currentVersion.uploadedFileId !== request.expectedFileId) {
        throw new ConflictException('The file changed before this replacement was saved.');
      }
      if (
        !pendingFile
        || pendingFile.status !== 'pending'
        || pendingFile.wikiFilename !== filename
        || pendingFile.usageContext !== 'wiki_editor'
      ) {
        throw new ConflictException('The replacement upload is not pending for this file.');
      }
      const revision = await this.createRevision(tx, {
        pageId: page.id,
        revisionNo: latestStored.revisionNo + 1,
        parentRevisionId: latest.id,
        contentRaw: latest.contentRaw,
        editSummary: `파일 버전 ${currentVersion.versionNo + 1} 업로드`,
        isMinor: false,
        actorId: actor.id,
        title: page.displayTitle,
        namespaceCode: namespace.code,
        pageTitle: page.title,
        pageLocalPath: page.localPath,
        createdAt: now,
        editTags: { fileVersion: true, uploadedFileId: pendingFile.id },
      });
      const claimed = await tx.wikiPage.updateMany({
        where: { id: page.id, currentRevisionId: latest.id },
        data: { currentRevisionId: revision.id, updatedAt: now },
      });
      if (claimed.count !== 1) {
        throw new ConflictException('The file document changed while replacing its asset.');
      }
      await tx.wikiFileVersion.updateMany({
        where: { filePageId: page.id, isCurrent: true },
        data: { isCurrent: false },
      });
      await tx.uploadedFile.update({
        where: { id: currentVersion.uploadedFileId },
        data: { status: 'versioned', currentWikiFilename: null, deletedAt: null, retainedUntil: null },
      });
      await tx.wikiFileVersion.create({
        data: {
          filePageId: page.id,
          pageRevisionId: revision.id,
          uploadedFileId: pendingFile.id,
          versionNo: currentVersion.versionNo + 1,
          isCurrent: true,
          createdByAccountId: session.userId,
          createdAt: now,
        },
      });
      await tx.uploadedFile.update({
        where: { id: pendingFile.id },
        data: { status: 'active', currentWikiFilename: filename },
      });
      await this.insertRecentChange(tx, {
        pageId: page.id,
        revisionId: revision.id,
        spaceId: page.spaceId,
        localPath: page.localPath,
        actorId: actor.id,
        changeType: 'edit',
        title: page.title,
        namespaceCode: namespace.code,
        summary: revision.editSummary,
        isMinor: false,
        createdAt: now,
      });
      return {
        pageId: page.id.toString(),
        revisionId: revision.id.toString(),
        revisionNo: revision.revisionNo,
        namespace: namespace.code,
        title: page.title,
        slug: page.slug,
      };
    }, { isolationLevel: 'Serializable' });
    await this.events?.audit('wiki.file_version.replace', {
      category: 'wiki',
      actorAccountId: session.userId,
      actorProfileId: actor.id,
      subjectType: 'wiki_page',
      subjectId: result.pageId,
      metadata: { revisionId: result.revisionId, uploadedFileId: request.uploadedFileId },
    });
    return result;
  }

  async restoreFileVersion(
    session: SessionPayload,
    versionId: bigint,
    expectedCurrentVersionNo: number,
  ): Promise<WikiMutationResponse> {
    const actor = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const targetSnapshot = await tx.wikiFileVersion.findUnique({ where: { id: versionId } });
      if (!targetSnapshot) throw new NotFoundException('Wiki file version not found.');
      await this.lockPageForRevision(tx, targetSnapshot.filePageId);
      const [target, page] = await Promise.all([
        tx.wikiFileVersion.findUnique({
          where: { id: versionId },
          include: { uploadedFile: true },
        }),
        tx.wikiPage.findUnique({ where: { id: targetSnapshot.filePageId } }),
      ]);
      if (!target || !page || page.status !== 'normal') {
        throw new NotFoundException('Wiki file version not found.');
      }
      await this.wikiPermissions.assertCanEditPage({
        actor: this.wikiPermissions.actorFromSession(session, actor),
        page,
        store: tx,
      });
      await this.wikiPermissions.assertCanUsePageAction({
        accountId: session.userId,
        action: 'upload_file',
        page,
        store: tx,
      });
      const [namespace, latest, latestStored, currentVersion] = await Promise.all([
        tx.wikiNamespace.findUnique({ where: { id: page.namespaceId } }),
        this.findCurrentRevision(tx, page),
        this.findLatestStoredRevision(tx, page.id),
        tx.wikiFileVersion.findFirst({ where: { filePageId: page.id, isCurrent: true } }),
      ]);
      if (!namespace || namespace.code !== 'file' || !latest || !latestStored || !currentVersion) {
        throw new ConflictException('The current wiki file version is incomplete.');
      }
      if (currentVersion.versionNo !== expectedCurrentVersionNo) {
        throw new ConflictException('The file version changed. Reload the version history.');
      }
      if (target.isCurrent || target.uploadedFileId === currentVersion.uploadedFileId) {
        throw new BadRequestException('That file asset is already current.');
      }
      if (!['active', 'versioned', 'retained'].includes(target.uploadedFile.status)) {
        throw new ConflictException('The selected file asset is no longer recoverable.');
      }
      const nextVersionNo = currentVersion.versionNo + 1;
      const revision = await this.createRevision(tx, {
        pageId: page.id,
        revisionNo: latestStored.revisionNo + 1,
        parentRevisionId: latest.id,
        contentRaw: latest.contentRaw,
        editSummary: `파일 버전 ${target.versionNo} 복원`,
        isMinor: false,
        actorId: actor.id,
        title: page.displayTitle,
        namespaceCode: namespace.code,
        pageTitle: page.title,
        pageLocalPath: page.localPath,
        createdAt: now,
        editTags: { fileVersionRestore: true, sourceVersionNo: target.versionNo },
      });
      const claimed = await tx.wikiPage.updateMany({
        where: { id: page.id, currentRevisionId: latest.id },
        data: { currentRevisionId: revision.id, updatedAt: now },
      });
      if (claimed.count !== 1) {
        throw new ConflictException('The file document changed while restoring its asset.');
      }
      await tx.wikiFileVersion.updateMany({
        where: { filePageId: page.id, isCurrent: true },
        data: { isCurrent: false },
      });
      await tx.uploadedFile.update({
        where: { id: currentVersion.uploadedFileId },
        data: { status: 'versioned', currentWikiFilename: null, deletedAt: null, retainedUntil: null },
      });
      await tx.wikiFileVersion.create({
        data: {
          filePageId: page.id,
          pageRevisionId: revision.id,
          uploadedFileId: target.uploadedFileId,
          versionNo: nextVersionNo,
          isCurrent: true,
          createdByAccountId: session.userId,
          createdAt: now,
        },
      });
      await tx.uploadedFile.update({
        where: { id: target.uploadedFileId },
        data: {
          status: 'active',
          currentWikiFilename: target.uploadedFile.wikiFilename,
          deletedAt: null,
          retainedUntil: null,
        },
      });
      await this.insertRecentChange(tx, {
        pageId: page.id,
        revisionId: revision.id,
        spaceId: page.spaceId,
        localPath: page.localPath,
        actorId: actor.id,
        changeType: 'revert',
        title: page.title,
        namespaceCode: namespace.code,
        summary: revision.editSummary,
        isMinor: false,
        createdAt: now,
      });
      return {
        pageId: page.id.toString(),
        revisionId: revision.id.toString(),
        revisionNo: revision.revisionNo,
        namespace: namespace.code,
        title: page.title,
        slug: page.slug,
      };
    }, { isolationLevel: 'Serializable' });
    await this.events?.audit('wiki.file_version.restore', {
      category: 'wiki',
      actorAccountId: session.userId,
      actorProfileId: actor.id,
      subjectType: 'wiki_page',
      subjectId: result.pageId,
      metadata: { sourceVersionId: versionId.toString(), revisionId: result.revisionId },
    });
    return result;
  }

  async deleteFileDocumentAfterAuthorizedUpload(
    session: SessionPayload,
    filename: string
  ): Promise<void> {
    const namespace = await this.prisma.wikiNamespace.findUnique({ where: { code: 'file' } });
    if (!namespace) return;
    const page = await this.prisma.wikiPage.findFirst({
      where: { namespaceId: namespace.id, title: filename }
    });
    if (!page || page.status === 'deleted') return;
    await this.setPageStatus(session, page.id.toString(), 'deleted', {
      reason: '업로드 파일 삭제'
    });
  }

  private async buildWikiSpacePermissionPage(spaceId: bigint) {
    const space = await this.prisma.wikiSpace.findUnique({ where: { id: spaceId } });
    if (!space || space.status !== 'active') {
      throw new NotFoundException('Wiki space not found.');
    }
    const namespace = await this.prisma.wikiNamespace.findUnique({
      where: { code: space.rootNamespaceCode },
    });
    if (!namespace) {
      throw new NotFoundException('Wiki namespace not found.');
    }
    return {
      id: 0n,
      namespaceId: namespace.id,
      spaceId: space.id,
      title: space.title,
      protectionLevel: 'open',
      status: 'normal',
      createdBy: space.createdBy,
    };
  }

  private async createPageInternal(
    session: SessionPayload,
    request: WikiPageMutationRequest,
    authorizedFileUpload: boolean,
    allowedSpaceId?: bigint
  ): Promise<WikiMutationResponse> {
    const contentRaw = this.requiredString(request.contentRaw, 'contentRaw');
    const createTarget = await this.resolveCreatePageTarget(request);
    const namespaceCode = createTarget.namespaceCode;
    const title = createTarget.title;
    const spaceId = createTarget.spaceId;
    if (allowedSpaceId !== undefined && spaceId !== allowedSpaceId) {
      throw new NotFoundException('Wiki space not found.');
    }
    const requestedPageType = this.cleanOptional(request.pageType);
    if (requestedPageType && requestedPageType !== createTarget.pageType) {
      throw new BadRequestException(`Page type must be ${createTarget.pageType} in this wiki space.`);
    }
    const actor = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const slug = createTarget.slug;
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
      await this.lockNamespaceForCreate(tx, createTarget.namespaceId);
      await this.contributionPolicies.assertAccepted(
        createTarget.spaceId,
        request.policyAcceptance,
        tx,
      );
      if (namespaceCode === 'user') {
        const currentOwner = await this.wikiPermissions.resolveUserDocumentOwner(tx, title);
        if (!currentOwner || currentOwner.isAlias || currentOwner.id !== createTarget.ownerProfileId) {
          throw new ConflictException('The user document owner changed. Reload and try again.');
        }
        await this.wikiPermissions.assertCanCreatePage({
          actor: this.wikiPermissions.actorFromSession(session, actor),
          namespaceCode, spaceId, title, pageType: createTarget.pageType, store: tx
        });
      }
      const existing = await tx.wikiPage.findUnique({
        where: {
          namespaceId_slug: {
            namespaceId: createTarget.namespaceId,
            slug
          }
        }
      });
      if (existing) {
        throw new ConflictException('Wiki page already exists.');
      }
      const page = await tx.wikiPage.create({
        data: {
          namespaceId: createTarget.namespaceId,
          spaceId,
          localPath: slug,
          slug,
          title,
          displayTitle: this.cleanOptional(request.displayTitle) ?? createTarget.displayTitle,
          pageType: createTarget.pageType,
          protectionLevel: 'open',
          status: 'normal',
          createdBy: actor.id,
          ownerProfileId: createTarget.ownerProfileId,
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
        pageLocalPath: page.localPath,
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
        spaceId: page.spaceId,
        localPath: page.localPath,
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
    }).catch((error: unknown) => this.throwCreateCollision(error));
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

  async resolveCreatePageTarget(request: Pick<WikiPageMutationRequest, 'namespace' | 'title' | 'spaceId'>): Promise<ResolvedWikiCreateTarget> {
    return this.resolveCreatePageTargetWithStore(this.prisma, request);
  }

  async getCreateContext(
    session: SessionPayload,
    request: Pick<WikiPageMutationRequest, 'namespace' | 'title' | 'spaceId'>
  ): Promise<WikiCreateContextResponse> {
    const target = await this.resolveCreatePageTarget(request);
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    await this.wikiPermissions.assertCanReadCreateTarget({
      actor,
      namespaceId: target.namespaceId,
      namespaceCode: target.namespaceCode,
      spaceId: target.spaceId,
      title: target.title
    });
    const createDecision = await this.wikiPermissions.canCreatePage({
      actor,
      namespaceCode: target.namespaceCode,
      spaceId: target.spaceId,
      title: target.title,
      pageType: target.pageType
    });
    let canRequest = true;
    try {
      await this.wikiPermissions.assertCanUseCreateTargetAction({
        actor,
        action: 'edit_request',
        namespaceId: target.namespaceId,
        namespaceCode: target.namespaceCode,
        spaceId: target.spaceId,
        title: target.title
      });
    } catch (error) {
      if (error instanceof ForbiddenException) canRequest = false;
      else throw error;
    }
    if (!createDecision.allowed && !canRequest) {
      throw new ForbiddenException('Wiki page creation and edit requests are not allowed.');
    }
    return {
      namespace: target.namespaceCode,
      namespaceId: target.namespaceId,
      spaceId: target.spaceId.toString(),
      title: target.title,
      displayTitle: target.displayTitle,
      pageType: target.pageType,
      canCreate: createDecision.allowed,
      canRequest
    };
  }

  private async resolveCreatePageTargetWithStore(
    store: PrismaService | Prisma.TransactionClient,
    request: Pick<WikiPageMutationRequest, 'namespace' | 'title' | 'spaceId'>
  ): Promise<ResolvedWikiCreateTarget> {
    const namespaceCode = this.cleanNamespace(request.namespace);
    const title = this.requiredString(request.title, 'title');
    const namespace = await store.wikiNamespace.findUnique({ where: { code: namespaceCode } });
    if (!namespace) throw new NotFoundException('Wiki namespace not found.');
    const target = await this.resolveCreateTarget(store, namespaceCode, title, request.spaceId);
    const owner = namespaceCode === 'user'
      ? await this.wikiPermissions.resolveUserDocumentOwner(store, title)
      : null;
    if (namespaceCode === 'user' && (!owner || owner.isAlias)) {
      throw new BadRequestException('User document paths must start with an active canonical username.');
    }
    const slug = slugifyTitle(title);
    if (isReservedWikiToolPath(namespaceCode, slug)) {
      throw new BadRequestException('Wiki document paths cannot use the reserved _tools segment.');
    }
    return {
      namespaceId: namespace.id,
      namespaceCode,
      spaceId: target.spaceId,
      title,
      slug,
      displayTitle: target.displayTitle,
      pageType: target.pageType,
      ownerProfileId: owner?.id ?? null
    };
  }

  private async resolveCreateTarget(
    store: Pick<PrismaService, 'wikiSpace' | 'serverWiki'>,
    namespaceCode: string,
    title: string,
    requestedSpaceId?: string
  ) {
    if (requestedSpaceId) {
      const spaceId = this.parseBigIntId(requestedSpaceId, 'spaceId');
      const space = await store.wikiSpace.findUnique({
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
        const serverWiki = await store.serverWiki.findFirst({
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
      const serverWiki = await store.serverWiki.findUnique({
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
      spaceId: await this.findDefaultSpaceId(store, namespaceCode),
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
      readonly allowedSpaceId?: bigint;
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
      if (options.allowedSpaceId !== undefined && page.spaceId !== options.allowedSpaceId) {
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
      await this.contributionPolicies.assertAccepted(
        page.spaceId,
        request.policyAcceptance,
        tx,
      );
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
        pageLocalPath: page.localPath,
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
        spaceId: page.spaceId,
        localPath: page.localPath,
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
      if (initialRequest.requestKind !== 'edit' || initialRequest.pageId === null || initialRequest.baseRevisionId === null) {
        throw new BadRequestException('This is not an existing-document edit request.');
      }
      await this.lockPageForRevision(tx, initialRequest.pageId);
      const editRequest = await tx.wikiEditRequest.findUnique({ where: { id: input.requestId } });
      if (!editRequest || editRequest.requestKind !== 'edit' || editRequest.pageId !== initialRequest.pageId || editRequest.baseRevisionId === null) {
        throw new NotFoundException('Wiki edit request not found.');
      }
      const page = await tx.wikiPage.findUnique({ where: { id: editRequest.pageId } });
      if (!page || page.status === 'deleted') throw new NotFoundException('Wiki page not found.');
      await this.contributionPolicies.assertStoredVersionCurrent(
        page.spaceId,
        editRequest.contributionPolicyVersion,
        tx,
      );
      const namespace = await tx.wikiNamespace.findUnique({ where: { id: page.namespaceId } });
      if (!namespace) throw new NotFoundException('Wiki namespace not found.');
      const reviewerActor = this.wikiPermissions.actorFromSession(session, reviewer);
      if (!(await this.wikiPermissions.canReviewPage({ actor: reviewerActor, page, store: tx }))) {
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
        actorType: editRequest.submitterType === 'ip' ? 'ip' : 'user',
        actorIpHash: editRequest.submitterIpHash,
        title: page.displayTitle,
        namespaceCode: namespace.code,
        pageTitle: page.title,
        pageLocalPath: page.localPath,
        createdAt: now
      });
      await tx.wikiPage.update({ where: { id: page.id }, data: { currentRevisionId: revision.id, updatedAt: now } });
      await this.insertRecentChange(tx, {
        pageId: page.id, revisionId: revision.id, spaceId: page.spaceId, localPath: page.localPath,
        actorId: editRequest.createdBy, changeType: 'edit',
        title: page.title, namespaceCode: namespace.code, summary: revision.editSummary, isMinor: revision.isMinor, createdAt: now
      });
      const completed = await tx.wikiEditRequest.updateMany({
        where: { id: editRequest.id, status: 'reviewing', reviewedBy: reviewer.id },
        data: { status: 'accepted', acceptedRevisionId: revision.id, reviewNote: input.reviewNote, reviewedAt: now, updatedAt: now }
      });
      if (completed.count !== 1) throw new ConflictException('This edit request is no longer being reviewed.');
      if (editRequest.createdBy !== null) {
        await this.notifications?.notifyEditRequestReviewed(tx, {
          profileId: editRequest.createdBy, pageId: page.id, requestId: editRequest.id,
          reviewerProfileId: reviewer.id, status: 'accepted', title: page.displayTitle
        });
      }
      return {
        mutation: { pageId: page.id.toString(), revisionId: revision.id.toString(), revisionNo: revision.revisionNo, namespace: namespace.code, title: page.title, slug: page.slug },
        request: await tx.wikiEditRequest.findUniqueOrThrow({ where: { id: editRequest.id } })
      };
    });
    await this.events?.audit('wiki.edit', {
      category: 'wiki', actorAccountId: session.userId, actorProfileId: reviewer.id,
      subjectType: 'wiki_page', subjectId: result.mutation.pageId,
      metadata: {
        namespace: result.mutation.namespace,
        title: result.mutation.title,
        revisionId: result.mutation.revisionId,
        revisionNo: result.mutation.revisionNo,
        attributionProfileId: result.request.createdBy?.toString() ?? null,
        attributionType: result.request.submitterType,
        editRequestId: result.request.id.toString()
      }
    });
    return result;
  }

  async acceptCreateEditRequest(
    session: SessionPayload,
    input: { readonly requestId: bigint; readonly reviewNote: string | null }
  ): Promise<{ readonly mutation: WikiMutationResponse; readonly request: WikiEditRequest }> {
    const reviewer = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const reviewerActor = this.wikiPermissions.actorFromSession(session, reviewer);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const initial = await tx.wikiEditRequest.findUnique({ where: { id: input.requestId } });
      if (!initial || initial.requestKind !== 'create' || initial.targetNamespaceId === null) {
        throw new NotFoundException('Wiki create request not found.');
      }
      await this.lockNamespaceForCreate(tx, initial.targetNamespaceId);
      const request = await tx.wikiEditRequest.findUnique({ where: { id: input.requestId } });
      if (!request || !this.hasCreateTarget(request) || request.targetNamespaceId !== initial.targetNamespaceId) {
        throw new NotFoundException('Wiki create request not found.');
      }
      if (request.createdBy === null) throw new BadRequestException('Anonymous contributors cannot create documents.');
      await this.contributionPolicies.assertStoredVersionCurrent(
        request.targetSpaceId,
        request.contributionPolicyVersion,
        tx,
      );
      const [namespace, space, existing] = await Promise.all([
        tx.wikiNamespace.findUnique({ where: { id: request.targetNamespaceId } }),
        tx.wikiSpace.findUnique({ where: { id: request.targetSpaceId } }),
        tx.wikiPage.findUnique({
          where: { namespaceId_slug: { namespaceId: request.targetNamespaceId, slug: request.targetSlug } }
        })
      ]);
      if (!namespace || namespace.code !== request.targetNamespaceCode || !space || space.status !== 'active' || space.id !== request.targetSpaceId) {
        throw new ConflictException('The requested wiki target is no longer available.');
      }
      const currentOwner = namespace.code === 'user'
        ? await this.wikiPermissions.resolveUserDocumentOwner(tx, request.targetTitle)
        : null;
      if (namespace.code === 'user' && (!currentOwner || currentOwner.isAlias || request.targetOwnerProfileId !== currentOwner.id)) {
        throw new ConflictException('The requested user document owner is no longer valid.');
      }
      if (existing) {
        throw new ConflictException({
          code: 'wiki_create_target_exists',
          message: 'A document now exists at the requested title.'
        });
      }
      if (!(await this.wikiPermissions.canReviewCreateTarget({
        actor: reviewerActor,
        namespaceId: request.targetNamespaceId,
        namespaceCode: request.targetNamespaceCode,
        spaceId: request.targetSpaceId,
        title: request.targetTitle,
        store: tx
      }))) {
        throw new ForbiddenException('Edit request review is not allowed.');
      }
      const claimed = await tx.wikiEditRequest.updateMany({
        where: {
          id: request.id,
          requestKind: 'create',
          status: 'pending',
          pageId: null,
          targetNamespaceId: request.targetNamespaceId,
          targetSpaceId: request.targetSpaceId,
          targetSlug: request.targetSlug,
          targetOwnerProfileId: request.targetOwnerProfileId,
          proposedContent: request.proposedContent,
          editSummary: request.editSummary,
          isMinor: request.isMinor,
          updatedAt: request.updatedAt
        },
        data: { status: 'reviewing', reviewedBy: reviewer.id, updatedAt: now }
      });
      if (claimed.count !== 1) throw new ConflictException('This edit request is no longer pending.');
      const page = await tx.wikiPage.create({
        data: {
          namespaceId: request.targetNamespaceId,
          spaceId: request.targetSpaceId,
          localPath: request.targetSlug,
          slug: request.targetSlug,
          title: request.targetTitle,
          displayTitle: request.targetDisplayTitle,
          pageType: request.targetPageType,
          protectionLevel: 'open',
          status: 'normal',
          createdBy: request.createdBy,
          ownerProfileId: request.targetOwnerProfileId,
          createdAt: now,
          updatedAt: now
        }
      });
      const revision = await this.createRevision(tx, {
        pageId: page.id,
        revisionNo: 1,
        parentRevisionId: null,
        contentRaw: request.proposedContent,
        editSummary: request.editSummary,
        isMinor: request.isMinor,
        actorId: request.createdBy,
        title: page.displayTitle,
        namespaceCode: namespace.code,
        pageTitle: page.title,
        pageLocalPath: page.localPath,
        createdAt: now
      });
      await tx.wikiPage.update({ where: { id: page.id }, data: { currentRevisionId: revision.id, updatedAt: now } });
      await this.insertRecentChange(tx, {
        pageId: page.id,
        revisionId: revision.id,
        spaceId: page.spaceId,
        localPath: page.localPath,
        actorId: request.createdBy,
        changeType: 'create',
        title: page.title,
        namespaceCode: namespace.code,
        summary: revision.editSummary,
        isMinor: revision.isMinor,
        createdAt: now
      });
      const completed = await tx.wikiEditRequest.updateMany({
        where: { id: request.id, status: 'reviewing', reviewedBy: reviewer.id, pageId: null },
        data: {
          pageId: page.id,
          status: 'accepted',
          acceptedRevisionId: revision.id,
          reviewNote: input.reviewNote,
          reviewedAt: now,
          updatedAt: now
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
      return {
        mutation: {
          pageId: page.id.toString(),
          revisionId: revision.id.toString(),
          revisionNo: revision.revisionNo,
          namespace: namespace.code,
          title: page.title,
          slug: page.slug
        },
        request: await tx.wikiEditRequest.findUniqueOrThrow({ where: { id: request.id } })
      };
    }).catch((error: unknown) => this.throwCreateCollision(error));
    await this.events?.audit('wiki.create', {
      category: 'wiki',
      actorAccountId: session.userId,
      actorProfileId: reviewer.id,
      subjectType: 'wiki_page',
      subjectId: result.mutation.pageId,
      metadata: {
        namespace: result.mutation.namespace,
        title: result.mutation.title,
        revisionId: result.mutation.revisionId,
        revisionNo: result.mutation.revisionNo,
        attributionProfileId: result.request.createdBy.toString(),
        editRequestId: result.request.id.toString()
      }
    });
    return result;
  }

  async movePage(session: SessionPayload, pageId: string, request: WikiMoveRequest): Promise<WikiMoveResponse> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const nextTitle = this.requiredString(request.title, 'title');
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
      const permissionActor = this.wikiPermissions.actorFromSession(session, actor);
      await this.wikiPermissions.assertCanMutatePageAction({
        actor: permissionActor,
        action: 'move',
        page,
        store: tx
      });
      await this.assertPageIsNotSpaceRoot(tx, page, 'move');

      const destinationNamespaceCode = this.cleanOptional(request.namespace) ?? namespace.code;
      const destinationNamespace = await tx.wikiNamespace.findUnique({ where: { code: destinationNamespaceCode } });
      if (!destinationNamespace) {
        throw new NotFoundException('Wiki namespace not found.');
      }
      await this.lockNamespacesForMove(tx, [page.namespaceId, destinationNamespace.id]);

      const destination = await this.resolveCreatePageTargetWithStore(tx, {
        namespace: destinationNamespaceCode,
        title: nextTitle,
        spaceId: this.cleanOptional(request.spaceId)
          ?? (destinationNamespaceCode === namespace.code ? page.spaceId.toString() : undefined)
      });
      this.assertMoveNamespaceInvariants(
        namespace.code,
        destination.namespaceCode,
        page.title,
        destination.title,
        page.spaceId,
        destination.spaceId,
      );
      if (destination.namespaceCode === 'user' && !userDocumentTreeHasSingleOwner(
        page.ownerProfileId,
        destination.ownerProfileId,
        [page]
      )) {
        throw new BadRequestException('User documents can only move inside their owner namespace.');
      }
      await this.wikiPermissions.assertCanCreatePage({
        actor: permissionActor,
        namespaceCode: destination.namespaceCode,
        spaceId: destination.spaceId,
        title: destination.title,
        pageType: destination.pageType,
        store: tx
      });
      if (destination.namespaceId === page.namespaceId && destination.slug === page.slug) {
        throw new BadRequestException('The destination title is the same as the current title.');
      }
      if (
        destination.namespaceId === page.namespaceId
        && destination.spaceId === page.spaceId
        && destination.slug.startsWith(`${page.slug}/`)
      ) {
        throw new BadRequestException('A wiki page tree cannot be moved inside itself.');
      }
      const subtreeCandidates = await tx.wikiPage.findMany({
        where: {
          namespaceId: page.namespaceId,
          spaceId: page.spaceId,
          status: { not: 'deleted' },
          pageType: { not: 'redirect' },
          OR: [{ id: page.id }, { localPath: { startsWith: `${page.localPath}/` } }]
        },
        select: { id: true }
      });
      for (const item of subtreeCandidates) {
        if (item.id !== page.id) await this.lockPageForRevision(tx, item.id);
      }
      const subtree = await tx.wikiPage.findMany({
        where: {
          namespaceId: page.namespaceId,
          spaceId: page.spaceId,
          status: { not: 'deleted' },
          pageType: { not: 'redirect' },
          OR: [{ id: page.id }, { localPath: { startsWith: `${page.localPath}/` } }]
        }
      });

      const moves: Array<{
        readonly source: (typeof subtree)[number];
        readonly target: ResolvedWikiCreateTarget;
        readonly displayTitle: string;
      }> = [];
      for (const item of subtree) {
        const titleSuffix = this.moveTitleSuffix(page, item);
        const target = item.id === page.id
          ? destination
          : await this.resolveCreatePageTargetWithStore(tx, {
              namespace: destination.namespaceCode,
              title: `${destination.title}${titleSuffix}`,
              spaceId: destination.spaceId.toString()
            });
        if (
          target.namespaceId !== destination.namespaceId
          || target.spaceId !== destination.spaceId
          || target.pageType !== destination.pageType
        ) {
          throw new ConflictException('The document tree no longer resolves to one destination wiki space.');
        }
        moves.push({
          source: item,
          target,
          displayTitle: item.id === page.id
            ? this.cleanOptional(request.displayTitle) ?? target.displayTitle
            : item.displayTitle
        });
      }
      if (destination.namespaceCode === 'user' && !userDocumentTreeHasSingleOwner(
        page.ownerProfileId,
        destination.ownerProfileId,
        moves.map((move) => move.source)
      )) {
        throw new ConflictException('The user document tree contains inconsistent ownership.');
      }
      for (const move of moves) {
        if (move.source.id === page.id) continue;
        await this.wikiPermissions.assertCanMutatePageAction({ actor: permissionActor, action: 'move', page: move.source, store: tx });
        await this.wikiPermissions.assertCanCreatePage({
          actor: permissionActor,
          namespaceCode: move.target.namespaceCode,
          spaceId: move.target.spaceId,
          title: move.target.title,
          pageType: move.target.pageType,
          store: tx
        });
      }
      const conflicts = await tx.wikiPage.findMany({
        where: {
          id: { notIn: moves.map((move) => move.source.id) },
          OR: [
            {
              namespaceId: destination.namespaceId,
              slug: { in: moves.map((move) => move.target.slug) }
            },
            {
              spaceId: destination.spaceId,
              localPath: { in: moves.map((move) => move.target.slug) }
            }
          ]
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
            namespaceId: move.target.namespaceId,
            spaceId: move.target.spaceId,
            localPath: move.target.slug,
            slug: move.target.slug,
            title: move.target.title,
            displayTitle: move.displayTitle,
            pageType: move.target.pageType,
            ownerProfileId: move.target.ownerProfileId,
            updatedAt: now
          }
        });
        if (move.source.id === page.id) moved = updated;
      }

      for (const move of moves) {
        const revision = await this.findCurrentRevision(tx, move.source);
        if (!revision) {
          throw new NotFoundException('Public wiki revision not found.');
        }
        await this.rebuildCurrentRevisionIndexes(tx, move.source.id, revision);
      }

      const sourcePageAclRules = request.leaveRedirect !== false
        ? await tx.aclRule.findMany({
            where: {
              targetType: 'page',
              targetId: { in: moves.map((move) => move.source.id) }
            },
            orderBy: [{ targetId: 'asc' }, { action: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }]
          })
        : [];
      const aclRulesBySourcePage = new Map<bigint, Array<(typeof sourcePageAclRules)[number]>>();
      for (const rule of sourcePageAclRules) {
        if (rule.targetId === null) continue;
        const rules = aclRulesBySourcePage.get(rule.targetId);
        if (rules) rules.push(rule);
        else aclRulesBySourcePage.set(rule.targetId, [rule]);
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
            ownerProfileId: move.source.ownerProfileId,
            createdAt: now,
            updatedAt: now
          }
        });
        for (const rule of aclRulesBySourcePage.get(move.source.id) ?? []) {
          await tx.aclRule.create({
            data: {
              targetType: 'page',
              targetId: redirect.id,
              action: rule.action,
              effect: rule.effect,
              subjectType: rule.subjectType,
              subjectValue: rule.subjectValue,
              sortOrder: rule.sortOrder,
              reason: rule.reason,
              expiresAt: rule.expiresAt,
              createdBy: rule.createdBy,
              createdAt: now,
              updatedAt: now
            }
          });
        }
        const redirectRevision = await this.createRevision(tx, {
          pageId: redirect.id,
          revisionNo: 1,
          parentRevisionId: null,
          contentRaw: this.redirectMarkup(move.target.namespaceCode, move.target.title),
          editSummary: this.cleanOptional(request.reason) ?? `${move.source.title} 문서 이동`,
          isMinor: false,
          actorId: actor.id,
          title: redirect.displayTitle,
          namespaceCode: namespace.code,
          pageTitle: redirect.title,
          pageLocalPath: redirect.localPath,
          createdAt: now
        });
        await tx.wikiPage.update({
          where: { id: redirect.id },
          data: { currentRevisionId: redirectRevision.id }
        });
        if (move.source.id === page.id) redirectPageId = redirect.id;
      }
      for (const move of moves) {
        await this.insertRecentChange(tx, {
          pageId: move.source.id, revisionId: move.source.currentRevisionId,
          spaceId: move.target.spaceId, localPath: move.target.slug, actorId: actor.id,
          changeType: 'move', title: move.target.title, namespaceCode: move.target.namespaceCode,
          summary: this.moveRecentSummary({
            reason: this.cleanOptional(request.reason),
            previousNamespace: namespace.code,
            previousSpaceId: move.source.spaceId,
            previousTitle: move.source.title,
            namespace: move.target.namespaceCode,
            spaceId: move.target.spaceId,
            title: move.target.title
          }),
          isMinor: false, createdAt: now
        });
      }
      await tx.wikiPageLifecycleEvent.createMany({
        data: moves.map((move) => ({
          pageId: move.source.id,
          eventType: 'move',
          actorProfileId: actor.id,
          reason: this.cleanOptional(request.reason),
          sourceNamespaceId: move.source.namespaceId,
          sourceNamespaceCode: namespace.code,
          sourceSpaceId: move.source.spaceId,
          sourceTitle: move.source.title,
          sourcePath: move.source.localPath,
          destinationNamespaceId: move.target.namespaceId,
          destinationNamespaceCode: move.target.namespaceCode,
          destinationSpaceId: move.target.spaceId,
          destinationTitle: move.target.title,
          destinationPath: move.target.slug,
          createdAt: now
        }))
      });
      const latest = await this.findLatestRevision(tx, moved.id);
      if (!latest) {
        throw new NotFoundException('Public wiki revision not found.');
      }
      return {
        pageId: moved.id.toString(),
        revisionId: latest.id.toString(),
        revisionNo: latest.revisionNo,
        namespace: destination.namespaceCode,
        title: moved.title,
        slug: moved.slug,
        previousTitle: page.title,
        previousNamespace: namespace.code,
        previousSpaceId: page.spaceId.toString(),
        spaceId: destination.spaceId.toString(),
        movedPageCount: moves.length,
        redirectPageId: redirectPageId?.toString() ?? null
      };
    }).catch((error: unknown) => this.throwMoveCollision(error));
    await this.events?.audit('wiki.move', {
      category: 'wiki',
      actorAccountId: session.userId,
      actorProfileId: actor.id,
      subjectType: 'wiki_page',
      subjectId: result.pageId,
      metadata: {
        previousTitle: result.previousTitle,
        title: result.title,
        previousNamespace: result.previousNamespace,
        namespace: result.namespace,
        previousSpaceId: result.previousSpaceId,
        spaceId: result.spaceId,
        movedPageCount: result.movedPageCount,
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
      const permissionActor = this.wikiPermissions.actorFromSession(session, actor);
      await this.wikiPermissions.assertCanMutatePageAction({
        actor: permissionActor,
        action: 'revert',
        page,
        store: tx
      });
      await this.wikiPermissions.assertCanUsePageAction({
        actor: permissionActor,
        action: 'history',
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
        actor: permissionActor,
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
        pageLocalPath: page.localPath,
        createdAt: now
      });
      await tx.wikiPage.update({
        where: { id: page.id },
        data: { currentRevisionId: revision.id, updatedAt: now }
      });
      await this.insertRecentChange(tx, {
        pageId: page.id,
        revisionId: revision.id,
        spaceId: page.spaceId,
        localPath: page.localPath,
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
    const requestedRevisionId = status === 'normal' && request.revisionId
      ? this.parseBigIntId(this.requiredString(request.revisionId, 'revisionId'), 'revisionId')
      : null;
    const actor = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockPageForRevision(tx, parsedPageId);
      const page = await tx.wikiPage.findUnique({ where: { id: parsedPageId } });
      if (!page) {
        throw new NotFoundException('Wiki page not found.');
      }
      if (page.status === status) {
        throw new BadRequestException(`Wiki page is already ${status}.`);
      }
      let eventAudience: 'public' | 'restricted' = 'restricted';
      const permissionActor = this.wikiPermissions.actorFromSession(session, actor);
      if (status === 'deleted') {
        try {
          await this.wikiPermissions.assertCanReadPage({ actor: null, accountId: null, page, store: tx });
          eventAudience = 'public';
        } catch {
          eventAudience = 'restricted';
        }
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
        await this.assertPageIsNotSpaceRoot(tx, page, 'restore');
        await this.wikiPermissions.assertCanRestorePage({ actor: permissionActor, page, store: tx });
      }
      const namespace = await tx.wikiNamespace.findUnique({ where: { id: page.namespaceId } });
      if (!namespace) {
        throw new NotFoundException('Wiki namespace not found.');
      }
      const latestPublic = status === 'normal'
        ? await tx.wikiPageRevision.findFirst({
            where: { pageId: page.id, visibility: 'public' },
            orderBy: [{ revisionNo: 'desc' }]
          })
        : null;
      if (status === 'normal' && !latestPublic) {
        throw new ConflictException('A wiki page without a public revision cannot be restored.');
      }
      let restoredRevision = latestPublic;
      let sourceRevisionId: bigint | null = null;
      if (status === 'normal' && requestedRevisionId && latestPublic) {
        const source = await tx.wikiPageRevision.findUnique({ where: { id: requestedRevisionId } });
        if (!source || source.pageId !== page.id || source.visibility !== 'public') {
          throw new NotFoundException('Restore source revision not found.');
        }
        if (namespace.code === 'file' && source.id !== latestPublic.id) {
          throw new ConflictException('File documents can only be restored from their latest public revision.');
        }
        await this.assertLockedSectionsUnchanged({
          actor: permissionActor,
          page,
          currentContent: latestPublic.contentRaw,
          nextContent: source.contentRaw,
          store: tx
        });
        const latestStored = await this.findLatestStoredRevision(tx, page.id);
        restoredRevision = await this.createRevision(tx, {
          pageId: page.id,
          revisionNo: latestStored ? latestStored.revisionNo + 1 : 1,
          parentRevisionId: latestPublic.id,
          contentRaw: source.contentRaw,
          editSummary: this.cleanOptional(request.reason) ?? `r${source.revisionNo} 판을 선택해 문서 복구`,
          isMinor: false,
          actorId: actor.id,
          title: page.displayTitle,
          namespaceCode: namespace.code,
          pageTitle: page.title,
          pageLocalPath: page.localPath,
          createdAt: now,
          editTags: { restoredFromRevisionId: source.id.toString() }
        });
        sourceRevisionId = source.id;
      }
      if (namespace.code === 'file') {
        await this.transitionFilePageAsset(tx, page, status, now);
      }
      const updated = await tx.wikiPage.update({
        where: { id: page.id },
        data: {
          status,
          ...(restoredRevision ? { currentRevisionId: restoredRevision.id } : {}),
          updatedAt: now
        }
      });
      if (status === 'normal') {
        try {
          await this.wikiPermissions.assertCanReadPage({ actor: null, accountId: null, page: updated, store: tx });
          eventAudience = 'public';
        } catch {
          eventAudience = 'restricted';
        }
      }
      await this.insertRecentChange(tx, {
        pageId: updated.id,
        revisionId: restoredRevision?.id ?? updated.currentRevisionId,
        spaceId: updated.spaceId,
        localPath: updated.localPath,
        actorId: actor.id,
        changeType: status === 'deleted' ? 'delete' : 'restore',
        title: updated.title,
        namespaceCode: namespace.code,
        summary: status === 'deleted'
          ? '문서 삭제'
          : this.cleanOptional(request.reason) ?? '문서 복구',
        eventAudience,
        previousPublicRevisionId: restoredRevision && restoredRevision.id !== latestPublic?.id
          ? latestPublic?.id ?? null
          : null,
        sizeDelta: restoredRevision && restoredRevision.id !== latestPublic?.id && latestPublic
          ? restoredRevision.contentSize - latestPublic.contentSize
          : 0,
        isMinor: false,
        createdAt: now
      });
      await tx.wikiPageLifecycleEvent.create({
        data: {
          pageId: updated.id,
          eventType: status === 'deleted' ? 'delete' : 'restore',
          actorProfileId: actor.id,
          sourceRevisionId,
          reason: this.cleanOptional(request.reason),
          ...(status === 'deleted'
            ? {
                sourceNamespaceId: page.namespaceId,
                sourceNamespaceCode: namespace.code,
                sourceSpaceId: page.spaceId,
                sourceTitle: page.title,
                sourcePath: page.localPath
              }
            : {
                destinationNamespaceId: page.namespaceId,
                destinationNamespaceCode: namespace.code,
                destinationSpaceId: page.spaceId,
                destinationTitle: page.title,
                destinationPath: page.localPath
              }),
          createdAt: now
        }
      });
      return {
        pageId: updated.id.toString(),
        status,
        ...(restoredRevision ? { revisionId: restoredRevision.id.toString() } : {}),
        ...(status === 'normal' ? { sourceRevisionId: sourceRevisionId?.toString() ?? null } : {})
      };
    });
    await this.events?.audit(status === 'deleted' ? 'wiki.delete' : 'wiki.restore', {
      category: 'wiki',
      actorAccountId: session.userId,
      actorProfileId: actor.id,
      subjectType: 'wiki_page',
      subjectId: result.pageId,
      metadata: {
        status,
        reason: this.cleanOptional(request.reason),
        revisionId: result.revisionId ?? null,
        sourceRevisionId: result.sourceRevisionId ?? null
      }
    });
    return result;
  }

  private async transitionFilePageAsset(
    tx: Prisma.TransactionClient,
    page: { readonly id: bigint; readonly title: string },
    status: 'normal' | 'deleted',
    now: Date,
  ): Promise<void> {
    const asset = await tx.uploadedFile.findFirst({
      where: { currentWikiFilename: page.title, usageContext: 'wiki_editor' },
    });
    if (status === 'normal') {
      if (!asset || !['active', 'delete_pending', 'retained'].includes(asset.status)) {
        throw new ConflictException('The file document cannot be restored because its retained asset is unavailable.');
      }
      await tx.uploadedFile.update({
        where: { id: asset.id },
        data: { status: 'active', deletedAt: null, retainedUntil: null },
      });
      return;
    }
    const references = await tx.$queryRaw<Array<{ sourcePageId: bigint }>>`
      SELECT l.source_page_id AS sourcePageId
      FROM page_links l
      JOIN pages p
        ON p.id = l.source_page_id
       AND p.current_revision_id = l.source_revision_id
      JOIN namespaces n
        ON n.id = p.namespace_id
      WHERE l.target_namespace_code = 'file'
        AND l.target_slug = ${page.title}
        AND l.link_type = 'file'
        AND p.status <> 'deleted'
        AND NOT (n.code = 'file' AND p.id = ${page.id})
      LIMIT 1
    `;
    if (references.length > 0) {
      throw new ConflictException('File is still referenced by a current wiki document.');
    }
    if (asset && asset.status !== 'retained') {
      await tx.uploadedFile.update({
        where: { id: asset.id },
        data: { status: 'retained', deletedAt: now, retainedUntil: wikiFileRetentionDeadline(now) },
      });
    }
  }

  private async assertPageIsNotSpaceRoot(
    tx: Prisma.TransactionClient,
    page: {
      readonly id: bigint;
      readonly spaceId: bigint;
      readonly slug: string;
      readonly localPath: string;
      readonly ownerProfileId?: bigint | null;
    },
    action: 'move' | 'delete' | 'restore'
  ): Promise<void> {
    if (isUserDocumentRoot(page)) {
      throw new ForbiddenException(
        `A user root document cannot be ${action === 'move' ? 'moved' : action === 'delete' ? 'deleted' : 'restored'}.`
      );
    }
    const [space, serverWiki] = await Promise.all([
      tx.wikiSpace.findUnique({ where: { id: page.spaceId }, select: { rootPageId: true } }),
      tx.serverWiki.findFirst({ where: { spaceId: page.spaceId }, select: { slug: true } })
    ]);
    if (space?.rootPageId === page.id || (serverWiki && slugifyTitle(serverWiki.slug) === page.slug)) {
      throw new ForbiddenException(
        `A wiki space root page cannot be ${action === 'move' ? 'moved' : action === 'delete' ? 'deleted' : 'restored'}.`
      );
    }
  }

  private assertMoveNamespaceInvariants(
    previousNamespace: string,
    namespace: string,
    previousTitle: string,
    title: string,
    previousSpaceId: bigint,
    spaceId: bigint,
  ): void {
    const violation = wikiMoveNamespaceInvariantViolation({
      previousNamespace,
      namespace,
      previousTitle,
      title,
      previousSpaceId,
      spaceId,
    });
    if (violation) throw new BadRequestException(violation);
  }

  private moveTitleSuffix(
    root: { readonly id: bigint; readonly title: string; readonly localPath: string },
    page: { readonly id: bigint; readonly title: string; readonly localPath: string }
  ): string {
    if (page.id === root.id) return '';
    if (page.title.startsWith(`${root.title}/`)) {
      return page.title.slice(root.title.length);
    }
    return page.localPath.slice(root.localPath.length);
  }

  private redirectMarkup(namespaceCode: string, title: string): string {
    return `#넘겨주기 [[${namespaceCode}:${title}]]`;
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
      baseRevisionId: request.baseRevisionId,
      policyAcceptance: request.policyAcceptance,
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
        baseRevisionId,
        policyAcceptance: request.policyAcceptance,
      },
      { conflictScope: 'section' }
    );
    return { ...mutation, sectionAnchor: nextHeading.anchor };
  }

  async getRevision(revisionId: string, viewer?: WikiAccessViewer): Promise<WikiRevisionResponse> {
    const access = await resolveWikiAccessContext(this.prisma, this.wikiPermissions, viewer);
    return this.getRevisionForAction(revisionId, access, 'raw');
  }

  async getRawPage(
    pageId: string,
    viewer?: WikiAccessViewer,
    revisionId?: string | null,
    options: { readonly allowedSpaceId?: bigint } = {}
  ): Promise<WikiRevisionResponse> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: parsedPageId } });
    if (!page) {
      throw new NotFoundException('Wiki page not found.');
    }
    if (options.allowedSpaceId !== undefined && page.spaceId !== options.allowedSpaceId) {
      throw new NotFoundException('Wiki page not found.');
    }
    const access = await resolveWikiAccessContext(this.prisma, this.wikiPermissions, viewer);
    const boundary = await this.resolvePublishedPageBoundary(page, access);
    const currentProof = boundary
      ? { boundary, item: boundary.currentItem }
      : undefined;
    const currentPermissionPage = boundary
      ? this.pagePermissionSnapshot(page, boundary.currentItem)
      : page;
    await this.wikiPermissions.assertCanReadPage({
      ...access,
      page: currentPermissionPage,
      publicationProof: currentProof,
    });
    await this.wikiPermissions.assertCanUsePageAction({
      ...access,
      action: 'raw',
      page: currentPermissionPage,
      publicationProof: currentProof,
    });
    const selectedRevisionId = revisionId
      ? this.parseBigIntId(revisionId, 'revisionId')
      : boundary?.currentItem.revisionId ?? null;
    const revision = selectedRevisionId
      ? await this.prisma.wikiPageRevision.findUnique({
          where: { id: selectedRevisionId }
        })
      : page.currentRevisionId
        ? await this.prisma.wikiPageRevision.findUnique({ where: { id: page.currentRevisionId } })
        : await this.findLatestRevision(this.prisma, page.id);
    if (!revision || revision.pageId !== page.id || revision.visibility !== 'public') {
      throw new NotFoundException('Wiki revision not found.');
    }
    const proof = boundary
      ? await this.resolvePublishedRevisionProof(boundary, page.id, revision.id, access)
      : null;
    const releaseItem = proof?.item ?? null;
    await this.wikiPermissions.assertCanReadPage({
      ...access,
      page: releaseItem ? this.pagePermissionSnapshot(page, releaseItem) : page,
      revision,
      publicationProof: proof ?? undefined,
    });
    return this.toRevisionResponse(revision);
  }

  private async getRevisionForAction(
    revisionId: string,
    access: WikiAccessContext,
    action: 'raw' | 'history',
    options: { readonly allowedSpaceId?: bigint } = {}
  ): Promise<WikiRevisionResponse> {
    const id = this.parseBigIntId(revisionId, 'revisionId');
    const revision = await this.prisma.wikiPageRevision.findUnique({ where: { id } });
    if (!revision || revision.visibility !== 'public') {
      throw new NotFoundException('Wiki revision not found.');
    }
    const page = await this.prisma.wikiPage.findUnique({ where: { id: revision.pageId } });
    if (options.allowedSpaceId !== undefined && page?.spaceId !== options.allowedSpaceId) {
      throw new NotFoundException('Wiki revision not found.');
    }
    if (!page) throw new NotFoundException('Wiki revision not found.');
    const boundary = await this.resolvePublishedPageBoundary(page, access);
    const proof = boundary
      ? await this.resolvePublishedRevisionProof(boundary, page.id, revision.id, access)
      : null;
    const releaseItem = proof?.item ?? null;
    const permissionPage = releaseItem ? this.pagePermissionSnapshot(page, releaseItem) : page;
    await this.wikiPermissions.assertCanReadPage({
      ...access,
      page: permissionPage,
      revision,
      publicationProof: proof ?? undefined,
    });
    await this.wikiPermissions.assertCanUsePageAction({
      ...access,
      action,
      page: permissionPage,
      publicationProof: proof ?? undefined,
    });
    return this.toRevisionResponse(revision);
  }

  private async resolvePublishedPageBoundary(
    page: { readonly id: bigint; readonly spaceId: bigint; readonly title: string; readonly protectionLevel: string; readonly status: string },
    access: WikiAccessContext,
  ): Promise<WikiPublishedPageBoundary | null> {
    const boundaryResolver = this.wikiPermissions.resolvePublishedPageBoundary?.bind(this.wikiPermissions);
    if (boundaryResolver) return boundaryResolver({ actor: access.actor ?? null, page });
    const legacyResolver = this.wikiPermissions.resolvePublishedRevisionScope?.bind(this.wikiPermissions);
    const scope = legacyResolver ? await legacyResolver({ actor: access.actor ?? null, page }) : null;
    return scope ? {
      serverWikiId: scope.serverWikiId,
      spaceId: scope.spaceId,
      currentReleaseId: scope.currentReleaseId,
      currentReleaseVersion: scope.currentReleaseVersion,
      currentReleaseSnapshotVersion: scope.currentReleaseSnapshotVersion,
      currentItem: scope.currentItem,
    } : null;
  }

  private async resolvePublishedRevisionProof(
    boundary: WikiPublishedPageBoundary,
    pageId: bigint,
    revisionId: bigint,
    access: WikiAccessContext,
  ): Promise<WikiPublishedRevisionProof> {
    const proofResolver = this.wikiPermissions.resolvePublishedRevisionProof?.bind(this.wikiPermissions);
    if (proofResolver) return proofResolver({ boundary, pageId, revisionId });
    const legacyResolver = this.wikiPermissions.resolvePublishedRevisionScope?.bind(this.wikiPermissions);
    const page = await this.prisma.wikiPage.findUnique({ where: { id: pageId } });
    const scope = page && legacyResolver
      ? await legacyResolver({ page, actor: access.actor ?? null })
      : null;
    const item = scope?.revisionItems.find((candidate) => candidate.revisionId === revisionId);
    if (!item) throw new NotFoundException('Wiki revision not found.');
    return { boundary, item };
  }

  private pagePermissionSnapshot<T extends {
    readonly namespaceId: number;
    readonly title: string;
    readonly protectionLevel: string;
    readonly pageStatus: string;
    readonly createdBy: bigint | null;
    readonly ownerProfileId: bigint | null;
  }>(page: { readonly id: bigint; readonly spaceId: bigint }, item: T) {
    return {
      id: page.id,
      namespaceId: item.namespaceId,
      spaceId: page.spaceId,
      title: item.title,
      protectionLevel: item.protectionLevel,
      status: item.pageStatus,
      createdBy: item.createdBy,
      ownerProfileId: item.ownerProfileId,
    };
  }

  async getRevisionDiff(
    leftId: string,
    rightId: string,
    viewer?: WikiAccessViewer,
    options: { readonly allowedSpaceId?: bigint } = {}
  ): Promise<WikiRevisionDiffResponse> {
    const access = await resolveWikiAccessContext(this.prisma, this.wikiPermissions, viewer);
    const [left, right] = await Promise.all([
      this.getRevisionForAction(leftId, access, 'history', options),
      this.getRevisionForAction(rightId, access, 'history', options)
    ]);
    if (left.pageId !== right.pageId) {
      throw new BadRequestException('Wiki revisions must belong to the same page.');
    }
    return {
      left,
      right,
      hunks: this.diffText(left.contentRaw, right.contentRaw)
    };
  }

  async preview(
    contentRaw: string | undefined,
    context?: WikiPreviewContext,
    viewer?: WikiAccessViewer,
  ): Promise<WikiPreviewResponse> {
    const previewContext = await this.resolvePreviewContext(context, viewer);
    const linkResolution = previewContext
      ? wikiLinkResolutionContext(previewContext.namespace, previewContext.localPath)
      : undefined;
    const parsed = parseMarkup(contentRaw ?? '', linkResolution ? { linkResolution } : {});
    const expanded = this.wikiIncludes && previewContext && astContainsInclude(parsed.ast)
      ? await this.wikiIncludes.expand({
          ast: parsed.ast,
          accountId: previewContext.access.accountId,
          actor: previewContext.access.actor,
          requestIp: previewContext.access.requestIp,
          sourcePageId: previewContext.pageId,
          sourceNamespace: previewContext.namespace,
          sourceLocalPath: previewContext.localPath,
        })
      : { ast: parsed.ast };
    return {
      html: renderDocument(expanded.ast, linkResolution ? { linkResolution } : {}),
      links: parsed.links,
      categories: parsed.categories,
      errors: parsed.errors,
      blockingErrors: parsed.blockingErrors
    };
  }

  private async resolvePreviewContext(
    context: WikiPreviewContext | undefined,
    viewer: WikiAccessViewer,
  ): Promise<{
    readonly pageId: bigint;
    readonly namespace: string;
    readonly localPath: string;
    readonly access: WikiAccessContext;
  } | null> {
    if (!context?.pageId && (!context?.namespace || context.localPath === undefined)) {
      return null;
    }
    const access = await resolveWikiAccessContext(this.prisma, this.wikiPermissions, viewer);
    if (context.pageId) {
      const pageId = this.parseBigIntId(context.pageId, 'pageId');
      const page = await this.prisma.wikiPage.findUnique({ where: { id: pageId } });
      if (!page) throw new NotFoundException('Wiki page not found.');
      const namespace = await this.prisma.wikiNamespace.findUnique({
        where: { id: page.namespaceId },
        select: { code: true },
      });
      if (!namespace) throw new NotFoundException('Wiki namespace not found.');
      await this.wikiPermissions.assertCanReadPage({ ...access, page });
      return { pageId, namespace: namespace.code, localPath: page.localPath, access };
    }

    const namespaceCode = this.cleanNamespace(context.namespace);
    const localPath = this.requiredString(context.localPath, 'localPath');
    if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(namespaceCode) || localPath.length > 500) {
      throw new BadRequestException('Wiki preview context is invalid.');
    }
    const namespace = await this.prisma.wikiNamespace.findUnique({
      where: { code: namespaceCode },
      select: { id: true, code: true },
    });
    if (!namespace) throw new NotFoundException('Wiki namespace not found.');
    const existing = await this.prisma.wikiPage.findUnique({
      where: {
        namespaceId_slug: {
          namespaceId: namespace.id,
          slug: slugifyTitle(localPath),
        },
      },
    });
    if (existing) {
      await this.wikiPermissions.assertCanReadPage({ ...access, page: existing });
    }
    return {
      pageId: existing?.id ?? 0n,
      namespace: namespace.code,
      localPath: existing?.localPath ?? localPath,
      access,
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

  private async findDefaultSpaceId(
    store: Pick<PrismaService, 'wikiSpace'>,
    namespaceCode: string
  ): Promise<bigint> {
    const direct = await store.wikiSpace.findFirst({
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

  private async lockNamespaceForCreate(tx: Prisma.TransactionClient, namespaceId: number): Promise<void> {
    await tx.$queryRaw<Array<{ id: number }>>`
      SELECT id
      FROM namespaces
      WHERE id = ${namespaceId}
      FOR UPDATE
    `;
  }

  private async lockNamespacesForMove(tx: Prisma.TransactionClient, namespaceIds: readonly number[]): Promise<void> {
    const ordered = [...new Set(namespaceIds)].sort((left, right) => left - right);
    for (const namespaceId of ordered) {
      await this.lockNamespaceForCreate(tx, namespaceId);
    }
  }

  private throwCreateCollision(error: unknown): never {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      throw new ConflictException({
        code: 'wiki_create_target_exists',
        message: 'A document now exists at the requested title.'
      });
    }
    throw error;
  }

  private throwMoveCollision(error: unknown): never {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      throw new ConflictException({
        code: 'wiki_move_target_exists',
        message: 'A document now exists at the requested move destination.'
      });
    }
    throw error;
  }

  private hasCreateTarget(request: WikiEditRequest): request is WikiEditRequest & {
    targetNamespaceId: number;
    targetNamespaceCode: string;
    targetSpaceId: bigint;
    targetTitle: string;
    targetSlug: string;
    targetDisplayTitle: string;
    targetPageType: string;
  } {
    return request.requestKind === 'create' &&
      request.targetNamespaceId !== null &&
      request.targetNamespaceCode !== null &&
      request.targetSpaceId !== null &&
      request.targetTitle !== null &&
      request.targetSlug !== null &&
      request.targetDisplayTitle !== null &&
      request.targetPageType !== null;
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
      actorId: bigint | null;
      actorType?: 'user' | 'ip';
      actorIpHash?: string | null;
      title: string;
      namespaceCode: string;
      pageTitle: string;
      pageLocalPath: string;
      createdAt: Date;
      editTags?: Prisma.InputJsonValue | null;
    }
  ) {
    const linkResolution = wikiLinkResolutionContext(input.namespaceCode, input.pageLocalPath);
    const parsed = parseMarkup(input.contentRaw, { linkResolution });
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
        actorType: input.actorType ?? 'user',
        actorUserId: input.actorType === 'ip' ? null : input.actorId,
        actorIp: null,
        actorIpText: null,
        actorIpHash: input.actorIpHash ?? null,
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
          html: renderDocument(parsed.ast, { linkResolution }),
          createdAt: input.createdAt
        }
      });
    }
    await this.wikiLinks?.replaceForRevision(
      tx as Prisma.TransactionClient,
      input.pageId,
      revision.id,
      parsed.links,
      parsed.categoryLinks,
      parsed.includes,
      {
        contentSize: revision.contentSize,
        contentRaw: revision.contentRaw,
        fileNames: [...collectWikiFileNames(parsed.ast)],
        redirectTarget: parsed.redirectTarget
      }
    );
    await this.notifications?.notifyWatchedRevision(tx as Prisma.TransactionClient, {
      pageId: input.pageId,
      revisionId: revision.id,
      actorProfileId: input.actorId,
      title: input.title
    });
    return revision;
  }

  private async rebuildCurrentRevisionIndexes(
    tx: Prisma.TransactionClient,
    pageId: bigint,
    revision: {
      readonly id: bigint;
      readonly contentRaw: string;
      readonly contentSize: number;
    }
  ): Promise<void> {
    if (!this.wikiLinks) return;
    const parsed = parseMarkup(revision.contentRaw);
    await this.wikiLinks.replaceForRevision(
      tx,
      pageId,
      revision.id,
      parsed.links,
      parsed.categoryLinks,
      parsed.includes,
      {
        contentSize: revision.contentSize,
        contentRaw: revision.contentRaw,
        fileNames: [...collectWikiFileNames(parsed.ast)],
        redirectTarget: parsed.redirectTarget
      }
    );
  }

  private moveRecentSummary(input: {
    readonly reason: string | null;
    readonly previousNamespace: string;
    readonly previousSpaceId: bigint;
    readonly previousTitle: string;
    readonly namespace: string;
    readonly spaceId: bigint;
    readonly title: string;
  }): string {
    const metadata = `[${input.previousNamespace}@${input.previousSpaceId.toString()} -> ${input.namespace}@${input.spaceId.toString()}]`;
    const titles = `${input.previousTitle} -> ${input.title}`;
    return `${metadata} ${titles}${input.reason ? ` | ${input.reason}` : ''}`.slice(0, 255);
  }

  private async insertRecentChange(
    tx: Prisma.TransactionClient,
    input: {
      pageId: bigint;
      revisionId: bigint | null;
      spaceId?: bigint;
      localPath?: string;
      previousPublicRevisionId?: bigint | null;
      actorId: bigint | null;
      changeType: ChangeType;
      title: string;
      namespaceCode: string;
      summary?: string | null;
      sizeDelta?: number | null;
      eventAudience?: 'public' | 'restricted';
      isMinor: boolean;
      createdAt: Date;
    }
  ): Promise<void> {
    const page = input.spaceId !== undefined && input.localPath !== undefined
      ? { id: input.pageId, spaceId: input.spaceId, localPath: input.localPath, status: 'normal' }
      : await tx.wikiPage.findUnique({ where: { id: input.pageId } });
    if (!page) throw new NotFoundException('Wiki page not found while recording its recent change.');
    const revision = input.revisionId && typeof tx.wikiPageRevision.findUnique === 'function'
      ? await tx.wikiPageRevision.findUnique({ where: { id: input.revisionId } })
      : null;
    const previousPublicRevisionId = input.previousPublicRevisionId !== undefined
      ? input.previousPublicRevisionId
      : revision?.parentRevisionId ?? null;
    const previous = input.sizeDelta === undefined && previousPublicRevisionId
      && typeof tx.wikiPageRevision.findFirst === 'function'
      ? await tx.wikiPageRevision.findFirst({
          where: { id: previousPublicRevisionId, pageId: input.pageId, visibility: 'public' },
          select: { contentSize: true }
        })
      : null;
    const eventAudience = input.eventAudience ?? 'restricted';
    await tx.wikiRecentChange.create({
      data: {
        pageId: input.pageId,
        revisionId: input.revisionId,
        previousPublicRevisionId,
        actorId: input.actorId,
        spaceId: page.spaceId,
        changeType: input.changeType,
        title: input.title,
        localPath: page.localPath,
        namespaceCode: input.namespaceCode,
        summary: input.summary ?? null,
        sizeDelta: input.sizeDelta !== undefined
          ? input.sizeDelta
          : revision && previous
            ? revision.contentSize - previous.contentSize
            : revision?.contentSize ?? null,
        eventAudience,
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
    editSummaryHidden?: boolean | null;
    isMinor: boolean;
    createdBy: bigint | null;
    actorUserId: bigint | null;
    createdAt: Date;
    visibility: string;
  }): WikiRevisionResponse {
    const publicSummary = publicWikiRevisionEditSummary(revision);
    return {
      id: revision.id.toString(),
      pageId: revision.pageId.toString(),
      revisionNo: revision.revisionNo,
      parentRevisionId: revision.parentRevisionId?.toString() ?? null,
      contentRaw: revision.contentRaw,
      contentHash: revision.contentHash,
      contentSize: revision.contentSize,
      syntaxVersion: revision.syntaxVersion,
      ...publicSummary,
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
    const hunks: WikiRevisionDiffResponse['hunks'] = [];
    let leftIndex = 0;
    let rightIndex = 0;
    for (const [matchedLeft, matchedRight] of matchCommonLines(leftLines, rightLines)) {
      while (leftIndex < matchedLeft) {
        hunks.push({ type: 'removed', line: leftLines[leftIndex]!, leftLine: leftIndex + 1, rightLine: null });
        leftIndex += 1;
      }
      while (rightIndex < matchedRight) {
        hunks.push({ type: 'added', line: rightLines[rightIndex]!, leftLine: null, rightLine: rightIndex + 1 });
        rightIndex += 1;
      }
      hunks.push({ type: 'context', line: leftLines[matchedLeft]!, leftLine: matchedLeft + 1, rightLine: matchedRight + 1 });
      leftIndex = matchedLeft + 1;
      rightIndex = matchedRight + 1;
    }
    while (leftIndex < leftLines.length) {
      hunks.push({ type: 'removed', line: leftLines[leftIndex]!, leftLine: leftIndex + 1, rightLine: null });
      leftIndex += 1;
    }
    while (rightIndex < rightLines.length) {
      hunks.push({ type: 'added', line: rightLines[rightIndex]!, leftLine: null, rightLine: rightIndex + 1 });
      rightIndex += 1;
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

function wikiFileRetentionDeadline(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + 90 * 24 * 60 * 60 * 1_000);
}

export function astContainsFile(ast: readonly AstNode[]): boolean {
  return collectWikiFileNames(ast).size > 0;
}

export function astContainsInclude(ast: readonly AstNode[]): boolean {
  const inlineContainsInclude = (nodes: readonly InlineNode[]): boolean => nodes.some((node) => {
    if (node.type === 'include') return true;
    if (node.type === 'internal_link' || node.type === 'external_link') {
      return node.labelChildren ? inlineContainsInclude(node.labelChildren) : false;
    }
    return 'children' in node && Array.isArray(node.children)
      ? inlineContainsInclude(node.children as InlineNode[])
      : false;
  });
  const listContainsInclude = (node: Extract<AstNode, { type: 'list' }>): boolean => node.items.some((item) => (
    inlineContainsInclude(item.children) || item.nested.some(listContainsInclude)
  ));
  return ast.some((node) => {
    if (node.type === 'include') return true;
    if (node.type === 'heading') return node.children ? inlineContainsInclude(node.children) : false;
    if (node.type === 'paragraph') return inlineContainsInclude(node.children);
    if (node.type === 'list') return listContainsInclude(node);
    if (node.type === 'wiki_table') return inlineContainsInclude(node.caption) || node.rows.some((row) => row.cells.some((cell) => (
      inlineContainsInclude(cell.children) || (cell.blocks ? astContainsInclude(cell.blocks) : false)
    )));
    if (node.type === 'folding' && inlineContainsInclude(node.title)) return true;
    if (
      node.type === 'indent'
      || node.type === 'folding'
      || node.type === 'conditional'
      || node.type === 'wiki_style'
      || node.type === 'blockquote'
    ) {
      return astContainsInclude(node.children);
    }
    return false;
  });
}

export function isReservedWikiToolPath(namespaceCode: string, slug: string): boolean {
  const segments = slug.split('/').filter(Boolean);
  return namespaceCode === 'server' ? segments[1] === '_tools' : segments[0] === '_tools';
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

function wikiFileExtension(title: string): string | null {
  const filename = title.split('/').at(-1) ?? '';
  const match = filename.match(/(\.[^.]+)$/u);
  return match?.[1]?.toLocaleLowerCase('en-US') ?? null;
}

export function wikiMoveNamespaceInvariantViolation(input: {
  readonly previousNamespace: string;
  readonly namespace: string;
  readonly previousTitle: string;
  readonly title: string;
  readonly previousSpaceId?: bigint;
  readonly spaceId?: bigint;
}): string | null {
  if (
    (input.previousNamespace === 'server' || input.namespace === 'server')
    && (
      input.previousNamespace !== input.namespace
      || (
        input.previousSpaceId !== undefined
        && input.spaceId !== undefined
        && input.previousSpaceId !== input.spaceId
      )
    )
  ) {
    return 'Server wiki documents can only move inside their linked server wiki.';
  }
  if (input.previousNamespace !== input.namespace && (
    input.previousNamespace === 'user'
    || input.namespace === 'user'
    || input.previousNamespace === 'file'
    || input.namespace === 'file'
  )) {
    return 'User and file documents cannot move across namespaces.';
  }
  if (input.previousNamespace === 'file') {
    const previousExtension = wikiFileExtension(input.previousTitle);
    const extension = wikiFileExtension(input.title);
    if (!previousExtension || !extension || previousExtension !== extension) {
      return 'File document moves must preserve the file extension.';
    }
  }
  return null;
}

function sectionContentsByAnchor(content: string, anchor: string): string[] {
  const parsed = parseMarkup(content);
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  return parsed.headings
    .filter((heading) => heading.anchor === anchor || heading.title === anchor)
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
  const matches = parsed.headings.filter(
    (heading) => heading.anchor === anchor || heading.title === anchor,
  );
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

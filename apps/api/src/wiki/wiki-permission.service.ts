import { ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { isPublicWikiPageStatus } from '@minewiki/wiki-core/page-status';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { WikiAclService, type WikiAclAction, type WikiAclDecision, type WikiThreadAclAction } from './wiki-acl.service';
import { serverWikiIdentityConflicts } from '../server/server-wiki-identity';
import { hasCanonicalPublicServerWikiParent } from '../server/server-wiki-public-readiness';
import type { ServerWikiReleaseItem } from '@prisma/client';

type WikiPermissionStore = Pick<
  PrismaService,
  | 'wikiProfile'
  | 'wikiUsernameAlias'
  | 'account'
  | 'wikiSpace'
  | 'subwikiRole'
  | 'serverWiki'
  | 'serverWikiReleaseItem'
  | 'server'
  | 'modWiki'
  | 'aclRule'
  | 'aclGroup'
  | 'aclGroupMember'
  | 'wikiGroup'
  | 'wikiUserGroup'
  | 'wikiGroupPermission'
  | 'wikiNamespace'
  | 'wikiPage'
  | 'wikiPageRevision'
>;

export interface WikiPermissionActor {
  readonly accountId: string;
  readonly profileId: bigint;
  readonly status: string;
  readonly isElevated?: boolean;
  readonly permissions?: readonly string[];
  readonly groups?: readonly string[];
  /** Current request address from the central HTTP extraction boundary. */
  readonly requestIp?: string | null;
}

type WikiPermissionSession = SessionPayload & {
  readonly permissions?: readonly string[];
  readonly groups?: readonly string[];
};

export interface WikiPermissionPage {
  readonly id: bigint;
  readonly namespaceId?: number;
  readonly spaceId: bigint;
  readonly title: string;
  readonly protectionLevel: string;
  readonly status: string;
  readonly createdBy?: bigint | null;
  readonly ownerProfileId?: bigint | null;
}

export interface WikiPermissionRevision {
  readonly id?: bigint;
  readonly visibility: string;
}

export interface WikiPermissionThread {
  readonly id: bigint;
  readonly pageId: bigint;
  readonly status: string;
}

export interface WikiPermissionDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

export interface WikiPublishedRevisionScope {
  readonly serverWikiId: bigint;
  readonly spaceId: bigint;
  readonly currentReleaseId: bigint;
  readonly currentReleaseVersion: number;
  readonly currentReleaseSnapshotVersion: number;
  readonly currentItem: ServerWikiReleaseItem;
  /** One item per published revision, pinned to its latest eligible release snapshot. */
  readonly revisionItems: readonly ServerWikiReleaseItem[];
}

export type WikiPublishedPageBoundary = Omit<WikiPublishedRevisionScope, 'revisionItems'>;

export interface WikiPublishedRevisionProof {
  readonly boundary: WikiPublishedPageBoundary;
  readonly item: ServerWikiReleaseItem;
}

export interface WikiSectionLockPolicy {
  readonly lockType: string;
  readonly ownerGroup?: string | null;
}

const EDITOR_ROLES = new Set(['owner', 'manager', 'editor', 'maintainer', 'trusted']);
const OWNER_ROLES = new Set(['owner', 'manager', 'maintainer']);
const REVIEWER_ROLES = new Set(['reviewer']);
const PUBLICATION_PREVIEW_ROLES = new Set([...EDITOR_ROLES, ...REVIEWER_ROLES]);
const PUBLIC_REVISION_VISIBILITIES = new Set(['public']);
const ACTIVE_SPACE_STATUSES = new Set(['active']);
const ACTIVE_PROFILE_STATUSES = new Set(['active']);
const ACTIVE_ACCOUNT_STATUSES = new Set(['active']);
const MAX_CANONICAL_ACCOUNT_DEPTH = 16;
const RESTRICTED_CREATE_NAMESPACES = new Set(['dev', 'help', 'project', 'template', 'category', 'file']);
const PUBLIC_READ_PROTECTION_LEVELS = new Set([
  'open',
  'login_required',
  'review_required',
  'autoconfirmed_only',
  'trusted_only',
  'official_only',
  'owner_only',
  'admin_only',
  'locked'
]);

@Injectable()
export class WikiPermissionService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly wikiAcl?: WikiAclService
  ) {}

  async resolveActor(accountId: string | null | undefined, store: WikiPermissionStore = this.prisma) {
    if (!accountId) {
      return null;
    }
    const profile = await store.wikiProfile.findUnique({
      where: { accountId },
      select: { id: true, status: true }
    });
    if (!profile) {
      return null;
    }
    return {
      accountId,
      profileId: profile.id,
      status: profile.status
    };
  }

  async assertCanReadPage(input: {
    readonly accountId?: string | null;
    readonly actor?: WikiPermissionActor | null;
    readonly page: WikiPermissionPage | null;
    readonly revision?: WikiPermissionRevision | null;
    readonly store?: WikiPermissionStore;
    readonly requestIp?: string | null;
    readonly publicationProof?: WikiPublishedRevisionProof;
  }): Promise<void> {
    const decision = await this.canReadPage(input);
    if (!decision.allowed) {
      throw new NotFoundException('Wiki page not found.');
    }
  }

  async filterReadablePages<T extends WikiPermissionPage>(input: {
    readonly accountId?: string | null;
    readonly actor?: WikiPermissionActor | null;
    readonly pages: readonly T[];
    readonly store?: WikiPermissionStore;
    /** Explicit ACL address context. An empty string represents a neutral public actor. */
    readonly requestIp?: string | null;
  }): Promise<T[]> {
    if (input.pages.length === 0) return [];
    const store = input.store ?? this.prisma;
    const spaceIds = [...new Set(input.pages.map((page) => page.spaceId))];
    const spaces = await store.wikiSpace.findMany({
      where: { id: { in: spaceIds } },
      select: { id: true, status: true, spaceType: true, rootPageId: true, rootNamespaceCode: true }
    });
    const activeSpaceIds = new Set(spaces
      .filter((space) => ACTIVE_SPACE_STATUSES.has(space.status))
      .map((space) => space.id));
    const actor = input.actor === undefined ? await this.resolveActor(input.accountId, store) : input.actor;
    const serverSpaceIds = spaces
      .filter((space) => space.spaceType === 'server_wiki')
      .map((space) => space.id);
    const serverWikis = serverSpaceIds.length > 0
      ? await store.serverWiki.findMany({
          where: { spaceId: { in: serverSpaceIds } },
          select: {
            id: true,
            spaceId: true,
            voteServerId: true,
            slug: true,
            status: true,
            publicationStatus: true,
            publishedReleaseId: true,
            serverName: true,
            host: true
          }
        })
      : [];
    const linkedServerIds = serverWikis.flatMap((wiki) => wiki.voteServerId ? [wiki.voteServerId] : []);
    const linkedServers = linkedServerIds.length > 0
      ? await store.server.findMany({
          where: { id: { in: linkedServerIds } },
          select: {
            id: true,
            listingStatus: true,
            wikiSpaceId: true,
            wikiPageId: true,
            wikiSlug: true,
            name: true,
            joinHost: true
          }
        })
      : [];
    const linkedServerById = new Map(linkedServers.map((server) => [server.id, server]));
    const spaceById = new Map(spaces.map((space) => [space.id, space]));
    const publicServerSpaceIds = new Set(serverWikis
      .filter((wiki) => {
        const space = spaceById.get(wiki.spaceId);
        return Boolean(wiki.publishedReleaseId !== null && space && hasCanonicalPublicServerWikiParent({
          space,
          wiki,
          server: wiki.voteServerId ? linkedServerById.get(wiki.voteServerId) : null
        }));
      })
      .map((wiki) => wiki.spaceId));
    const previewServerSpaceIds = new Set<bigint>();
    if (actor) {
      for (const spaceId of serverSpaceIds) {
        const space = spaceById.get(spaceId);
        if (space && await this.canPreviewServerWikiPublication(store, actor, space)) {
          previewServerSpaceIds.add(spaceId);
        }
      }
    }
    const releaseWikis = serverWikis.filter((wiki) => wiki.publishedReleaseId !== null
      && publicServerSpaceIds.has(wiki.spaceId));
    const releasedItems = releaseWikis.length > 0
      ? await store.serverWikiReleaseItem.findMany({
          where: {
            OR: releaseWikis.map((wiki) => ({
              releaseId: wiki.publishedReleaseId!,
              serverWikiId: wiki.id,
              spaceId: wiki.spaceId,
            })),
            pageId: { in: input.pages.map((page) => page.id) },
          },
          select: { spaceId: true, pageId: true },
        })
      : [];
    const releasedPageKeys = new Set(releasedItems.map((item) => `${item.spaceId}:${item.pageId}`));
    const isPublicSpace = (page: WikiPermissionPage) => {
      const space = spaceById.get(page.spaceId);
      return space?.spaceType !== 'server_wiki'
        || previewServerSpaceIds.has(page.spaceId)
        || (publicServerSpaceIds.has(page.spaceId) && releasedPageKeys.has(`${page.spaceId}:${page.id}`));
    };
    const normalCandidates = input.pages.filter((page) =>
      activeSpaceIds.has(page.spaceId) &&
      isPublicSpace(page) &&
      isPublicWikiPageStatus(page.status) &&
      PUBLIC_READ_PROTECTION_LEVELS.has(page.protectionLevel)
    );
    const aclDecisions = this.wikiAcl
      ? await this.wikiAcl.evaluateReadBatch({
          actor,
          resources: normalCandidates.map((page) => ({
            pageId: page.id,
            spaceId: page.spaceId,
            namespaceId: page.namespaceId,
            title: page.title,
            createdBy: page.createdBy
          })),
          store,
          requestIp: input.requestIp
        })
      : new Map<bigint, WikiAclDecision>();
    const readableIds = new Set(normalCandidates
      .filter((page) => {
        const acl = aclDecisions.get(page.id);
        return !acl?.matched || acl.allowed;
      })
      .map((page) => page.id));
    const unusual = input.pages.filter((page) =>
      activeSpaceIds.has(page.spaceId) &&
      isPublicWikiPageStatus(page.status) &&
      (!PUBLIC_READ_PROTECTION_LEVELS.has(page.protectionLevel) || !isPublicSpace(page))
    );
    for (const page of unusual) {
      const decision = await this.canReadPage({
        accountId: input.accountId,
        actor,
        page,
        store,
        requestIp: input.requestIp
      });
      if (decision.allowed) readableIds.add(page.id);
    }
    return input.pages.filter((page) => readableIds.has(page.id));
  }

  async assertCanReadSpace(input: {
    readonly accountId?: string | null;
    readonly actor?: WikiPermissionActor | null;
    readonly requestIp?: string | null;
    readonly spaceId: bigint;
    readonly store?: WikiPermissionStore;
  }): Promise<void> {
    const store = input.store ?? this.prisma;
    const space = await store.wikiSpace.findUnique({ where: { id: input.spaceId } });
    if (!space || !ACTIVE_SPACE_STATUSES.has(space.status)) {
      throw new NotFoundException('Wiki space not found.');
    }
    const actor = input.actor ?? await this.resolveActor(input.accountId, store);
    if (!(await this.canReadServerWikiPublication(store, actor, space))) {
      throw new NotFoundException('Wiki space not found.');
    }
    const acl = await this.evaluateAcl('read', actor, {
      spaceId: space.id,
      namespaceCode: space.rootNamespaceCode,
      title: space.title,
      createdBy: space.createdBy
    }, store, input.requestIp);
    if (acl.matched && !acl.allowed) {
      throw new NotFoundException('Wiki space not found.');
    }
  }

  async assertCanReadCreateTarget(input: {
    readonly accountId?: string | null;
    readonly actor?: WikiPermissionActor | null;
    readonly namespaceId: number;
    readonly namespaceCode: string;
    readonly spaceId: bigint;
    readonly title: string;
    readonly store?: WikiPermissionStore;
  }): Promise<void> {
    const store = input.store ?? this.prisma;
    const space = await store.wikiSpace.findUnique({
      where: { id: input.spaceId },
      select: { id: true, status: true }
    });
    if (!space || !ACTIVE_SPACE_STATUSES.has(space.status)) throw new NotFoundException('Wiki space not found.');
    const actor = input.actor === undefined ? await this.resolveActor(input.accountId, store) : input.actor;
    const acl = await this.evaluateAcl('read', actor, {
      namespaceId: input.namespaceId,
      namespaceCode: input.namespaceCode,
      spaceId: input.spaceId,
      title: input.title
    }, store);
    if (acl.matched && !acl.allowed) throw new NotFoundException('Wiki page not found.');
  }

  async assertCanUseCreateTargetAction(input: {
    readonly accountId?: string | null;
    readonly actor?: WikiPermissionActor | null;
    readonly action: Extract<WikiAclAction, 'edit_request'>;
    readonly namespaceId: number;
    readonly namespaceCode: string;
    readonly spaceId: bigint;
    readonly title: string;
    readonly store?: WikiPermissionStore;
  }): Promise<void> {
    const store = input.store ?? this.prisma;
    const actor = input.actor === undefined ? await this.resolveActor(input.accountId, store) : input.actor;
    if (!actor || !ACTIVE_PROFILE_STATUSES.has(actor.status)) {
      throw new ForbiddenException('Wiki edit request is not allowed.');
    }
    await this.assertCanReadCreateTarget({ ...input, actor, store });
    const acl = await this.evaluateAcl(input.action, actor, {
      namespaceId: input.namespaceId,
      namespaceCode: input.namespaceCode,
      spaceId: input.spaceId,
      title: input.title
    }, store);
    if (acl.matched && !acl.allowed) {
      throw new ForbiddenException(`Wiki edit request is not allowed: ${acl.reason}`);
    }
  }

  async canReadPage(input: {
    readonly accountId?: string | null;
    readonly actor?: WikiPermissionActor | null;
    readonly page: WikiPermissionPage | null;
    readonly revision?: WikiPermissionRevision | null;
    readonly store?: WikiPermissionStore;
    readonly requestIp?: string | null;
    readonly publicationProof?: WikiPublishedRevisionProof;
  }): Promise<WikiPermissionDecision> {
    const store = input.store ?? this.prisma;
    const page = input.page;
    if (!page) {
      return deny('page_missing');
    }
    const space = await store.wikiSpace.findUnique({
      where: { id: page.spaceId },
      select: { id: true, status: true, spaceType: true, rootPageId: true }
    });
    if (!space || !ACTIVE_SPACE_STATUSES.has(space.status)) {
      return deny('space_not_active');
    }
    if (!isPublicWikiPageStatus(page.status)) {
      return deny('page_not_public');
    }
    if (input.revision && !PUBLIC_REVISION_VISIBILITIES.has(input.revision.visibility)) {
      return deny('revision_not_public');
    }
    const actor = input.actor === undefined ? await this.resolveActor(input.accountId, store) : input.actor;
    const publicationProof = input.publicationProof;
    const hasMatchingPublicationProof = Boolean(publicationProof
      && publicationProof.boundary.spaceId === page.spaceId
      && publicationProof.item.serverWikiId === publicationProof.boundary.serverWikiId
      && publicationProof.item.spaceId === page.spaceId
      && publicationProof.item.pageId === page.id
      && (input.revision?.id === undefined || publicationProof.item.revisionId === input.revision.id));
    if (hasMatchingPublicationProof
      && publicationProof?.boundary.currentReleaseSnapshotVersion >= 2
      && publicationProof.item.releaseId === publicationProof.boundary.currentReleaseId
      && publicationProof.item.publicReadAllowed === false) {
      return deny('release_not_public');
    }
    if (!hasMatchingPublicationProof && !(await this.canReadServerWikiPublication(store, actor, space))) {
      return deny('server_wiki_not_published');
    }
    if (space.spaceType === 'server_wiki'
      && !hasMatchingPublicationProof
      && !(await this.canPreviewServerWikiPublication(store, actor, space))
      && !(await this.isReleasedServerWikiPage(store, actor, page, input.revision))) {
      return deny('server_wiki_page_not_released');
    }
    if (!PUBLIC_READ_PROTECTION_LEVELS.has(page.protectionLevel)) {
      if (!actor || !(await this.canManagePageArea(store, actor, page))) {
        return deny('protection_not_readable');
      }
    }
    const acl = await this.evaluateAcl(
      'read',
      actor,
      { pageId: page.id, spaceId: page.spaceId, namespaceId: page.namespaceId, title: page.title, createdBy: page.createdBy },
      store,
      input.requestIp
    );
    if (acl.matched && !acl.allowed) {
      return deny(acl.reason);
    }
    return allow('public_read');
  }

  async canPublishPagePublicly(input: {
    readonly page: WikiPermissionPage | null;
    readonly revision?: WikiPermissionRevision | null;
    readonly store?: WikiPermissionStore;
  }): Promise<WikiPermissionDecision> {
    const store = input.store ?? this.prisma;
    const page = input.page;
    if (!page) return deny('page_missing');
    const space = await store.wikiSpace.findUnique({
      where: { id: page.spaceId },
      select: { id: true, status: true },
    });
    if (!space || !ACTIVE_SPACE_STATUSES.has(space.status)) return deny('space_not_active');
    if (!isPublicWikiPageStatus(page.status)) return deny('page_not_public');
    if (input.revision && !PUBLIC_REVISION_VISIBILITIES.has(input.revision.visibility)) {
      return deny('revision_not_public');
    }
    if (!PUBLIC_READ_PROTECTION_LEVELS.has(page.protectionLevel)) {
      return deny('protection_not_readable');
    }
    const acl = await this.evaluateAcl(
      'read',
      null,
      {
        pageId: page.id,
        spaceId: page.spaceId,
        namespaceId: page.namespaceId,
        title: page.title,
        createdBy: page.createdBy,
      },
      store,
    );
    return acl.matched && !acl.allowed ? deny(acl.reason) : allow('public_read');
  }

  async assertCanEditPage(input: {
    readonly actor: WikiPermissionActor | null;
    readonly page: WikiPermissionPage | null;
    readonly store?: WikiPermissionStore;
  }): Promise<void> {
    const decision = await this.canEditPage(input);
    if (!decision.allowed) {
      throw new ForbiddenException('Wiki page edit is not allowed.');
    }
  }

  async canEditPage(input: {
    readonly actor: WikiPermissionActor | null;
    readonly page: WikiPermissionPage | null;
    readonly store?: WikiPermissionStore;
  }): Promise<WikiPermissionDecision> {
    const store = input.store ?? this.prisma;
    const actor = input.actor;
    const page = input.page;
    if (!actor) {
      return deny('actor_required');
    }
    if (!ACTIVE_PROFILE_STATUSES.has(actor.status)) {
      return deny('actor_not_active');
    }
    if (!page) {
      return deny('page_missing');
    }
    const space = await store.wikiSpace.findUnique({
      where: { id: page.spaceId },
      select: { id: true, status: true, spaceType: true, rootPageId: true, ownerUserId: true }
    });
    if (!space || !ACTIVE_SPACE_STATUSES.has(space.status)) {
      return deny('space_not_active');
    }
    if (!isPublicWikiPageStatus(page.status)) {
      return deny('page_not_editable');
    }
    const protectionLevel = page.protectionLevel || 'open';
    if (this.isAdminActor(actor)) {
      return allow('admin_edit');
    }
    const linkedServerAuthority = space.spaceType === 'server_wiki'
      ? await this.linkedServerWikiAuthority(store, actor, page.spaceId, space)
      : null;
    let isUserDocumentOwner = false;
    if (linkedServerAuthority === null && page.ownerProfileId !== null && page.ownerProfileId !== undefined) {
      if (page.ownerProfileId !== actor.profileId) return deny('user_document_owner_required');
      isUserDocumentOwner = true;
    }
    const acl = await this.evaluateAcl('edit', actor, { pageId: page.id, spaceId: page.spaceId, namespaceId: page.namespaceId, title: page.title, createdBy: page.createdBy }, store);
    if (acl.matched) {
      return acl.allowed ? allow(acl.reason) : deny(acl.reason);
    }
    if (protectionLevel === 'open' || protectionLevel === 'login_required' || protectionLevel === 'review_required') {
      return allow(isUserDocumentOwner ? 'user_document_owner_edit' : 'open_edit');
    }
    if (protectionLevel === 'autoconfirmed_only' || protectionLevel === 'trusted_only') {
      return isUserDocumentOwner ||
        (linkedServerAuthority?.state === 'consistent'
          ? linkedServerAuthority.isOwner ||
            (await this.hasAnySubwikiRole(store, actor.profileId, page.spaceId, EDITOR_ROLES))
          : linkedServerAuthority?.state === 'inconsistent'
            ? false
            : (await this.hasAnySubwikiRole(store, actor.profileId, page.spaceId, EDITOR_ROLES)) ||
              space.ownerUserId === actor.profileId)
        ? allow(isUserDocumentOwner ? 'user_document_owner_edit' : 'trusted_edit')
        : deny('trusted_required');
    }
    if (protectionLevel === 'owner_only' || protectionLevel === 'official_only') {
      const canManage = linkedServerAuthority?.state === 'consistent'
        ? linkedServerAuthority.isOwner ||
          await this.hasAnySubwikiRole(store, actor.profileId, page.spaceId, OWNER_ROLES)
        : linkedServerAuthority?.state === 'inconsistent'
          ? false
          : await this.canManagePageArea(store, actor, page);
      return canManage
        ? allow('owner_edit')
        : deny('owner_required');
    }
    if (protectionLevel === 'locked' && actor.permissions?.includes('wiki.edit.locked') === true) {
      return allow('locked_editor');
    }
    if (protectionLevel === 'admin_only' || protectionLevel === 'locked') {
      return deny('admin_required');
    }
    return deny('unknown_protection_level');
  }

  async assertCanCreatePage(input: {
    readonly actor: WikiPermissionActor | null;
    readonly namespaceCode: string;
    readonly spaceId: bigint;
    readonly title: string;
    readonly pageType?: string | null;
    readonly store?: WikiPermissionStore;
  }): Promise<void> {
    const decision = await this.canCreatePage(input);
    if (!decision.allowed) {
      throw new ForbiddenException(`Wiki page creation is not allowed: ${decision.reason}`);
    }
  }

  async canCreatePage(input: {
    readonly actor: WikiPermissionActor | null;
    readonly namespaceCode: string;
    readonly spaceId: bigint;
    readonly title: string;
    readonly pageType?: string | null;
    readonly store?: WikiPermissionStore;
  }): Promise<WikiPermissionDecision> {
    const store = input.store ?? this.prisma;
    const actor = input.actor;
    if (!actor) {
      return deny('actor_required');
    }
    if (!ACTIVE_PROFILE_STATUSES.has(actor.status)) {
      return deny('actor_not_active');
    }
    if (input.namespaceCode === 'user') {
      const owner = await this.resolveUserDocumentOwner(store, input.title);
      if (!owner) return deny('user_document_owner_missing');
      if (this.isAdminActor(actor)) return allow('admin_user_document_create');
      if (owner.id !== actor.profileId) return deny('user_document_owner_required');
      const space = await store.wikiSpace.findUnique({
        where: { id: input.spaceId },
        select: { id: true, status: true }
      });
      if (!space || !ACTIVE_SPACE_STATUSES.has(space.status)) return deny('space_not_active');
      const acl = await this.evaluateAcl('create', actor, {
        spaceId: input.spaceId,
        namespaceCode: input.namespaceCode,
        title: input.title
      }, store);
      if (acl.matched) return acl.allowed ? allow(acl.reason) : deny(acl.reason);
      return allow('user_document_owner_create');
    }
    if (this.isAdminActor(actor)) {
      return allow('admin_create');
    }
    const space = await store.wikiSpace.findUnique({
      where: { id: input.spaceId },
      select: { id: true, status: true, spaceType: true, rootPageId: true, ownerUserId: true, createdBy: true }
    });
    if (!space || !ACTIVE_SPACE_STATUSES.has(space.status)) {
      return deny('space_not_active');
    }
    const acl = await this.evaluateAcl('create', actor, {
      spaceId: input.spaceId,
      namespaceCode: input.namespaceCode,
      title: input.title
    }, store);
    if (acl.matched) {
      return acl.allowed ? allow(acl.reason) : deny(acl.reason);
    }
    if (RESTRICTED_CREATE_NAMESPACES.has(input.namespaceCode)) {
      return deny('restricted_namespace');
    }
    if (space.spaceType === 'basic') {
      return allow('basic_create');
    }
    if (space.spaceType === 'server_wiki') {
      const authority = await this.linkedServerWikiAuthority(store, actor, input.spaceId, space);
      if (authority?.state === 'inconsistent') return deny('server_wiki_link_inconsistent');
      if (authority?.state === 'consistent') {
        if (authority.isOwner) return allow('linked_server_owner_create');
        return await this.hasAnySubwikiRole(store, actor.profileId, input.spaceId, EDITOR_ROLES)
          ? allow('server_role_create')
          : deny('server_wiki_role_required');
      }
      if (space.ownerUserId === actor.profileId || space.createdBy === actor.profileId) {
        return allow('server_owner_create');
      }
      if (await this.hasAnySubwikiRole(store, actor.profileId, input.spaceId, EDITOR_ROLES)) {
        return allow('server_role_create');
      }
      const legacyServerWiki = await store.serverWiki.findFirst({
        where: { spaceId: input.spaceId, status: { not: 'deleted' } },
        select: { createdBy: true }
      });
      if (legacyServerWiki?.createdBy === actor.profileId) {
        return allow('server_wiki_creator_create');
      }
      return deny('server_wiki_role_required');
    }
    if (space.spaceType === 'mod_wiki') {
      if (space.ownerUserId === actor.profileId || space.createdBy === actor.profileId) {
        return allow('mod_owner_create');
      }
      if (await this.hasAnySubwikiRole(store, actor.profileId, input.spaceId, EDITOR_ROLES)) {
        return allow('mod_role_create');
      }
      const modWiki = await store.modWiki.findFirst({
        where: {
          spaceId: input.spaceId,
          status: { not: 'deleted' }
        },
        select: { verifiedBy: true }
      });
      return modWiki?.verifiedBy === actor.profileId
        ? allow('mod_verified_create')
        : deny('mod_wiki_role_required');
    }
    return deny('unsupported_space_type');
  }

  actorFromProfile(accountId: string, profile: { id: bigint; status: string }): WikiPermissionActor {
    return {
      accountId,
      profileId: profile.id,
      status: profile.status
    };
  }

  actorFromSession(session: WikiPermissionSession, profile: { id: bigint; status: string }): WikiPermissionActor {
    return {
      accountId: session.userId,
      profileId: profile.id,
      status: profile.status,
      isElevated: session.isElevated,
      permissions: session.permissions,
      groups: session.groups,
      requestIp: session.requestIp
    };
  }

  async assertCanUsePageAction(input: {
    readonly accountId?: string | null;
    readonly actor?: WikiPermissionActor | null;
    readonly requestIp?: string | null;
    readonly action: WikiAclAction;
    readonly page: WikiPermissionPage | null;
    readonly store?: WikiPermissionStore;
    readonly publicationProof?: WikiPublishedRevisionProof;
  }): Promise<void> {
    const decision = await this.canUsePageAction(input);
    if (!decision.allowed) {
      throw new NotFoundException('Wiki page not found.');
    }
  }

  async assertCanMutatePageAction(input: {
    readonly actor: WikiPermissionActor | null;
    readonly action: Extract<WikiAclAction, 'move' | 'delete' | 'revert'>;
    readonly page: WikiPermissionPage | null;
    readonly store?: WikiPermissionStore;
  }): Promise<void> {
    const store = input.store ?? this.prisma;
    await this.assertCanReadPage({
      actor: input.actor,
      page: input.page,
      store
    });
    await this.assertCanEditPage({
      actor: input.actor,
      page: input.page,
      store
    });
    if (!input.actor || !input.page) {
      throw new ForbiddenException('Wiki page action is not allowed.');
    }
    const acl = await this.evaluateAcl(input.action, input.actor, {
      pageId: input.page.id,
      spaceId: input.page.spaceId,
      namespaceId: input.page.namespaceId,
      title: input.page.title,
      createdBy: input.page.createdBy
    }, store);
    if (acl.matched) {
      if (!acl.allowed) {
        throw new ForbiddenException(`Wiki page action is not allowed: ${acl.reason}`);
      }
      return;
    }
    if (input.action !== 'revert' && !(await this.canManagePageArea(store, input.actor, input.page))) {
      throw new ForbiddenException('Wiki page action requires a page or space manager.');
    }
  }

  async assertCanRestorePage(input: {
    readonly actor: WikiPermissionActor | null;
    readonly page: WikiPermissionPage | null;
    readonly store?: WikiPermissionStore;
  }): Promise<void> {
    const store = input.store ?? this.prisma;
    const { actor, page } = input;
    if (!actor || !ACTIVE_PROFILE_STATUSES.has(actor.status) || !page || page.status !== 'deleted') {
      throw new ForbiddenException('Wiki page restore is not allowed.');
    }
    if (page.ownerProfileId !== null && page.ownerProfileId !== undefined) {
      if (!this.isAdminActor(actor) && page.ownerProfileId !== actor.profileId) {
        throw new ForbiddenException('Wiki page restore is not allowed.');
      }
    } else if (!(await this.canManagePageArea(store, actor, page))) {
      throw new ForbiddenException('Wiki page restore is not allowed.');
    }
    const acl = await this.evaluateAcl('delete', actor, {
      pageId: page.id,
      spaceId: page.spaceId,
      namespaceId: page.namespaceId,
      title: page.title,
      createdBy: page.createdBy
    }, store);
    if (acl.matched && !acl.allowed) {
      throw new ForbiddenException(`Wiki page restore is not allowed: ${acl.reason}`);
    }
  }

  async assertCanDiscussPage(input: {
    readonly actor: WikiPermissionActor | null;
    readonly page: WikiPermissionPage | null;
    readonly store?: WikiPermissionStore;
  }): Promise<void> {
    return this.assertCanWriteThreadComment(input);
  }

  async assertCanCreateThread(input: {
    readonly actor: WikiPermissionActor | null;
    readonly page: WikiPermissionPage | null;
    readonly requestIp?: string | null;
    readonly store?: WikiPermissionStore;
  }): Promise<void> {
    await this.assertCanUseDiscussionAction(input, 'write_thread_comment');
    return this.assertCanUseDiscussionAction(input, 'create_thread');
  }

  async assertCanWriteThreadComment(input: {
    readonly actor: WikiPermissionActor | null;
    readonly page: WikiPermissionPage | null;
    readonly threadId?: bigint | null;
    readonly requestIp?: string | null;
    readonly store?: WikiPermissionStore;
  }): Promise<void> {
    return this.assertCanUseDiscussionAction(input, 'write_thread_comment');
  }

  async assertCanReadThread(input: {
    readonly accountId?: string | null;
    readonly actor?: WikiPermissionActor | null;
    readonly thread: WikiPermissionThread | null;
    readonly page: WikiPermissionPage | null;
    readonly requestIp?: string | null;
    readonly store?: WikiPermissionStore;
  }): Promise<void> {
    const decision = await this.canReadThread(input);
    if (!decision.allowed) throw new NotFoundException('Wiki discussion thread not found.');
  }

  async canReadThread(input: {
    readonly accountId?: string | null;
    readonly actor?: WikiPermissionActor | null;
    readonly thread: WikiPermissionThread | null;
    readonly page: WikiPermissionPage | null;
    readonly requestIp?: string | null;
    readonly store?: WikiPermissionStore;
  }): Promise<WikiPermissionDecision> {
    if (!input.thread || !input.page || input.thread.pageId !== input.page.id || input.thread.status === 'deleted') {
      return deny('thread_missing');
    }
    const rows = await this.filterReadableThreads({
      accountId: input.accountId,
      actor: input.actor,
      items: [{ thread: input.thread, page: input.page }],
      store: input.store,
      requestIp: input.requestIp,
    });
    return rows.length === 1 ? allow('thread_read') : deny('thread_not_readable');
  }

  async filterReadableThreads<T extends { readonly thread: WikiPermissionThread; readonly page: WikiPermissionPage }>(input: {
    readonly accountId?: string | null;
    readonly actor?: WikiPermissionActor | null;
    readonly items: readonly T[];
    readonly requestIp?: string | null;
    readonly store?: WikiPermissionStore;
  }): Promise<T[]> {
    if (input.items.length === 0) return [];
    const store = input.store ?? this.prisma;
    const pages = [...new Map(input.items.map((item) => [item.page.id, item.page])).values()];
    const readablePages = await this.filterReadablePages({ accountId: input.accountId, actor: input.actor, pages, store, requestIp: input.requestIp });
    const readablePageIds = new Set(readablePages.map((page) => page.id));
    const candidates = input.items.filter((item) =>
      item.thread.status !== 'deleted' && item.thread.pageId === item.page.id && readablePageIds.has(item.page.id)
    );
    if (candidates.length === 0) return [];
    const actor = input.actor === undefined
      ? await this.resolveActor(input.accountId, store)
      : input.actor;
    const recoverySpaceIds = actor
      ? await this.threadAclRecoverySpaceIds(store, actor, candidates.map((item) => item.page.spaceId))
      : new Set<bigint>();
    const decisions = await this.evaluateThreadAclBatch('read', actor ?? null, candidates, store, input.requestIp);
    return candidates.filter((item) => {
      if (recoverySpaceIds.has(item.page.spaceId)) return true;
      const decision = decisions.get(item.thread.id);
      return !decision?.matched || decision.allowed;
    });
  }

  async canManageThreadAcl(input: {
    readonly actor: WikiPermissionActor | null;
    readonly thread: WikiPermissionThread | null;
    readonly page: WikiPermissionPage | null;
    readonly store?: WikiPermissionStore;
  }): Promise<WikiPermissionDecision> {
    const store = input.store ?? this.prisma;
    const { actor, thread, page } = input;
    if (!actor) return deny('actor_required');
    if (!ACTIVE_PROFILE_STATUSES.has(actor.status)) return deny('actor_not_active');
    if (!thread || thread.status === 'deleted' || !page || thread.pageId !== page.id) return deny('thread_missing');
    const pageRead = await this.canReadPage({ accountId: actor.accountId, actor, page, store });
    if (!pageRead.allowed) return deny(pageRead.reason);
    const recoverable = await this.threadAclRecoverySpaceIds(store, actor, [page.spaceId]);
    if (recoverable.has(page.spaceId)) return allow('thread_acl_recovery_owner');
    const pageAcl = await this.canManagePageAcl({ actor, page, store });
    return pageAcl.allowed ? allow(`thread_acl_${pageAcl.reason}`) : deny(pageAcl.reason);
  }

  async assertCanManageThreadAcl(input: {
    readonly actor: WikiPermissionActor | null;
    readonly thread: WikiPermissionThread | null;
    readonly page: WikiPermissionPage | null;
    readonly store?: WikiPermissionStore;
  }): Promise<void> {
    const decision = await this.canManageThreadAcl(input);
    if (!decision.allowed) throw new ForbiddenException(`Wiki discussion ACL management is not allowed: ${decision.reason}`);
  }

  private async assertCanUseDiscussionAction(input: {
    readonly actor: WikiPermissionActor | null;
    readonly page: WikiPermissionPage | null;
    readonly threadId?: bigint | null;
    readonly requestIp?: string | null;
    readonly store?: WikiPermissionStore;
  }, action: Extract<WikiAclAction, 'create_thread' | 'write_thread_comment'>): Promise<void> {
    const store = input.store ?? this.prisma;
    const { actor, page } = input;
    if (!page || (actor && !ACTIVE_PROFILE_STATUSES.has(actor.status))) {
      throw new ForbiddenException('Wiki discussion is not allowed.');
    }
    await this.assertCanReadPage({ accountId: actor?.accountId ?? null, actor, page, store, requestIp: input.requestIp });
    const resource = {
      pageId: page.id,
      spaceId: page.spaceId,
      namespaceId: page.namespaceId,
      title: page.title,
      createdBy: page.createdBy
    };
    if (action === 'write_thread_comment' && input.threadId) {
      const recoverySpaceIds = actor ? await this.threadAclRecoverySpaceIds(store, actor, [page.spaceId]) : new Set<bigint>();
      if (actor && recoverySpaceIds.has(page.spaceId)) return;
      const decisions = await this.evaluateThreadAclBatch(action, actor, [{
        thread: { id: input.threadId, pageId: page.id, status: 'open' },
        page
      }], store, input.requestIp);
      const threadAcl = decisions.get(input.threadId);
      if (threadAcl?.matched) {
        if (!threadAcl.allowed) throw new ForbiddenException(`Wiki discussion is not allowed: ${threadAcl.reason}`);
        return;
      }
    }
    let acl = await this.evaluateAcl(action, actor, resource, store, input.requestIp);
    if (!acl.matched) {
      acl = await this.evaluateAcl('discuss', actor, resource, store, input.requestIp);
    }
    if ((!actor && (!acl.matched || !acl.allowed)) || (acl.matched && !acl.allowed)) {
      throw new ForbiddenException(`Wiki discussion is not allowed: ${acl.reason}`);
    }
  }

  async canManagePage(input: {
    readonly actor: WikiPermissionActor | null;
    readonly page: WikiPermissionPage | null;
    readonly store?: WikiPermissionStore;
  }): Promise<boolean> {
    if (!input.actor || !input.page || !ACTIVE_PROFILE_STATUSES.has(input.actor.status)) return false;
    return this.canManagePageArea(input.store ?? this.prisma, input.actor, input.page);
  }

  async canReviewPage(input: {
    readonly actor: WikiPermissionActor | null;
    readonly page: WikiPermissionPage | null;
    readonly store?: WikiPermissionStore;
  }): Promise<boolean> {
    if (!input.actor || !input.page || !ACTIVE_PROFILE_STATUSES.has(input.actor.status)) return false;
    const store = input.store ?? this.prisma;
    if (await this.canManagePageArea(store, input.actor, input.page)) return true;
    return this.hasAnySubwikiRole(store, input.actor.profileId, input.page.spaceId, REVIEWER_ROLES);
  }

  async canModeratePage(input: {
    readonly actor: WikiPermissionActor | null;
    readonly page: WikiPermissionPage | null;
    readonly store?: WikiPermissionStore;
  }): Promise<boolean> {
    return this.canReviewPage(input);
  }

  async canManageSpace(input: {
    readonly actor: WikiPermissionActor | null;
    readonly spaceId: bigint;
    readonly store?: WikiPermissionStore;
  }): Promise<boolean> {
    const store = input.store ?? this.prisma;
    const actor = input.actor;
    if (!actor || !ACTIVE_PROFILE_STATUSES.has(actor.status)) return false;
    const space = await store.wikiSpace.findUnique({
      where: { id: input.spaceId },
      select: { id: true, status: true, spaceType: true, rootPageId: true, ownerUserId: true, createdBy: true }
    });
    if (!space || !ACTIVE_SPACE_STATUSES.has(space.status)) return false;
    if (space.spaceType === 'server_wiki') {
      const authority = await this.linkedServerWikiAuthority(store, actor, input.spaceId, space);
      if (authority?.state === 'inconsistent') return false;
      if (authority?.state === 'consistent') {
        return authority.isOwner || this.hasAnySubwikiRole(store, actor.profileId, input.spaceId, OWNER_ROLES);
      }
    }
    if (space.ownerUserId === actor.profileId || space.createdBy === actor.profileId) return true;
    return this.canManagePageArea(store, actor, {
      id: 0n,
      spaceId: space.id,
      title: '',
      protectionLevel: 'open',
      status: 'normal',
      createdBy: null
    });
  }

  async canManageCreateTarget(input: {
    readonly actor: WikiPermissionActor | null;
    readonly namespaceId: number;
    readonly namespaceCode: string;
    readonly spaceId: bigint;
    readonly title: string;
    readonly store?: WikiPermissionStore;
  }): Promise<boolean> {
    const store = input.store ?? this.prisma;
    if (!input.actor || !ACTIVE_PROFILE_STATUSES.has(input.actor.status)) return false;
    if (this.isAdminActor(input.actor)) return true;
    if (input.namespaceCode === 'user') {
      const owner = await this.resolveUserDocumentOwner(store, input.title);
      if (!owner || owner.id !== input.actor.profileId) return false;
      const space = await store.wikiSpace.findUnique({
        where: { id: input.spaceId },
        select: { id: true, status: true }
      });
      return Boolean(space && ACTIVE_SPACE_STATUSES.has(space.status));
    }
    const space = await store.wikiSpace.findUnique({
      where: { id: input.spaceId },
      select: { id: true, status: true, spaceType: true, rootPageId: true, ownerUserId: true, createdBy: true }
    });
    if (!space || !ACTIVE_SPACE_STATUSES.has(space.status)) return false;
    if (space.spaceType === 'server_wiki') {
      const authority = await this.linkedServerWikiAuthority(store, input.actor, input.spaceId, space);
      if (authority?.state === 'inconsistent') return false;
      if (authority?.state === 'consistent') {
        return authority.isOwner ||
          this.hasAnySubwikiRole(store, input.actor.profileId, input.spaceId, OWNER_ROLES);
      }
    }
    if (space.ownerUserId === input.actor.profileId || space.createdBy === input.actor.profileId) return true;
    return this.canManagePageArea(store, input.actor, {
      id: 0n,
      namespaceId: input.namespaceId,
      spaceId: input.spaceId,
      title: input.title,
      protectionLevel: 'open',
      status: 'normal',
      createdBy: null
    });
  }

  async canReviewCreateTarget(input: {
    readonly actor: WikiPermissionActor | null;
    readonly namespaceId: number;
    readonly namespaceCode: string;
    readonly spaceId: bigint;
    readonly title: string;
    readonly store?: WikiPermissionStore;
  }): Promise<boolean> {
    const store = input.store ?? this.prisma;
    if (await this.canManageCreateTarget({ ...input, store })) return true;
    if (!input.actor || !ACTIVE_PROFILE_STATUSES.has(input.actor.status) || input.namespaceCode === 'user') return false;
    const space = await store.wikiSpace.findUnique({
      where: { id: input.spaceId },
      select: { id: true, status: true }
    });
    if (!space || !ACTIVE_SPACE_STATUSES.has(space.status)) return false;
    return this.hasAnySubwikiRole(store, input.actor.profileId, input.spaceId, REVIEWER_ROLES);
  }

  async assertCanManagePageAcl(input: {
    readonly actor: WikiPermissionActor | null;
    readonly page: WikiPermissionPage | null;
    readonly store?: WikiPermissionStore;
  }): Promise<void> {
    const decision = await this.canManagePageAcl(input);
    if (!decision.allowed) {
      throw new ForbiddenException(`Wiki page ACL management is not allowed: ${decision.reason}`);
    }
  }

  async canManagePageAcl(input: {
    readonly actor: WikiPermissionActor | null;
    readonly page: WikiPermissionPage | null;
    readonly store?: WikiPermissionStore;
  }): Promise<WikiPermissionDecision> {
    const store = input.store ?? this.prisma;
    const { actor, page } = input;
    if (!actor) return deny('actor_required');
    if (!ACTIVE_PROFILE_STATUSES.has(actor.status)) return deny('actor_not_active');
    if (!page || !isPublicWikiPageStatus(page.status)) return deny('page_not_manageable');
    const space = await store.wikiSpace.findUnique({
      where: { id: page.spaceId },
      select: { id: true, status: true }
    });
    if (!space || !ACTIVE_SPACE_STATUSES.has(space.status)) return deny('space_not_active');
    if (this.isAdminActor(actor)) return allow('admin_acl');

    const acl = await this.evaluateAcl('acl', actor, {
      pageId: page.id,
      spaceId: page.spaceId,
      namespaceId: page.namespaceId,
      title: page.title,
      createdBy: page.createdBy
    }, store);
    if (acl.matched) {
      return acl.allowed ? allow(acl.reason) : deny(acl.reason);
    }
    return await this.canManagePageArea(store, actor, page)
      ? allow('page_manager_acl')
      : deny('page_manager_required');
  }

  async canUsePageAction(input: {
    readonly accountId?: string | null;
    readonly actor?: WikiPermissionActor | null;
    readonly requestIp?: string | null;
    readonly action: WikiAclAction;
    readonly page: WikiPermissionPage | null;
    readonly store?: WikiPermissionStore;
    readonly publicationProof?: WikiPublishedRevisionProof;
  }): Promise<WikiPermissionDecision> {
    const store = input.store ?? this.prisma;
    if (!input.page) {
      return deny('page_missing');
    }
    const readDecision = await this.canReadPage({
      accountId: input.accountId,
      actor: input.actor,
      requestIp: input.requestIp,
      page: input.page,
      store,
      publicationProof: input.publicationProof,
    });
    if (!readDecision.allowed) {
      return readDecision;
    }
    const actor = input.actor === undefined ? await this.resolveActor(input.accountId, store) : input.actor;
    const acl = await this.evaluateAcl(input.action, actor, {
      pageId: input.page.id,
      spaceId: input.page.spaceId,
      namespaceId: input.page.namespaceId,
      title: input.page.title,
      createdBy: input.page.createdBy
    }, store, input.requestIp);
    if (acl.matched) {
      return acl.allowed ? allow(acl.reason) : deny(acl.reason);
    }
    return allow('readable_action');
  }

  async canEditSectionLock(input: {
    readonly actor: WikiPermissionActor;
    readonly page: WikiPermissionPage;
    readonly lock: WikiSectionLockPolicy;
    readonly store?: WikiPermissionStore;
  }): Promise<boolean> {
    const store = input.store ?? this.prisma;
    const { actor, page, lock } = input;
    if (this.isAdminActor(actor) ||
        actor.permissions?.includes('page.protect') === true ||
        actor.permissions?.includes('report.handle') === true) {
      return true;
    }
    if (lock.ownerGroup && actor.groups?.includes(lock.ownerGroup)) {
      return true;
    }
    if (lock.lockType === 'trusted_only') {
      return actor.groups?.some((group) =>
        ['trusted', 'moderator', 'admin', 'developer'].includes(group)) === true;
    }
    if (lock.lockType === 'owner_only') {
      return this.canManagePageArea(store, actor, page);
    }
    // admin_only, locked, and unknown legacy values fail closed.
    return false;
  }

  private async canManagePageArea(
    store: WikiPermissionStore,
    actor: WikiPermissionActor,
    page: WikiPermissionPage
  ): Promise<boolean> {
    if (this.isAdminActor(actor)) {
      return true;
    }
    const linkedServerAuthority = await this.linkedServerWikiAuthority(store, actor, page.spaceId);
    if (linkedServerAuthority?.state === 'inconsistent') {
      return false;
    }
    if (linkedServerAuthority?.state === 'consistent') {
      return linkedServerAuthority.isOwner ||
        this.hasAnySubwikiRole(store, actor.profileId, page.spaceId, OWNER_ROLES);
    }
    if (page.ownerProfileId !== null && page.ownerProfileId !== undefined) {
      return page.ownerProfileId === actor.profileId;
    }
    if (page.createdBy === actor.profileId) {
      return true;
    }
    if (await this.hasAnySubwikiRole(store, actor.profileId, page.spaceId, OWNER_ROLES)) {
      return true;
    }
    const serverWiki = await store.serverWiki.findFirst({
      where: { spaceId: page.spaceId, status: { not: 'deleted' } },
      select: { createdBy: true }
    });
    if (serverWiki?.createdBy === actor.profileId) return true;
    const modWiki = await store.modWiki.findFirst({
      where: {
        spaceId: page.spaceId,
        status: { not: 'deleted' }
      },
      select: { verifiedBy: true }
    });
    if (modWiki?.verifiedBy === actor.profileId) {
      return true;
    }
    return false;
  }

  private async canReadServerWikiPublication(
    store: WikiPermissionStore,
    actor: WikiPermissionActor | null,
    space: {
      readonly id: bigint;
      readonly status: string;
      readonly spaceType: string;
      readonly rootPageId?: bigint | null;
    }
  ): Promise<boolean> {
    if (space.spaceType !== 'server_wiki') return true;
    const wikis = await store.serverWiki.findMany({
      where: { spaceId: space.id },
      select: {
        spaceId: true,
        voteServerId: true,
        slug: true,
        status: true,
        publicationStatus: true,
        publishedReleaseId: true,
        serverName: true,
        host: true
      }
    });
    if (wikis.length !== 1 || wikis[0]?.status !== 'active') return false;
    const wiki = wikis[0];
    if (wiki.publicationStatus === 'published' && wiki.publishedReleaseId !== null && wiki.voteServerId) {
      const server = await store.server.findUnique({
        where: { id: wiki.voteServerId },
        select: {
          id: true,
          listingStatus: true,
          wikiSpaceId: true,
          wikiPageId: true,
          wikiSlug: true,
          name: true,
          joinHost: true
        }
      });
      if (hasCanonicalPublicServerWikiParent({ space, wiki, server })) return true;
    }
    return this.canPreviewServerWikiPublication(store, actor, space);
  }

  async canPreviewServerWikiSpace(input: {
    readonly accountId?: string | null;
    readonly actor?: WikiPermissionActor | null;
    readonly spaceId: bigint;
    readonly store?: WikiPermissionStore;
  }): Promise<boolean> {
    const store = input.store ?? this.prisma;
    const space = await store.wikiSpace.findUnique({
      where: { id: input.spaceId },
      select: { id: true, status: true, spaceType: true, rootPageId: true },
    });
    if (!space || !ACTIVE_SPACE_STATUSES.has(space.status) || space.spaceType !== 'server_wiki') {
      return false;
    }
    const actor = input.actor === undefined ? await this.resolveActor(input.accountId, store) : input.actor;
    return this.canPreviewServerWikiPublication(store, actor, space);
  }

  private async canPreviewServerWikiPublication(
    store: WikiPermissionStore,
    actor: WikiPermissionActor | null,
    space: {
      readonly id: bigint;
      readonly status: string;
      readonly spaceType: string;
      readonly rootPageId?: bigint | null;
    },
  ): Promise<boolean> {
    if (!actor || !ACTIVE_PROFILE_STATUSES.has(actor.status)) return false;
    if (this.isAdminActor(actor) || actor.permissions?.includes('server.admin') === true) return true;

    const authority = await this.linkedServerWikiAuthority(store, actor, space.id, space);
    if (authority?.state === 'inconsistent') return false;
    if (authority?.state === 'consistent' && authority.isOwner) return true;
    return this.hasAnySubwikiRole(
      store,
      actor.profileId,
      space.id,
      PUBLICATION_PREVIEW_ROLES
    );
  }

  private async isReleasedServerWikiPage(
    store: WikiPermissionStore,
    actor: WikiPermissionActor | null,
    page: WikiPermissionPage,
    revision?: WikiPermissionRevision | null,
  ): Promise<boolean> {
    try {
      const scope = await this.resolvePublishedRevisionScope({ actor, page, store });
      if (!scope) return true;
      return revision?.id === undefined
        || scope.revisionItems.some((item) => item.revisionId === revision.id);
    } catch {
      return false;
    }
  }

  async resolvePublishedRevisionScope(input: {
    readonly actor?: WikiPermissionActor | null;
    readonly page: WikiPermissionPage;
    readonly store?: WikiPermissionStore;
  }): Promise<WikiPublishedRevisionScope | null> {
    const boundary = await this.resolvePublishedPageBoundary(input);
    if (!boundary) return null;
    const store = input.store ?? this.prisma;
    const releasedItems = await store.serverWikiReleaseItem.findMany({
      where: {
        serverWikiId: boundary.serverWikiId,
        spaceId: boundary.spaceId,
        pageId: input.page.id,
        release: {
          serverWikiId: boundary.serverWikiId,
          version: { lte: boundary.currentReleaseVersion },
        },
      },
      orderBy: [{ release: { version: 'desc' } }],
    });
    const seen = new Set<bigint>();
    const revisionItems = releasedItems.filter((item) => {
      if (seen.has(item.revisionId)) return false;
      seen.add(item.revisionId);
      return true;
    });
    if (!seen.has(boundary.currentItem.revisionId)) revisionItems.unshift(boundary.currentItem);
    return { ...boundary, revisionItems };
  }

  async resolvePublishedPageBoundary(input: {
    readonly actor?: WikiPermissionActor | null;
    readonly page: WikiPermissionPage;
    readonly store?: WikiPermissionStore;
  }): Promise<WikiPublishedPageBoundary | null> {
    const store = input.store ?? this.prisma;
    const space = await store.wikiSpace.findUnique({
      where: { id: input.page.spaceId },
      select: { id: true, status: true, spaceType: true, rootPageId: true },
    });
    if (!space || space.spaceType !== 'server_wiki') return null;
    if (input.actor && await this.canPreviewServerWikiPublication(store, input.actor, space)) return null;
    if (!(await this.canReadServerWikiPublication(store, input.actor ?? null, space))) {
      throw new NotFoundException('Wiki page not found.');
    }
    const wikis = await store.serverWiki.findMany({
      where: { spaceId: space.id },
      select: {
        id: true,
        spaceId: true,
        status: true,
        publicationStatus: true,
        publishedReleaseId: true,
        publishedRelease: { select: { version: true, snapshotVersion: true } },
      },
    });
    const wiki = wikis.length === 1 ? wikis[0] : null;
    if (!wiki || wiki.status !== 'active' || wiki.publicationStatus !== 'published'
      || wiki.publishedReleaseId === null || !wiki.publishedRelease) {
      throw new NotFoundException('Wiki page not found.');
    }
    const currentItem = await store.serverWikiReleaseItem.findFirst({
      where: {
        releaseId: wiki.publishedReleaseId,
        serverWikiId: wiki.id,
        spaceId: wiki.spaceId,
        pageId: input.page.id,
      },
    });
    if (!currentItem) throw new NotFoundException('Wiki page not found.');
    return {
      serverWikiId: wiki.id,
      spaceId: wiki.spaceId,
      currentReleaseId: wiki.publishedReleaseId,
      currentReleaseVersion: wiki.publishedRelease.version,
      currentReleaseSnapshotVersion: wiki.publishedRelease.snapshotVersion,
      currentItem,
    };
  }

  async resolvePublishedRevisionProof(input: {
    readonly boundary: WikiPublishedPageBoundary;
    readonly pageId: bigint;
    readonly revisionId: bigint;
    readonly store?: WikiPermissionStore;
  }): Promise<WikiPublishedRevisionProof> {
    const store = input.store ?? this.prisma;
    const item = await store.serverWikiReleaseItem.findFirst({
      where: {
        serverWikiId: input.boundary.serverWikiId,
        spaceId: input.boundary.spaceId,
        pageId: input.pageId,
        revisionId: input.revisionId,
        release: {
          serverWikiId: input.boundary.serverWikiId,
          version: { lte: input.boundary.currentReleaseVersion },
        },
      },
      orderBy: [{ release: { version: 'desc' } }],
    });
    if (!item) throw new NotFoundException('Wiki revision not found.');
    return { boundary: input.boundary, item };
  }

  /**
   * Returns null for non-server and legacy unlinked spaces. Once an active server wiki is linked,
   * provenance fields stop participating in live authorization and a broken relationship fails closed.
   */
  private async linkedServerWikiAuthority(
    store: WikiPermissionStore,
    actor: WikiPermissionActor,
    spaceId: bigint,
    knownSpace?: {
      readonly id: bigint;
      readonly status: string;
      readonly spaceType: string;
      readonly rootPageId?: bigint | null;
    }
  ): Promise<{ readonly state: 'consistent'; readonly isOwner: boolean } |
    { readonly state: 'inconsistent'; readonly isOwner: false } | null> {
    const space = knownSpace ?? await store.wikiSpace.findUnique({
      where: { id: spaceId },
      select: { id: true, status: true, spaceType: true, rootPageId: true }
    });
    if (!space || space.spaceType !== 'server_wiki') return null;
    if (!ACTIVE_SPACE_STATUSES.has(space.status)) return { state: 'inconsistent', isOwner: false };

    const wikis = await store.serverWiki.findMany({
      where: { spaceId },
      select: {
        id: true,
        spaceId: true,
        voteServerId: true,
        slug: true,
        status: true,
        serverName: true,
        host: true,
      }
    });
    if (wikis.length === 0) return null;
    if (wikis.length !== 1) return { state: 'inconsistent', isOwner: false };
    const wiki = wikis[0];
    if (wiki?.status !== 'active') return { state: 'inconsistent', isOwner: false };
    if (wiki.voteServerId === null) return null;
    if (!wiki?.voteServerId || wiki.spaceId !== space.id) {
      return { state: 'inconsistent', isOwner: false };
    }
    const server = await store.server.findUnique({
      where: { id: wiki.voteServerId },
      select: {
        id: true,
        name: true,
        joinHost: true,
        ownerAccountId: true,
        ownershipChallengeSuspendedAt: true,
        wikiSpaceId: true,
        wikiPageId: true,
        wikiSlug: true,
      }
    });
    if (!server || server.ownershipChallengeSuspendedAt
        || server.wikiSpaceId !== space.id || server.wikiPageId !== space.rootPageId ||
        server.wikiSlug !== wiki.slug || !server.ownerAccountId || serverWikiIdentityConflicts(wiki, server)) {
      return { state: 'inconsistent', isOwner: false };
    }

    const roots = await this.resolveCanonicalActiveAccountRoots(store, [actor.accountId, server.ownerAccountId]);
    const actorRoot = roots.get(actor.accountId) ?? null;
    const ownerRoot = roots.get(server.ownerAccountId) ?? null;
    return {
      state: 'consistent',
      isOwner: actorRoot !== null && ownerRoot !== null && actorRoot === ownerRoot
    };
  }

  private async resolveCanonicalActiveAccountRoots(
    store: WikiPermissionStore,
    seedAccountIds: readonly string[]
  ): Promise<Map<string, string | null>> {
    const seeds = [...new Set(seedAccountIds)];
    const accounts = new Map<string, { readonly id: string; readonly canonicalAccountId: string | null; readonly lifecycleStatus: string }>();
    const attempted = new Set<string>();
    let frontier = seeds;

    for (let depth = 0; depth < MAX_CANONICAL_ACCOUNT_DEPTH && frontier.length > 0; depth += 1) {
      const ids = [...new Set(frontier)].filter((id) => !attempted.has(id));
      if (ids.length === 0) break;
      ids.forEach((id) => attempted.add(id));
      const rows = await store.account.findMany({
        where: { id: { in: ids } },
        select: { id: true, canonicalAccountId: true, lifecycleStatus: true }
      });
      rows.forEach((account) => accounts.set(account.id, account));
      frontier = rows.flatMap((account) =>
        account.canonicalAccountId && account.canonicalAccountId !== account.id
          ? [account.canonicalAccountId]
          : []
      );
    }

    const roots = new Map<string, string | null>();
    for (const seed of seeds) {
      const visited = new Set<string>();
      let current = seed;
      let root: string | null = null;
      for (let depth = 0; depth < MAX_CANONICAL_ACCOUNT_DEPTH; depth += 1) {
        if (visited.has(current)) break;
        visited.add(current);
        const account = accounts.get(current);
        if (!account || !ACTIVE_ACCOUNT_STATUSES.has(account.lifecycleStatus)) break;
        const next = account.canonicalAccountId;
        if (!next || next === account.id) {
          root = account.id;
          break;
        }
        current = next;
      }
      roots.set(seed, root);
    }
    return roots;
  }

  async resolveUserDocumentOwner(
    store: WikiPermissionStore,
    title: string
  ): Promise<{ readonly id: bigint; readonly username: string; readonly isAlias: boolean } | null> {
    const [rawRoot = ''] = title.split('/');
    const root = rawRoot.normalize('NFKC');
    const hasControlCharacter = [...root].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    });
    if (!root || root === '.' || root === '..' || root.includes('\\') || hasControlCharacter) return null;
    let profile = await store.wikiProfile.findUnique({
      where: { username: root },
      select: { id: true, username: true, status: true }
    });
    let isAlias = false;
    if (!profile) {
      const alias = await store.wikiUsernameAlias.findUnique({
        where: { oldUsername: root },
        select: { profileId: true }
      });
      profile = alias ? await store.wikiProfile.findUnique({
        where: { id: alias.profileId },
        select: { id: true, username: true, status: true }
      }) : null;
      isAlias = alias !== null;
    }
    if (!profile || !ACTIVE_PROFILE_STATUSES.has(profile.status)) return null;
    return !isAlias && profile.username !== rawRoot
      ? null
      : { id: profile.id, username: profile.username, isAlias };
  }

  private async hasAnySubwikiRole(
    store: WikiPermissionStore,
    profileId: bigint,
    spaceId: bigint,
    allowedRoles: ReadonlySet<string>
  ): Promise<boolean> {
    const roles = await store.subwikiRole.findMany({
      where: {
        spaceId,
        userId: profileId,
        status: 'active'
      },
      select: { role: true }
    });
    return roles.some((role) => allowedRoles.has(role.role));
  }

  private async threadAclRecoverySpaceIds(
    store: WikiPermissionStore,
    actor: WikiPermissionActor,
    requestedSpaceIds: readonly bigint[]
  ): Promise<Set<bigint>> {
    const spaceIds = [...new Set(requestedSpaceIds)];
    if (spaceIds.length === 0) return new Set();
    if (this.isAdminActor(actor)) return new Set(spaceIds);
    const [spaces, ownerRoles, modWikis] = await Promise.all([
      store.wikiSpace.findMany({
        where: { id: { in: spaceIds }, status: 'active' },
        select: { id: true, status: true, spaceType: true, rootPageId: true, ownerUserId: true, createdBy: true }
      }),
      store.subwikiRole.findMany({
        where: { spaceId: { in: spaceIds }, userId: actor.profileId, status: 'active', role: 'owner' },
        select: { spaceId: true }
      }),
      store.modWiki.findMany({
        where: { spaceId: { in: spaceIds }, status: { not: 'deleted' } },
        select: { spaceId: true, verifiedBy: true }
      })
    ]);
    const serverAuthorities = new Map(await Promise.all(spaces
      .filter((space) => space.spaceType === 'server_wiki')
      .map(async (space) => [
        space.id,
        await this.linkedServerWikiAuthority(store, actor, space.id, space)
      ] as const)));
    const recoverable = new Set<bigint>();
    for (const space of spaces) {
      const authority = serverAuthorities.get(space.id);
      if (authority?.state === 'consistent') {
        if (authority.isOwner) recoverable.add(space.id);
      } else if (authority?.state !== 'inconsistent' &&
          (space.ownerUserId === actor.profileId || space.createdBy === actor.profileId)) {
        recoverable.add(space.id);
      }
    }
    for (const role of ownerRoles) {
      if (serverAuthorities.get(role.spaceId)?.state !== 'inconsistent') recoverable.add(role.spaceId);
    }
    for (const wiki of modWikis) {
      if (wiki.verifiedBy === actor.profileId) recoverable.add(wiki.spaceId);
    }
    return recoverable;
  }

  private evaluateThreadAclBatch<T extends { readonly thread: WikiPermissionThread; readonly page: WikiPermissionPage }>(
    action: WikiThreadAclAction,
    actor: WikiPermissionActor | null,
    items: readonly T[],
    store: WikiPermissionStore,
    requestIp?: string | null
  ): Promise<ReadonlyMap<bigint, WikiAclDecision>> {
    return this.wikiAcl?.evaluateThreadBatch({
      actor,
      action,
      resources: items.map((item) => ({
        threadId: item.thread.id,
        pageId: item.page.id,
        spaceId: item.page.spaceId,
        namespaceId: item.page.namespaceId,
        title: item.page.title,
        createdBy: item.page.createdBy
      })),
      store,
      requestIp
    }) ?? Promise.resolve(new Map());
  }

  private isAdminActor(actor: WikiPermissionActor): boolean {
    return actor.permissions?.includes('wiki.admin') === true ||
      actor.groups?.includes('admin') === true;
  }

  private evaluateAcl(
    action: WikiAclAction,
    actor: WikiPermissionActor | null,
    resource: {
      readonly pageId?: bigint | null;
      readonly spaceId?: bigint | null;
      readonly namespaceId?: number | null;
      readonly namespaceCode?: string | null;
      readonly title?: string | null;
      readonly createdBy?: bigint | null;
    },
    store: WikiPermissionStore,
    requestIp?: string | null
  ): Promise<WikiAclDecision> {
    return this.wikiAcl?.evaluate({ actor, action, resource, store, requestIp }) ??
      Promise.resolve({ matched: false, allowed: false, reason: 'acl_disabled' });
  }
}

function allow(reason: string): WikiPermissionDecision {
  return { allowed: true, reason };
}

function deny(reason: string): WikiPermissionDecision {
  return { allowed: false, reason };
}

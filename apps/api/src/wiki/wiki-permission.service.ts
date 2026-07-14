import { ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { WikiAclService, type WikiAclAction, type WikiAclDecision } from './wiki-acl.service';

type WikiPermissionStore = Pick<
  PrismaService,
  | 'wikiProfile'
  | 'wikiSpace'
  | 'subwikiRole'
  | 'serverWiki'
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
}

export interface WikiPermissionRevision {
  readonly visibility: string;
}

export interface WikiPermissionDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

export interface WikiSectionLockPolicy {
  readonly lockType: string;
  readonly ownerGroup?: string | null;
}

const EDITOR_ROLES = new Set(['owner', 'manager', 'editor', 'maintainer', 'reviewer', 'trusted']);
const OWNER_ROLES = new Set(['owner', 'manager', 'maintainer']);
const MOD_REVIEW_ROLES = new Set(['owner', 'manager', 'maintainer', 'reviewer']);
const PUBLIC_PAGE_STATUSES = new Set(['normal', 'active', 'published']);
const PUBLIC_REVISION_VISIBILITIES = new Set(['public']);
const ACTIVE_SPACE_STATUSES = new Set(['active']);
const ACTIVE_PROFILE_STATUSES = new Set(['active']);
const RESTRICTED_CREATE_NAMESPACES = new Set(['dev', 'help', 'project', 'template', 'file']);
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
    readonly page: WikiPermissionPage | null;
    readonly revision?: WikiPermissionRevision | null;
    readonly store?: WikiPermissionStore;
  }): Promise<void> {
    const decision = await this.canReadPage(input);
    if (!decision.allowed) {
      throw new NotFoundException('Wiki page not found.');
    }
  }

  async assertCanReadSpace(input: {
    readonly accountId?: string | null;
    readonly spaceId: bigint;
    readonly store?: WikiPermissionStore;
  }): Promise<void> {
    const store = input.store ?? this.prisma;
    const space = await store.wikiSpace.findUnique({ where: { id: input.spaceId } });
    if (!space || !ACTIVE_SPACE_STATUSES.has(space.status)) {
      throw new NotFoundException('Wiki space not found.');
    }
    const actor = await this.resolveActor(input.accountId, store);
    const acl = await this.evaluateAcl('read', actor, {
      spaceId: space.id,
      namespaceCode: space.rootNamespaceCode,
      title: space.title,
      createdBy: space.createdBy
    }, store);
    if (acl.matched && !acl.allowed) {
      throw new NotFoundException('Wiki space not found.');
    }
  }

  async canReadPage(input: {
    readonly accountId?: string | null;
    readonly page: WikiPermissionPage | null;
    readonly revision?: WikiPermissionRevision | null;
    readonly store?: WikiPermissionStore;
  }): Promise<WikiPermissionDecision> {
    const store = input.store ?? this.prisma;
    const page = input.page;
    if (!page) {
      return deny('page_missing');
    }
    const space = await store.wikiSpace.findUnique({
      where: { id: page.spaceId },
      select: { id: true, status: true }
    });
    if (!space || !ACTIVE_SPACE_STATUSES.has(space.status)) {
      return deny('space_not_active');
    }
    if (!PUBLIC_PAGE_STATUSES.has(page.status)) {
      return deny('page_not_public');
    }
    if (input.revision && !PUBLIC_REVISION_VISIBILITIES.has(input.revision.visibility)) {
      return deny('revision_not_public');
    }
    const actor = await this.resolveActor(input.accountId, store);
    if (!PUBLIC_READ_PROTECTION_LEVELS.has(page.protectionLevel)) {
      if (!actor || !(await this.canManagePageArea(store, actor, page))) {
        return deny('protection_not_readable');
      }
    }
    const acl = await this.evaluateAcl('read', actor, { pageId: page.id, spaceId: page.spaceId, namespaceId: page.namespaceId, title: page.title, createdBy: page.createdBy }, store);
    if (acl.matched && !acl.allowed) {
      return deny(acl.reason);
    }
    return allow('public_read');
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
      select: { id: true, status: true, ownerUserId: true }
    });
    if (!space || !ACTIVE_SPACE_STATUSES.has(space.status)) {
      return deny('space_not_active');
    }
    if (!PUBLIC_PAGE_STATUSES.has(page.status)) {
      return deny('page_not_editable');
    }
    const protectionLevel = page.protectionLevel || 'open';
    if (this.isAdminActor(actor)) {
      return allow('admin_edit');
    }
    const acl = await this.evaluateAcl('edit', actor, { pageId: page.id, spaceId: page.spaceId, namespaceId: page.namespaceId, title: page.title, createdBy: page.createdBy }, store);
    if (acl.matched) {
      return acl.allowed ? allow(acl.reason) : deny(acl.reason);
    }
    if (protectionLevel === 'open' || protectionLevel === 'login_required' || protectionLevel === 'review_required') {
      return allow('open_edit');
    }
    if (protectionLevel === 'autoconfirmed_only' || protectionLevel === 'trusted_only') {
      return (await this.hasAnySubwikiRole(store, actor.profileId, page.spaceId, EDITOR_ROLES)) ||
        space.ownerUserId === actor.profileId
        ? allow('trusted_edit')
        : deny('trusted_required');
    }
    if (protectionLevel === 'owner_only' || protectionLevel === 'official_only') {
      return space.ownerUserId === actor.profileId || (await this.canManagePageArea(store, actor, page))
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
    if (this.isAdminActor(actor)) {
      return allow('admin_create');
    }
    const space = await store.wikiSpace.findUnique({
      where: { id: input.spaceId },
      select: { id: true, status: true, spaceType: true, ownerUserId: true, createdBy: true }
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
      if (space.ownerUserId === actor.profileId || space.createdBy === actor.profileId) {
        return allow('server_owner_create');
      }
      if (await this.hasAnySubwikiRole(store, actor.profileId, input.spaceId, EDITOR_ROLES)) {
        return allow('server_role_create');
      }
      const serverWiki = await store.serverWiki.findFirst({
        where: {
          spaceId: input.spaceId,
          status: { not: 'deleted' }
        },
        select: { voteServerId: true, createdBy: true }
      });
      if (serverWiki?.createdBy === actor.profileId) {
        return allow('server_wiki_creator_create');
      }
      if (serverWiki?.voteServerId) {
        const server = await store.server.findUnique({
          where: { id: serverWiki.voteServerId },
          select: { ownerAccountId: true }
        });
        if (server?.ownerAccountId === actor.accountId) {
          return allow('linked_server_owner_create');
        }
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
      groups: session.groups
    };
  }

  async assertCanUsePageAction(input: {
    readonly accountId?: string | null;
    readonly action: WikiAclAction;
    readonly page: WikiPermissionPage | null;
    readonly store?: WikiPermissionStore;
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
    if (!(await this.canManagePageArea(store, actor, page))) {
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
    const store = input.store ?? this.prisma;
    const { actor, page } = input;
    if (!actor || !ACTIVE_PROFILE_STATUSES.has(actor.status) || !page) {
      throw new ForbiddenException('Wiki discussion is not allowed.');
    }
    await this.assertCanReadPage({ accountId: actor.accountId, page, store });
    const acl = await this.evaluateAcl('discuss', actor, {
      pageId: page.id,
      spaceId: page.spaceId,
      namespaceId: page.namespaceId,
      title: page.title,
      createdBy: page.createdBy
    }, store);
    if (acl.matched && !acl.allowed) {
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
    if (!page || !PUBLIC_PAGE_STATUSES.has(page.status)) return deny('page_not_manageable');
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
    readonly action: WikiAclAction;
    readonly page: WikiPermissionPage | null;
    readonly store?: WikiPermissionStore;
  }): Promise<WikiPermissionDecision> {
    const store = input.store ?? this.prisma;
    if (!input.page) {
      return deny('page_missing');
    }
    const readDecision = await this.canReadPage({
      accountId: input.accountId,
      page: input.page,
      store
    });
    if (!readDecision.allowed) {
      return readDecision;
    }
    const actor = await this.resolveActor(input.accountId, store);
    const acl = await this.evaluateAcl(input.action, actor, {
      pageId: input.page.id,
      spaceId: input.page.spaceId,
      namespaceId: input.page.namespaceId,
      title: input.page.title,
      createdBy: input.page.createdBy
    }, store);
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
    if (page.createdBy === actor.profileId) {
      return true;
    }
    if (await this.hasAnySubwikiRole(store, actor.profileId, page.spaceId, OWNER_ROLES)) {
      return true;
    }
    const serverWiki = await store.serverWiki.findFirst({
      where: {
        spaceId: page.spaceId,
        status: { not: 'deleted' }
      },
      select: { voteServerId: true, createdBy: true }
    });
    if (serverWiki) {
      if (serverWiki.createdBy === actor.profileId) {
        return true;
      }
      if (serverWiki.voteServerId) {
        const server = await store.server.findUnique({
          where: { id: serverWiki.voteServerId },
          select: { ownerAccountId: true }
        });
        if (server?.ownerAccountId === actor.accountId) {
          return true;
        }
      }
    }
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
    return this.hasAnySubwikiRole(store, actor.profileId, page.spaceId, MOD_REVIEW_ROLES);
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

  private isAdminActor(actor: WikiPermissionActor): boolean {
    return actor.isElevated === true ||
      actor.permissions?.includes('wiki.admin') === true ||
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
    store: WikiPermissionStore
  ): Promise<WikiAclDecision> {
    return this.wikiAcl?.evaluate({ actor, action, resource, store }) ??
      Promise.resolve({ matched: false, allowed: false, reason: 'acl_disabled' });
  }
}

function allow(reason: string): WikiPermissionDecision {
  return { allowed: true, reason };
}

function deny(reason: string): WikiPermissionDecision {
  return { allowed: false, reason };
}

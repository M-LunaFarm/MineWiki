import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

type WikiPermissionStore = Pick<
  PrismaService,
  'wikiProfile' | 'wikiSpace' | 'subwikiRole' | 'serverWiki' | 'server' | 'modWiki'
>;

export interface WikiPermissionActor {
  readonly accountId: string;
  readonly profileId: bigint;
  readonly status: string;
}

export interface WikiPermissionPage {
  readonly id: bigint;
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

const EDITOR_ROLES = new Set(['owner', 'manager', 'editor', 'maintainer', 'reviewer', 'trusted']);
const OWNER_ROLES = new Set(['owner', 'manager', 'maintainer']);
const MOD_REVIEW_ROLES = new Set(['owner', 'manager', 'maintainer', 'reviewer']);
const PUBLIC_PAGE_STATUSES = new Set(['normal', 'active', 'published']);
const PUBLIC_REVISION_VISIBILITIES = new Set(['public']);
const ACTIVE_SPACE_STATUSES = new Set(['active']);
const ACTIVE_PROFILE_STATUSES = new Set(['active']);
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
  constructor(private readonly prisma: PrismaService) {}

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
    if (!PUBLIC_READ_PROTECTION_LEVELS.has(page.protectionLevel)) {
      const actor = await this.resolveActor(input.accountId, store);
      if (!actor || !(await this.canManagePageArea(store, actor, page))) {
        return deny('protection_not_readable');
      }
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
    if (protectionLevel === 'admin_only' || protectionLevel === 'locked') {
      return deny('admin_required');
    }
    return deny('unknown_protection_level');
  }

  actorFromProfile(accountId: string, profile: { id: bigint; status: string }): WikiPermissionActor {
    return {
      accountId,
      profileId: profile.id,
      status: profile.status
    };
  }

  private async canManagePageArea(
    store: WikiPermissionStore,
    actor: WikiPermissionActor,
    page: WikiPermissionPage
  ): Promise<boolean> {
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
}

function allow(reason: string): WikiPermissionDecision {
  return { allowed: true, reason };
}

function deny(reason: string): WikiPermissionDecision {
  return { allowed: false, reason };
}

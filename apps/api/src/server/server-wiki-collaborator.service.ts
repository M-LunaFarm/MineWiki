import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type WikiProfile } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { lockServerWikiReviewerPolicy } from './server-wiki-release-review';
import { toAuditJson } from '../events/business-event.service';
import { writeAuditRecord } from '../events/audit-event-writer';
import { WikiProfileService } from '../wiki/wiki-profile.service';

export const SERVER_WIKI_COLLABORATOR_ROLES = [
  'manager',
  'editor',
  'reviewer',
] as const;

export type ServerWikiCollaboratorRole = (typeof SERVER_WIKI_COLLABORATOR_ROLES)[number];

export interface ServerWikiCollaboratorActor {
  readonly accountId: string;
  readonly permissions?: readonly string[];
  readonly isElevated?: boolean;
  readonly groups?: readonly string[];
}

export interface ServerWikiContentSettingsAuthority {
  readonly accountId: string;
  readonly kind: 'server_admin' | 'owner' | 'manager';
}

export interface ServerWikiCollaboratorItem {
  readonly profileId: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: ServerWikiCollaboratorRole;
  readonly expectedRole: ServerWikiCollaboratorRole;
  readonly grantedAt: string;
  readonly grantedByName: string;
  readonly grantedBy: {
    readonly profileId: string;
    readonly username: string;
    readonly displayName: string;
  } | null;
}

export interface ServerWikiCollaboratorRoster {
  readonly serverId: string;
  readonly spaceId: string;
  readonly assignableRoles: readonly ServerWikiCollaboratorRole[];
  readonly items: readonly ServerWikiCollaboratorItem[];
}

export interface CreateServerWikiCollaboratorInput {
  readonly username: string;
  readonly role: ServerWikiCollaboratorRole;
  readonly reason: string;
}

export interface UpdateServerWikiCollaboratorInput {
  readonly role: ServerWikiCollaboratorRole;
  readonly expectedRole: ServerWikiCollaboratorRole;
  readonly reason: string;
}

export interface RemoveServerWikiCollaboratorInput {
  readonly expectedRole: ServerWikiCollaboratorRole;
  readonly reason: string;
}

interface LockedServerWiki {
  readonly serverId: string;
  readonly ownerAccountId: string | null;
  readonly actorAccountId: string;
  readonly serverWikiId: bigint;
  readonly spaceId: bigint;
}

interface PreparedActor {
  readonly accountId: string;
  readonly profile: WikiProfile;
}

interface AssignableProfile {
  readonly profile: WikiProfile;
  readonly canonicalAccountId: string;
}

interface LockedRoleRow {
  readonly id: bigint;
  readonly role: string;
  readonly status: string;
  readonly grantedAt: Date;
  readonly grantedBy: bigint | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UNSIGNED_BIGINT_PATTERN = /^(?:[1-9][0-9]*)$/u;
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const REASON_MIN_LENGTH = 5;
const REASON_MAX_LENGTH = 500;
const MAX_PROFILE_ALIAS_DEPTH = 8;

@Injectable()
export class ServerWikiCollaboratorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiProfiles: WikiProfileService,
  ) {}

  async list(
    serverIdInput: string,
    actor: ServerWikiCollaboratorActor,
  ): Promise<ServerWikiCollaboratorRoster> {
    const serverId = parseServerId(serverIdInput);
    return this.serializable(async (tx) => {
      const context = await this.lockServerWiki(tx, serverId, actor);
      await this.lockSpaceRoleRows(tx, context.spaceId);
      return this.roster(tx, context);
    });
  }

  async authorizeContentSettings(
    serverIdInput: string,
    actor: ServerWikiCollaboratorActor,
  ): Promise<ServerWikiContentSettingsAuthority> {
    const serverId = parseServerId(serverIdInput);
    return this.serializable(async (tx) => {
      const context = await this.lockServerWiki(tx, serverId, actor, undefined, false);
      if (actor.permissions?.includes('server.admin') === true) {
        return { accountId: context.actorAccountId, kind: 'server_admin' };
      }
      if (context.ownerAccountId !== null && context.ownerAccountId === context.actorAccountId) {
        return { accountId: context.actorAccountId, kind: 'owner' };
      }

      await tx.$queryRaw<Array<{ id: bigint }>>`
        SELECT id FROM users WHERE account_id = ${context.actorAccountId} FOR UPDATE
      `;
      const profile = await tx.wikiProfile.findUnique({
        where: { accountId: context.actorAccountId },
      });
      if (
        !profile
        || profile.status !== 'active'
        || profile.mergedIntoProfileId !== null
      ) {
        throw contentSettingsForbidden();
      }
      const alias = await tx.wikiProfileAlias.findUnique({
        where: { sourceProfileId: profile.id },
        select: { targetProfileId: true },
      });
      if (alias) throw invalidProfileAlias();

      const roles = this.assertUnambiguousMutationRoles(
        await this.lockTargetRoleRows(tx, context.spaceId, profile.id),
      );
      if (roles.length !== 1 || roles[0]?.role !== 'manager') {
        throw contentSettingsForbidden();
      }
      return { accountId: context.actorAccountId, kind: 'manager' };
    });
  }

  async create(
    serverIdInput: string,
    input: CreateServerWikiCollaboratorInput,
    actor: ServerWikiCollaboratorActor,
  ): Promise<ServerWikiCollaboratorRoster> {
    const serverId = parseServerId(serverIdInput);
    const username = parseExactUsername(input.username);
    const role = parseRole(input.role, 'role');
    const reason = parseReason(input.reason);
    const preparedActor = await this.prepareActorProfile(serverId, actor);

    return this.serializable(async (tx) => {
      const context = await this.lockServerWiki(tx, serverId, actor, preparedActor.accountId);
      if (role === 'reviewer') await lockServerWikiReviewerPolicy(tx, context.spaceId);
      const target = await this.resolveAssignableProfileByUsername(tx, username);
      this.assertNotServerOwner(context, target);
      const rows = await this.lockTargetRoleRows(tx, context.spaceId, target.profile.id);
      const current = this.assertUnambiguousMutationRoles(rows);
      if (current.length > 0) {
        throw rosterConflict('이미 서버 위키 협업자로 등록된 사용자입니다. 목록을 새로고침해 주세요.');
      }

      const now = new Date();
      await this.activateRole(tx, context.spaceId, target.profile.id, role, preparedActor.profile.id, now);
      await this.assertTargetRoleState(tx, context.spaceId, target.profile.id, role);
      await this.appendAudit(tx, {
        action: 'server.wiki_collaborator.add',
        actorAccountId: context.actorAccountId,
        actorProfileId: preparedActor.profile.id,
        context,
        targetProfile: target.profile,
        previousRole: null,
        newRole: role,
        reason,
        now,
      });
      return this.roster(tx, context);
    });
  }

  async update(
    serverIdInput: string,
    profileIdInput: string,
    input: UpdateServerWikiCollaboratorInput,
    actor: ServerWikiCollaboratorActor,
  ): Promise<ServerWikiCollaboratorRoster> {
    const serverId = parseServerId(serverIdInput);
    const profileId = parseProfileId(profileIdInput);
    const role = parseRole(input.role, 'role');
    const expectedRole = parseRole(input.expectedRole, 'expectedRole');
    const reason = parseReason(input.reason);
    const preparedActor = await this.prepareActorProfile(serverId, actor);

    return this.serializable(async (tx) => {
      const context = await this.lockServerWiki(tx, serverId, actor, preparedActor.accountId);
      if (role === 'reviewer' || expectedRole === 'reviewer') await lockServerWikiReviewerPolicy(tx, context.spaceId);
      const target = await this.resolveAssignableProfileById(tx, profileId);
      this.assertNotServerOwner(context, target);
      const rows = await this.lockTargetRoleRows(tx, context.spaceId, target.profile.id);
      this.assertUnambiguousMutationRoles(rows);
      const current = oneCurrentRole(rows, expectedRole);
      if (current.role === role) {
        throw rosterConflict('동일한 역할로는 변경할 수 없습니다.');
      }

      const now = new Date();
      const revoked = await tx.subwikiRole.updateMany({
        where: { id: current.id, status: 'active', role: current.role },
        data: { status: 'revoked', revokedAt: now, revokedBy: preparedActor.profile.id },
      });
      if (revoked.count !== 1) throw staleRoleConflict();
      await this.activateRole(tx, context.spaceId, target.profile.id, role, preparedActor.profile.id, now);
      await this.assertTargetRoleState(tx, context.spaceId, target.profile.id, role);
      await this.appendAudit(tx, {
        action: 'server.wiki_collaborator.role_change',
        actorAccountId: context.actorAccountId,
        actorProfileId: preparedActor.profile.id,
        context,
        targetProfile: target.profile,
        previousRole: current.role,
        newRole: role,
        reason,
        now,
      });
      return this.roster(tx, context);
    });
  }

  async remove(
    serverIdInput: string,
    profileIdInput: string,
    input: RemoveServerWikiCollaboratorInput,
    actor: ServerWikiCollaboratorActor,
  ): Promise<ServerWikiCollaboratorRoster> {
    const serverId = parseServerId(serverIdInput);
    const profileId = parseProfileId(profileIdInput);
    const expectedRole = parseRole(input.expectedRole, 'expectedRole');
    const reason = parseReason(input.reason);
    const preparedActor = await this.prepareActorProfile(serverId, actor);

    return this.serializable(async (tx) => {
      const context = await this.lockServerWiki(tx, serverId, actor, preparedActor.accountId);
      if (expectedRole === 'reviewer') await lockServerWikiReviewerPolicy(tx, context.spaceId);
      const targetProfile = await this.resolveProfileForRemoval(tx, profileId);
      const rows = await this.lockTargetRoleRows(tx, context.spaceId, targetProfile.id);
      this.assertUnambiguousMutationRoles(rows);
      const current = oneCurrentRole(rows, expectedRole);
      const now = new Date();
      const revoked = await tx.subwikiRole.updateMany({
        where: { id: current.id, status: 'active', role: current.role },
        data: { status: 'revoked', revokedAt: now, revokedBy: preparedActor.profile.id },
      });
      if (revoked.count !== 1) throw staleRoleConflict();
      await this.assertTargetRoleState(tx, context.spaceId, targetProfile.id, null);
      await this.appendAudit(tx, {
        action: 'server.wiki_collaborator.remove',
        actorAccountId: context.actorAccountId,
        actorProfileId: preparedActor.profile.id,
        context,
        targetProfile,
        previousRole: current.role,
        newRole: null,
        reason,
        now,
      });
      return this.roster(tx, context);
    });
  }

  private async prepareActorProfile(
    serverId: string,
    actor: ServerWikiCollaboratorActor,
  ): Promise<PreparedActor> {
    const server = await this.prisma.server.findUnique({
      where: { id: serverId },
      select: { id: true, ownerAccountId: true },
    });
    if (!server) throw new NotFoundException('Server not found.');
    const accountId = await this.resolveCanonicalActorAccount(actor.accountId);
    const ownerAccountId = server.ownerAccountId
      ? await this.resolveCanonicalActorAccount(server.ownerAccountId)
      : null;
    assertRosterAuthority(ownerAccountId, accountId, actor.permissions);
    const profile = await this.wikiProfiles.ensureWikiProfile(accountId);
    return { accountId, profile };
  }

  private async lockServerWiki(
    tx: Prisma.TransactionClient,
    serverId: string,
    actor: ServerWikiCollaboratorActor,
    expectedActorAccountId?: string,
    requireRosterAuthority = true,
  ): Promise<LockedServerWiki> {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM \`Server\` WHERE id = ${serverId} FOR UPDATE
    `;
    const server = await tx.server.findUnique({
      where: { id: serverId },
      select: {
        id: true,
        ownerAccountId: true,
        ownershipChallengeSuspendedAt: true,
        wikiSpaceId: true,
        wikiPageId: true,
        wikiSlug: true,
      },
    });
    if (!server) throw new NotFoundException('Server not found.');
    if (server.ownershipChallengeSuspendedAt
      && actor.permissions?.includes('server.admin') !== true) {
      throw new ForbiddenException('서버 소유권 재검증이 완료될 때까지 협업자 권한이 잠겨 있습니다.');
    }
    const actorAccountId = await this.lockCanonicalActorAccount(tx, actor.accountId);
    if (expectedActorAccountId && actorAccountId !== expectedActorAccountId) {
      throw canonicalActorConflict();
    }
    const ownerAccountId = server.ownerAccountId
      ? await this.lockCanonicalActorAccount(tx, server.ownerAccountId)
      : null;
    if (requireRosterAuthority) {
      assertRosterAuthority(ownerAccountId, actorAccountId, actor.permissions);
    }
    if (!server.wikiSpaceId || !server.wikiPageId || !server.wikiSlug) {
      throw new NotFoundException('An active server wiki is not linked to this server.');
    }

    await tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id
      FROM server_wikis
      WHERE vote_server_id = ${server.id} OR space_id = ${server.wikiSpaceId}
      ORDER BY id
      FOR UPDATE
    `;
    const wikiCandidates = await tx.serverWiki.findMany({
      where: {
        OR: [
          { voteServerId: server.id },
          { spaceId: server.wikiSpaceId },
        ],
      },
      select: {
        id: true,
        voteServerId: true,
        spaceId: true,
        slug: true,
        status: true,
      },
      orderBy: { id: 'asc' },
    });
    if (wikiCandidates.length === 0) {
      throw new NotFoundException('An active server wiki is not linked to this server.');
    }
    if (wikiCandidates.length !== 1) throw serverWikiMismatch();
    const serverWiki = wikiCandidates[0];
    if (
      serverWiki.voteServerId !== server.id
      || serverWiki.spaceId !== server.wikiSpaceId
      || serverWiki.slug !== server.wikiSlug
      || serverWiki.status !== 'active'
    ) {
      throw serverWikiMismatch();
    }

    await tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM wiki_spaces WHERE id = ${serverWiki.spaceId} FOR UPDATE
    `;
    const space = await tx.wikiSpace.findUnique({
      where: { id: serverWiki.spaceId },
      select: { id: true, slug: true, spaceType: true, status: true, rootPageId: true },
    });
    if (!space) throw new NotFoundException('The linked server wiki space was not found.');
    if (
      space.status !== 'active'
      || space.spaceType !== 'server_wiki'
      || space.slug !== serverWiki.slug
      || space.rootPageId !== server.wikiPageId
    ) {
      throw serverWikiMismatch();
    }

    return {
      serverId: server.id,
      ownerAccountId,
      actorAccountId,
      serverWikiId: serverWiki.id,
      spaceId: space.id,
    };
  }

  private async resolveAssignableProfileByUsername(
    tx: Prisma.TransactionClient,
    username: string,
  ): Promise<AssignableProfile> {
    await tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM users WHERE username = ${username} FOR UPDATE
    `;
    let profile = await tx.wikiProfile.findUnique({ where: { username } });
    if (!profile || profile.username !== username) {
      throw new NotFoundException('Wiki profile not found.');
    }

    const visited = new Set<bigint>();
    for (let depth = 0; depth < MAX_PROFILE_ALIAS_DEPTH; depth += 1) {
      if (visited.has(profile.id)) throw invalidProfileAlias();
      visited.add(profile.id);
      await tx.$queryRaw<Array<{ sourceProfileId: bigint }>>`
        SELECT source_profile_id AS sourceProfileId
        FROM wiki_profile_aliases
        WHERE source_profile_id = ${profile.id}
        FOR UPDATE
      `;
      const alias = await tx.wikiProfileAlias.findUnique({
        where: { sourceProfileId: profile.id },
        select: { targetProfileId: true },
      });
      if (
        alias
        && profile.mergedIntoProfileId
        && alias.targetProfileId !== profile.mergedIntoProfileId
      ) {
        throw invalidProfileAlias();
      }
      const targetId = alias?.targetProfileId ?? profile.mergedIntoProfileId;
      if (!targetId) {
        if (profile.status === 'merged') throw invalidProfileAlias();
        return this.assertAssignableProfile(tx, profile);
      }
      await tx.$queryRaw<Array<{ id: bigint }>>`
        SELECT id FROM users WHERE id = ${targetId} FOR UPDATE
      `;
      const target = await tx.wikiProfile.findUnique({ where: { id: targetId } });
      if (!target) throw invalidProfileAlias();
      profile = target;
    }
    throw invalidProfileAlias();
  }

  private async resolveAssignableProfileById(
    tx: Prisma.TransactionClient,
    profileId: bigint,
  ): Promise<AssignableProfile> {
    await this.lockProfile(tx, profileId);
    const profile = await tx.wikiProfile.findUnique({ where: { id: profileId } });
    if (!profile) throw new NotFoundException('Wiki profile not found.');
    const alias = await tx.wikiProfileAlias.findUnique({
      where: { sourceProfileId: profile.id },
      select: { targetProfileId: true },
    });
    if (alias) throw profileNotAssignable();
    return this.assertAssignableProfile(tx, profile);
  }

  private async assertAssignableProfile(
    tx: Prisma.TransactionClient,
    profile: WikiProfile,
  ): Promise<AssignableProfile> {
    if (
      profile.status !== 'active'
      || profile.accountId === null
      || profile.mergedIntoProfileId !== null
    ) {
      throw profileNotAssignable();
    }
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM \`Account\` WHERE id = ${profile.accountId} FOR UPDATE
    `;
    const account = await tx.account.findUnique({
      where: { id: profile.accountId },
      select: { id: true, canonicalAccountId: true, lifecycleStatus: true },
    });
    if (!account || account.lifecycleStatus !== 'active') throw profileNotAssignable();
    const canonicalAccountId = account.canonicalAccountId ?? account.id;
    if (canonicalAccountId !== account.id) throw profileNotAssignable();
    return { profile, canonicalAccountId };
  }

  private async resolveProfileForRemoval(
    tx: Prisma.TransactionClient,
    profileId: bigint,
  ): Promise<WikiProfile> {
    await this.lockProfile(tx, profileId);
    const profile = await tx.wikiProfile.findUnique({ where: { id: profileId } });
    if (!profile) throw new NotFoundException('Wiki profile not found.');
    return profile;
  }

  private lockProfile(tx: Prisma.TransactionClient, profileId: bigint): Promise<unknown> {
    return tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM users WHERE id = ${profileId} FOR UPDATE
    `;
  }

  private assertNotServerOwner(context: LockedServerWiki, target: AssignableProfile): void {
    if (
      context.ownerAccountId !== null
      && target.canonicalAccountId === context.ownerAccountId
    ) {
      throw new BadRequestException('서버 소유자는 협업자 역할로 중복 등록할 수 없습니다.');
    }
  }

  private async lockSpaceRoleRows(
    tx: Prisma.TransactionClient,
    spaceId: bigint,
  ): Promise<void> {
    await tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM subwiki_roles WHERE space_id = ${spaceId} ORDER BY id FOR UPDATE
    `;
  }

  private async lockTargetRoleRows(
    tx: Prisma.TransactionClient,
    spaceId: bigint,
    profileId: bigint,
  ): Promise<LockedRoleRow[]> {
    await tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id
      FROM subwiki_roles
      WHERE space_id = ${spaceId} AND user_id = ${profileId}
      ORDER BY id
      FOR UPDATE
    `;
    return tx.subwikiRole.findMany({
      where: { spaceId, userId: profileId },
      select: {
        id: true,
        role: true,
        status: true,
        grantedAt: true,
        grantedBy: true,
      },
      orderBy: { id: 'asc' },
    });
  }

  private assertUnambiguousMutationRoles(
    rows: readonly LockedRoleRow[],
  ): Array<LockedRoleRow & { role: ServerWikiCollaboratorRole }> {
    const active = rows.filter((row) => row.status === 'active');
    if (active.some((row) => row.role === 'owner')) {
      throw new ConflictException('기존 소유자 역할은 이 API에서 변경할 수 없습니다.');
    }
    const legacy = active.filter((row) => !isRole(row.role));
    if (legacy.length > 0) {
      throw new ConflictException('활성 레거시 역할이 있어 협업자 권한을 안전하게 변경할 수 없습니다.');
    }
    const assignable = activeAssignableRows(active);
    if (assignable.length > 1) {
      throw new ConflictException('활성 협업자 역할이 둘 이상이라 변경할 수 없습니다.');
    }
    return assignable;
  }

  private activateRole(
    tx: Prisma.TransactionClient,
    spaceId: bigint,
    profileId: bigint,
    role: ServerWikiCollaboratorRole,
    actorProfileId: bigint,
    now: Date,
  ) {
    return tx.subwikiRole.upsert({
      where: {
        spaceId_userId_role: { spaceId, userId: profileId, role },
      },
      update: {
        status: 'active',
        grantedBy: actorProfileId,
        grantedAt: now,
        revokedAt: null,
        revokedBy: null,
      },
      create: {
        spaceId,
        userId: profileId,
        role,
        status: 'active',
        grantedBy: actorProfileId,
        grantedAt: now,
      },
    });
  }

  private async assertTargetRoleState(
    tx: Prisma.TransactionClient,
    spaceId: bigint,
    profileId: bigint,
    expectedRole: ServerWikiCollaboratorRole | null,
  ): Promise<void> {
    const active = await tx.subwikiRole.findMany({
      where: {
        spaceId,
        userId: profileId,
        status: 'active',
      },
      select: { role: true },
    });
    if (
      expectedRole === null
        ? active.length !== 0
        : active.length !== 1 || active[0]?.role !== expectedRole
    ) {
      throw rosterConflict('협업자 역할 상태가 동시에 변경되었습니다. 새로고침 후 다시 시도하세요.');
    }
  }

  private async resolveCanonicalActorAccount(accountId: string): Promise<string> {
    let currentId = accountId;
    const visited = new Set<string>();
    for (let depth = 0; depth < MAX_PROFILE_ALIAS_DEPTH; depth += 1) {
      if (visited.has(currentId)) throw canonicalActorConflict();
      visited.add(currentId);
      const account = await this.prisma.account.findUnique({
        where: { id: currentId },
        select: { id: true, canonicalAccountId: true, lifecycleStatus: true },
      });
      if (!account || account.lifecycleStatus !== 'active') throw actorAccountUnavailable();
      const nextId = account.canonicalAccountId ?? account.id;
      if (nextId === account.id) return account.id;
      currentId = nextId;
    }
    throw canonicalActorConflict();
  }

  private async lockCanonicalActorAccount(
    tx: Prisma.TransactionClient,
    accountId: string,
  ): Promise<string> {
    let currentId = accountId;
    const visited = new Set<string>();
    for (let depth = 0; depth < MAX_PROFILE_ALIAS_DEPTH; depth += 1) {
      if (visited.has(currentId)) throw canonicalActorConflict();
      visited.add(currentId);
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM \`Account\` WHERE id = ${currentId} FOR UPDATE
      `;
      const account = await tx.account.findUnique({
        where: { id: currentId },
        select: { id: true, canonicalAccountId: true, lifecycleStatus: true },
      });
      if (!account || account.lifecycleStatus !== 'active') throw actorAccountUnavailable();
      const nextId = account.canonicalAccountId ?? account.id;
      if (nextId === account.id) return account.id;
      currentId = nextId;
    }
    throw canonicalActorConflict();
  }

  private async appendAudit(
    tx: Prisma.TransactionClient,
    input: {
      readonly action: string;
      readonly actorAccountId: string;
      readonly actorProfileId: bigint;
      readonly context: LockedServerWiki;
      readonly targetProfile: WikiProfile;
      readonly previousRole: ServerWikiCollaboratorRole | null;
      readonly newRole: ServerWikiCollaboratorRole | null;
      readonly reason: string;
      readonly now: Date;
    },
  ): Promise<void> {
    await writeAuditRecord(tx, {
      data: {
        category: 'server',
        action: input.action,
        severity: input.newRole === null ? 'warning' : 'info',
        actorAccountId: input.actorAccountId,
        actorProfileId: input.actorProfileId,
        subjectType: 'server_wiki_collaborator',
        subjectId: input.targetProfile.id.toString(),
        metadata: toAuditJson({
          serverId: input.context.serverId,
          serverWikiId: input.context.serverWikiId,
          spaceId: input.context.spaceId,
          targetProfileId: input.targetProfile.id,
          targetUsername: input.targetProfile.username,
          previousRole: input.previousRole,
          newRole: input.newRole,
          reason: input.reason,
        }),
        createdAt: input.now,
      },
    });
  }

  private async roster(
    tx: Prisma.TransactionClient,
    context: LockedServerWiki,
  ): Promise<ServerWikiCollaboratorRoster> {
    const rows = await tx.subwikiRole.findMany({
      where: {
        spaceId: context.spaceId,
        status: 'active',
        role: { in: [...SERVER_WIKI_COLLABORATOR_ROLES] },
      },
      select: {
        id: true,
        userId: true,
        role: true,
        grantedAt: true,
        grantedBy: true,
      },
      orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
    });
    const profileIds = [...new Set(rows.flatMap((row) => [row.userId, ...(row.grantedBy ? [row.grantedBy] : [])]))];
    const profiles = profileIds.length > 0
      ? await tx.wikiProfile.findMany({
          where: { id: { in: profileIds } },
          select: { id: true, username: true, displayName: true },
        })
      : [];
    const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
    const items = rows.map((row): ServerWikiCollaboratorItem => {
      const profile = profilesById.get(row.userId);
      if (!profile || !isRole(row.role)) {
        throw rosterConflict('협업자 명단에 유효하지 않은 프로필 또는 역할이 있습니다.');
      }
      const grantor = row.grantedBy ? profilesById.get(row.grantedBy) ?? null : null;
      return {
        profileId: profile.id.toString(),
        username: profile.username,
        displayName: profile.displayName,
        role: row.role,
        expectedRole: row.role,
        grantedAt: row.grantedAt.toISOString(),
        grantedByName: grantor?.displayName ?? (row.grantedBy ? '알 수 없는 사용자' : '시스템'),
        grantedBy: grantor
          ? {
              profileId: grantor.id.toString(),
              username: grantor.username,
              displayName: grantor.displayName,
            }
          : null,
      };
    });
    return {
      serverId: context.serverId,
      spaceId: context.spaceId.toString(),
      assignableRoles: [...SERVER_WIKI_COLLABORATOR_ROLES],
      items,
    };
  }

  private async serializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : null;
      if (code === 'P2002' || code === 'P2034') {
        throw rosterConflict('협업자 역할이 동시에 변경되었습니다. 새로고침 후 다시 시도하세요.');
      }
      throw error;
    }
  }
}

function parseServerId(value: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException('serverId must be a UUID.');
  }
  return value.toLowerCase();
}

function parseProfileId(value: string): bigint {
  if (typeof value !== 'string' || !UNSIGNED_BIGINT_PATTERN.test(value)) {
    throw new BadRequestException('profileId must be a positive integer.');
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UNSIGNED_BIGINT) {
    throw new BadRequestException('profileId is outside the supported range.');
  }
  return parsed;
}

function parseExactUsername(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) {
    throw new BadRequestException('username must contain between 1 and 64 characters.');
  }
  const normalized = value.normalize('NFKC');
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    normalized !== value
    || value.includes('/')
    || value.includes('\\')
    || hasControlCharacter
  ) {
    throw new BadRequestException('username must be an exact NFKC-normalized wiki username.');
  }
  return value;
}

function parseRole(value: string, field: string): ServerWikiCollaboratorRole {
  if (!isRole(value)) {
    throw new BadRequestException(`${field} must be manager, editor, or reviewer.`);
  }
  return value;
}

function parseReason(value: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException('reason is required.');
  }
  const reason = value.trim();
  if (reason.length < REASON_MIN_LENGTH || reason.length > REASON_MAX_LENGTH) {
    throw new BadRequestException(`reason must contain between ${REASON_MIN_LENGTH} and ${REASON_MAX_LENGTH} characters.`);
  }
  return reason;
}

function isRole(value: string): value is ServerWikiCollaboratorRole {
  return (SERVER_WIKI_COLLABORATOR_ROLES as readonly string[]).includes(value);
}

function activeAssignableRows(rows: readonly LockedRoleRow[]): Array<LockedRoleRow & { role: ServerWikiCollaboratorRole }> {
  return rows.filter(
    (row): row is LockedRoleRow & { role: ServerWikiCollaboratorRole } => row.status === 'active' && isRole(row.role),
  );
}

function oneCurrentRole(
  rows: readonly LockedRoleRow[],
  expectedRole: ServerWikiCollaboratorRole,
): LockedRoleRow & { role: ServerWikiCollaboratorRole } {
  const active = activeAssignableRows(rows);
  if (active.length !== 1 || active[0]?.role !== expectedRole) throw staleRoleConflict();
  return active[0];
}

function assertRosterAuthority(
  ownerAccountId: string | null,
  actorAccountId: string,
  permissions: readonly string[] | undefined,
): void {
  if (permissions?.includes('server.admin') === true) return;
  if (ownerAccountId !== null && ownerAccountId === actorAccountId) return;
  throw new ForbiddenException('서버 소유자 또는 전역 서버 관리자만 위키 협업자를 관리할 수 있습니다.');
}

function contentSettingsForbidden(): ForbiddenException {
  return new ForbiddenException('활성 서버 위키 관리자만 콘텐츠 설정을 관리할 수 있습니다.');
}

function actorAccountUnavailable(): ForbiddenException {
  return new ForbiddenException('활성 대표 계정 상태를 확인할 수 없습니다.');
}

function canonicalActorConflict(): ConflictException {
  return new ConflictException('대표 계정 연결 상태가 변경되었습니다. 다시 시도해 주세요.');
}

function profileNotAssignable(): BadRequestException {
  return new BadRequestException('활성 상태의 계정 연결 대표 위키 프로필만 협업자로 지정할 수 있습니다.');
}

function invalidProfileAlias(): ConflictException {
  return new ConflictException('위키 프로필 병합 상태를 안전하게 확인할 수 없습니다.');
}

function serverWikiMismatch(): ConflictException {
  return new ConflictException('서버와 활성 서버 위키 공간의 연결 정보가 일치하지 않습니다.');
}

function staleRoleConflict(): ConflictException {
  return rosterConflict('협업자 역할이 이미 변경되었습니다. 목록을 새로고침해 주세요.');
}

function rosterConflict(message: string): ConflictException {
  return new ConflictException(message);
}

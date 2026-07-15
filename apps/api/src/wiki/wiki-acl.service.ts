import { Injectable } from '@nestjs/common';
import { cidrContains, normalizeIpOrCidr } from '@minewiki/security';
import { PrismaService } from '../common/prisma.service';
import { getCurrentRequestIp } from '../common/http/request-context';
import type { WikiPermissionActor } from './wiki-permission.service';

type WikiAclStore = Pick<
  PrismaService,
  | 'aclRule'
  | 'aclGroup'
  | 'aclGroupMember'
  | 'wikiGroup'
  | 'wikiUserGroup'
  | 'wikiGroupPermission'
  | 'wikiNamespace'
  | 'wikiSpace'
  | 'subwikiRole'
  | 'serverWiki'
  | 'server'
  | 'modWiki'
  | 'wikiPage'
  | 'wikiPageRevision'
>;

export type WikiAclAction =
  | 'read'
  | 'edit'
  | 'create'
  | 'move'
  | 'delete'
  | 'revert'
  | 'history'
  | 'raw'
  | 'discuss'
  | 'create_thread'
  | 'write_thread_comment'
  | 'upload_file'
  | 'acl';

export type WikiThreadAclAction = 'read' | 'write_thread_comment';

export interface WikiAclResource {
  readonly threadId?: bigint | null;
  readonly pageId?: bigint | null;
  readonly spaceId?: bigint | null;
  readonly namespaceId?: number | null;
  readonly namespaceCode?: string | null;
  readonly title?: string | null;
  readonly createdBy?: bigint | null;
}

export interface WikiAclDecision {
  readonly matched: boolean;
  readonly allowed: boolean;
  readonly reason: string;
}

const ROLE_GROUPS = {
  admin: new Set(['admin', 'developer']),
  moderator: new Set(['moderator', 'admin', 'developer']),
  trusted: new Set(['trusted', 'moderator', 'admin', 'developer']),
  autoconfirmed: new Set(['autoconfirmed', 'trusted', 'moderator', 'admin', 'developer'])
};

@Injectable()
export class WikiAclService {
  constructor(private readonly prisma: PrismaService) {}

  async evaluateThreadBatch(input: {
    readonly actor: WikiPermissionActor | null;
    readonly action: WikiThreadAclAction;
    readonly resources: ReadonlyArray<WikiAclResource & { readonly threadId: bigint }>;
    readonly store?: WikiAclStore;
    readonly requestIp?: string | null;
  }): Promise<ReadonlyMap<bigint, WikiAclDecision>> {
    const store = input.store ?? this.prisma;
    const threadIds = [...new Set(input.resources.map((resource) => resource.threadId))];
    if (threadIds.length === 0) return new Map();
    const now = new Date();
    const rules = await store.aclRule.findMany({
      where: {
        targetType: 'thread',
        targetId: { in: threadIds },
        action: input.action,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
      },
      orderBy: [{ targetId: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }]
    });
    const actor = input.actor ? await this.hydrateBatchActor(store, input.actor) : null;
    const activeRules = rules.filter((rule) =>
      rule.targetType === 'thread' && rule.targetId !== null && threadIds.includes(rule.targetId) &&
      rule.action === input.action && (!rule.expiresAt || rule.expiresAt.getTime() > now.getTime())
    ).sort((left, right) =>
      left.targetId === right.targetId
        ? left.sortOrder - right.sortOrder || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        : (left.targetId ?? 0n) < (right.targetId ?? 0n) ? -1 : 1
    );
    const rulesByThread = new Map<bigint, typeof activeRules>();
    for (const rule of activeRules) {
      if (rule.targetId === null) continue;
      const bucket = rulesByThread.get(rule.targetId) ?? [];
      bucket.push(rule);
      rulesByThread.set(rule.targetId, bucket);
    }
    const matches = new Map<string, Promise<boolean>>();
    const decisions = new Map<bigint, WikiAclDecision>();
    const requestIp = input.requestIp ?? actor?.requestIp ?? getCurrentRequestIp();
    for (const resource of input.resources) {
      const threadRules = rulesByThread.get(resource.threadId) ?? [];
      if (threadRules.length === 0) {
        decisions.set(resource.threadId, { matched: false, allowed: false, reason: 'thread_acl_inherit' });
        continue;
      }
      let decision: WikiAclDecision = { matched: true, allowed: false, reason: 'thread_acl_closed' };
      for (const rule of threadRules) {
        const cacheKey = batchSubjectCacheKey(rule, resource);
        let matched = matches.get(cacheKey);
        if (!matched) {
          matched = this.subjectMatches(store, rule, actor, resource, requestIp);
          matches.set(cacheKey, matched);
        }
        if (!(await matched)) continue;
        decision = rule.effect === 'allow'
          ? { matched: true, allowed: true, reason: rule.reason ?? 'thread_acl_allow' }
          : { matched: true, allowed: false, reason: rule.reason ?? 'thread_acl_deny' };
        break;
      }
      decisions.set(resource.threadId, decision);
    }
    return decisions;
  }

  async evaluateReadBatch(input: {
    readonly actor: WikiPermissionActor | null;
    readonly resources: ReadonlyArray<WikiAclResource & { readonly pageId: bigint }>;
    readonly store?: WikiAclStore;
    readonly requestIp?: string | null;
  }): Promise<ReadonlyMap<bigint, WikiAclDecision>> {
    const store = input.store ?? this.prisma;
    const now = new Date();
    const namespaceIds = [...new Set(input.resources.flatMap((resource) => resource.namespaceId ? [resource.namespaceId] : []))];
    const spaceIds = [...new Set(input.resources.flatMap((resource) => resource.spaceId ? [resource.spaceId] : []))];
    const pageIds = [...new Set(input.resources.map((resource) => resource.pageId))];
    const rules = await store.aclRule.findMany({
      where: {
        action: 'read',
        OR: [
          { targetType: 'site', targetId: null },
          ...(namespaceIds.length > 0 ? [{ targetType: 'namespace', targetId: { in: namespaceIds.map(BigInt) } }] : []),
          ...(spaceIds.length > 0 ? [{ targetType: 'space', targetId: { in: spaceIds } }] : []),
          ...(pageIds.length > 0 ? [{ targetType: 'page', targetId: { in: pageIds } }] : [])
        ],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }]
      }
    });
    const actor = input.actor ? await this.hydrateBatchActor(store, input.actor) : null;
    const rulesByTarget = new Map<string, typeof rules>();
    for (const rule of rules) {
      const key = `${rule.targetType}:${rule.targetId?.toString() ?? ''}`;
      rulesByTarget.set(key, [...(rulesByTarget.get(key) ?? []), rule]);
    }
    for (const scopedRules of rulesByTarget.values()) {
      scopedRules.sort((left, right) => left.sortOrder - right.sortOrder);
    }
    const matches = new Map<string, Promise<boolean>>();
    const decisions = new Map<bigint, WikiAclDecision>();
    const requestIp = input.requestIp ?? actor?.requestIp ?? getCurrentRequestIp();
    for (const resource of input.resources) {
      const scopes: Array<{ readonly targetType: string; readonly targetId: bigint | null }> = [
        { targetType: 'page', targetId: resource.pageId },
        { targetType: 'space', targetId: resource.spaceId ?? null },
        { targetType: 'namespace', targetId: resource.namespaceId ? BigInt(resource.namespaceId) : null },
        { targetType: 'site', targetId: null }
      ];
      let decision: WikiAclDecision = { matched: false, allowed: false, reason: 'acl_no_match' };
      scopeLoop: for (const scope of scopes) {
        if (scope.targetType !== 'site' && scope.targetId === null) continue;
        for (const rule of rulesByTarget.get(`${scope.targetType}:${scope.targetId?.toString() ?? ''}`) ?? []) {
          const cacheKey = batchSubjectCacheKey(rule, resource);
          let matched = matches.get(cacheKey);
          if (!matched) {
            matched = this.subjectMatches(store, rule, actor, resource, requestIp);
            matches.set(cacheKey, matched);
          }
          if (!(await matched)) continue;
          decision = rule.effect === 'allow'
            ? { matched: true, allowed: true, reason: rule.reason ?? 'acl_allow' }
            : rule.effect === 'deny'
              ? { matched: true, allowed: false, reason: rule.reason ?? 'acl_deny' }
              : { matched: true, allowed: false, reason: 'acl_unsupported_effect' };
          break scopeLoop;
        }
      }
      decisions.set(resource.pageId, decision);
    }
    return decisions;
  }

  async evaluate(input: {
    readonly actor: WikiPermissionActor | null;
    readonly action: WikiAclAction;
    readonly resource: WikiAclResource;
    readonly store?: WikiAclStore;
    readonly requestIp?: string | null;
  }): Promise<WikiAclDecision> {
    const store = input.store ?? this.prisma;
    const now = new Date();
    let namespaceId = input.resource.namespaceId ?? null;
    if (!namespaceId && input.resource.namespaceCode) {
      const namespace = await store.wikiNamespace.findUnique({
        where: { code: input.resource.namespaceCode },
        select: { id: true }
      });
      namespaceId = namespace?.id ?? null;
    }
    const targetFilters: Array<{ targetType: string; targetId?: bigint | null }> = [
      { targetType: 'site', targetId: null }
    ];
    if (namespaceId) {
      targetFilters.push({ targetType: 'namespace', targetId: BigInt(namespaceId) });
    }
    if (input.resource.spaceId) {
      targetFilters.push({ targetType: 'space', targetId: input.resource.spaceId });
    }
    if (input.resource.pageId) {
      targetFilters.push({ targetType: 'page', targetId: input.resource.pageId });
    }

    const rules = await store.aclRule.findMany({
      where: {
        action: input.action,
        OR: targetFilters.map((target) => ({
          targetType: target.targetType,
          targetId: target.targetId ?? null
        })),
        AND: [
          {
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
          }
        ]
      }
    });
    const activeRules = rules
      .filter((rule) =>
        rule.action === input.action &&
        targetFilters.some((target) => rule.targetType === target.targetType && (rule.targetId ?? null) === (target.targetId ?? null)) &&
        (!rule.expiresAt || rule.expiresAt.getTime() > now.getTime())
      );

    const scopes = [...targetFilters].sort(
      (left, right) => targetSpecificity(right.targetType) - targetSpecificity(left.targetType)
    );
    for (const scope of scopes) {
      const scopedRules = activeRules
        .filter(
          (rule) =>
            rule.targetType === scope.targetType &&
            (rule.targetId ?? null) === (scope.targetId ?? null)
        )
        .sort((left, right) => left.sortOrder - right.sortOrder);
      for (const rule of scopedRules) {
        if (!(await this.subjectMatches(
          store,
          rule,
          input.actor,
          input.resource,
          input.requestIp ?? input.actor?.requestIp ?? getCurrentRequestIp()
        ))) {
          continue;
        }
        if (rule.effect === 'allow') {
          return { matched: true, allowed: true, reason: rule.reason ?? 'acl_allow' };
        }
        if (rule.effect === 'deny') {
          return { matched: true, allowed: false, reason: rule.reason ?? 'acl_deny' };
        }
        return { matched: true, allowed: false, reason: 'acl_unsupported_effect' };
      }
    }

    return { matched: false, allowed: false, reason: 'acl_no_match' };
  }

  private async subjectMatches(
    store: WikiAclStore,
    rule: {
      readonly subjectType: string;
      readonly subjectValue: string;
    },
    actor: WikiPermissionActor | null,
    resource: WikiAclResource,
    requestIp: string | null
  ): Promise<boolean> {
    const subjectType = rule.subjectType;
    const subjectValue = stripAclPrefix(rule.subjectValue, subjectType);
    if (subjectType === 'perm') {
      return this.permissionMatches(store, subjectValue, actor);
    }
    if (subjectType === 'user') {
      return Boolean(actor && safeBigInt(subjectValue) === actor.profileId);
    }
    if (subjectType === 'aclgroup') {
      return this.aclGroupMatches(store, subjectValue, actor, requestIp);
    }
    if (subjectType === 'role') {
      return this.roleMatches(store, subjectValue, actor, resource);
    }
    if (subjectType === 'group') {
      return Boolean(actor && (await this.groupCodes(store, actor)).includes(subjectValue));
    }
    return false;
  }

  private async permissionMatches(
    store: WikiAclStore,
    permission: string,
    actor: WikiPermissionActor | null
  ): Promise<boolean> {
    if (permission === 'any') {
      return true;
    }
    if (permission === 'guest') {
      return !actor;
    }
    if (permission === 'member') {
      return Boolean(actor);
    }
    if (!actor) {
      return false;
    }
    const groups = actor.groups ? [...actor.groups] : await this.groupCodes(store, actor);
    const permissions = actor.permissions ? [...actor.permissions] : await this.permissionCodes(store, groups);
    if (permission === 'admin') {
      return groups.some((group) => ROLE_GROUPS.admin.has(group));
    }
    if (permission === 'developer') {
      return groups.includes('developer');
    }
    if (permission === 'moderator' || permission === 'trusted' || permission === 'autoconfirmed') {
      return groups.some((group) => ROLE_GROUPS[permission].has(group));
    }
    return actor.permissions?.includes(permission) === true || permissions.includes(permission);
  }

  private async roleMatches(
    store: WikiAclStore,
    role: string,
    actor: WikiPermissionActor | null,
    resource: WikiAclResource
  ): Promise<boolean> {
    if (!actor) {
      return false;
    }
    if (role === 'owner_user') {
      return resource.createdBy === actor.profileId;
    }
    if (role === 'page_contributor' && resource.pageId) {
      const revision = await store.wikiPageRevision.findFirst({
        where: {
          pageId: resource.pageId,
          createdBy: actor.profileId
        },
        select: { id: true }
      });
      return Boolean(revision);
    }
    if (role === 'space_contributor' && resource.spaceId) {
      const pages = await store.wikiPage.findMany({
        where: { spaceId: resource.spaceId },
        select: { id: true },
        take: 500
      });
      if (pages.length === 0) {
        return false;
      }
      const revision = await store.wikiPageRevision.findFirst({
        where: {
          pageId: { in: pages.map((page) => page.id) },
          createdBy: actor.profileId,
        },
        select: { id: true }
      });
      return Boolean(revision);
    }
    if (!resource.spaceId) {
      return false;
    }
    if (role === 'server_owner' || role === 'server_manager' || role === 'server_editor') {
      return this.serverRoleMatches(store, role, actor, resource.spaceId);
    }
    if (role === 'mod_wiki_manager' || role === 'mod_wiki_editor') {
      return this.modRoleMatches(store, role, actor, resource.spaceId);
    }
    return false;
  }

  private async serverRoleMatches(
    store: WikiAclStore,
    role: string,
    actor: WikiPermissionActor,
    spaceId: bigint
  ): Promise<boolean> {
    const allowedRoles = role === 'server_owner'
      ? ['owner']
      : role === 'server_manager'
        ? ['owner', 'manager']
        : ['owner', 'manager', 'editor'];
    if (await this.hasSubwikiRole(store, actor.profileId, spaceId, allowedRoles)) {
      return true;
    }
    const serverWiki = await store.serverWiki.findFirst({
      where: {
        spaceId,
        status: { not: 'deleted' }
      },
      select: { voteServerId: true, createdBy: true }
    });
    if (serverWiki?.createdBy === actor.profileId) {
      return true;
    }
    if (!serverWiki?.voteServerId) {
      return false;
    }
    const server = await store.server.findUnique({
      where: { id: serverWiki.voteServerId },
      select: { ownerAccountId: true }
    });
    return server?.ownerAccountId === actor.accountId;
  }

  private async modRoleMatches(
    store: WikiAclStore,
    role: string,
    actor: WikiPermissionActor,
    spaceId: bigint
  ): Promise<boolean> {
    const allowedRoles = role === 'mod_wiki_manager'
      ? ['owner', 'manager', 'maintainer']
      : ['owner', 'manager', 'maintainer', 'editor', 'reviewer'];
    if (await this.hasSubwikiRole(store, actor.profileId, spaceId, allowedRoles)) {
      return true;
    }
    const modWiki = await store.modWiki.findFirst({
      where: {
        spaceId,
        status: { not: 'deleted' }
      },
      select: { verifiedBy: true }
    });
    return modWiki?.verifiedBy === actor.profileId;
  }

  private async aclGroupMatches(
    store: WikiAclStore,
    groupKey: string,
    actor: WikiPermissionActor | null,
    requestIp: string | null
  ): Promise<boolean> {
    const group = await store.aclGroup.findUnique({
      where: { groupKey },
      select: { id: true, status: true }
    });
    if (!group || group.status !== 'active') {
      return false;
    }
    const now = new Date();
    if (actor) {
      const member = await store.aclGroupMember.findFirst({
        where: {
          groupId: group.id,
          memberType: 'user',
          userId: actor.profileId,
          removedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
        },
        select: { id: true }
      });
      if (member) return true;
    }
    const normalizedIp = normalizeRequestIp(requestIp);
    if (!normalizedIp) return false;
    const candidates = await store.aclGroupMember.findMany({
      where: {
        groupId: group.id,
        memberType: { in: ['ip', 'cidr'] },
        ipVersion: normalizedIp.family,
        removedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
      },
      select: { cidr: true }
    });
    return candidates.some((member) => Boolean(member.cidr && cidrContains(member.cidr, normalizedIp.address)));
  }

  private async groupCodes(store: WikiAclStore, actor: WikiPermissionActor): Promise<string[]> {
    const explicit = actor.groups ? [...actor.groups] : [];
    const memberships = await store.wikiUserGroup.findMany({
      where: { userId: actor.profileId },
      select: { groupId: true }
    });
    if (memberships.length === 0) {
      return explicit;
    }
    const groups = await store.wikiGroup.findMany({
      where: { id: { in: memberships.map((membership) => membership.groupId) } },
      select: { code: true }
    });
    return [...new Set([...explicit, ...groups.map((group) => group.code)])];
  }

  private async hydrateBatchActor(
    store: WikiAclStore,
    actor: WikiPermissionActor
  ): Promise<WikiPermissionActor> {
    const groups = await this.groupCodes(store, actor);
    const permissions = await this.permissionCodes(store, groups);
    return { ...actor, groups, permissions };
  }

  private async permissionCodes(store: WikiAclStore, groupCodes: readonly string[]): Promise<string[]> {
    if (groupCodes.length === 0) {
      return [];
    }
    const groups = await store.wikiGroup.findMany({
      where: { code: { in: [...groupCodes] } },
      select: { id: true }
    });
    if (groups.length === 0) {
      return [];
    }
    const permissions = await store.wikiGroupPermission.findMany({
      where: { groupId: { in: groups.map((group) => group.id) } },
      select: { permissionCode: true }
    });
    return permissions.map((permission) => permission.permissionCode);
  }

  private async hasSubwikiRole(
    store: WikiAclStore,
    profileId: bigint,
    spaceId: bigint,
    allowedRoles: readonly string[]
  ): Promise<boolean> {
    const role = await store.subwikiRole.findFirst({
      where: {
        spaceId,
        userId: profileId,
        status: 'active',
        role: { in: [...allowedRoles] }
      },
      select: { id: true }
    });
    return Boolean(role);
  }
}

function normalizeRequestIp(value: string | null): { readonly address: string; readonly family: 4 | 6 } | null {
  if (!value) return null;
  try {
    const normalized = normalizeIpOrCidr(value);
    const maximumPrefix = normalized.family === 4 ? 32 : 128;
    return normalized.prefixLength === maximumPrefix
      ? { address: normalized.address, family: normalized.family }
      : null;
  } catch {
    return null;
  }
}

const TARGET_SPECIFICITY = {
  site: 0,
  namespace: 1,
  space: 2,
  page: 3
} as const;

function targetSpecificity(targetType: string): number {
  const specificity = TARGET_SPECIFICITY[targetType as keyof typeof TARGET_SPECIFICITY];
  if (specificity === undefined) {
    throw new Error(`Unsupported ACL target type: ${targetType}`);
  }
  return specificity;
}

function stripAclPrefix(value: string, subjectType: string): string {
  return value.replace(new RegExp(`^${subjectType}:`), '');
}

function safeBigInt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function batchSubjectCacheKey(
  rule: { readonly subjectType: string; readonly subjectValue: string },
  resource: WikiAclResource
): string {
  if (rule.subjectType !== 'role') return `${rule.subjectType}:${rule.subjectValue}`;
  const role = stripAclPrefix(rule.subjectValue, 'role');
  if (role === 'owner_user' || role === 'page_contributor') {
    return `role:${role}:page:${resource.pageId?.toString() ?? ''}`;
  }
  return `role:${role}:space:${resource.spaceId?.toString() ?? ''}`;
}

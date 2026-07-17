import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { WikiAdminService } from './wiki-admin.service';
import { WikiPermissionService, type WikiPermissionActor, type WikiPermissionPage } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { activeAclGroupScopeWhere, aclGroupScopeMatches } from './wiki-acl-group-scope';

const ACL_ACTIONS = ['read', 'edit', 'create', 'move', 'delete', 'revert', 'history', 'raw', 'discuss', 'create_thread', 'write_thread_comment', 'upload_file', 'acl'] as const;
const ACL_EFFECTS = new Set(['allow', 'deny']);
const ACL_SUBJECT_TYPES = new Set(['perm', 'user', 'group', 'aclgroup', 'role']);
const ACL_ROLES = new Set([
  'owner_user', 'page_contributor', 'space_contributor',
  'server_owner', 'server_manager', 'server_editor',
  'mod_wiki_manager', 'mod_wiki_editor'
]);
const CODE_PATTERN = /^[a-z][a-z0-9._:-]{0,127}$/;

export interface WikiPageAclRuleSummary {
  readonly id: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly action: string;
  readonly effect: string;
  readonly subjectType: string;
  readonly subjectValue: string;
  readonly sortOrder: number;
  readonly reason: string | null;
  readonly expiresAt: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

@Injectable()
export class WikiPageAclService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: WikiProfileService,
    private readonly permissions: WikiPermissionService,
    private readonly admin: WikiAdminService
  ) {}

  async getPageAcl(pageId: string, session?: SessionPayload | null) {
    const page = await this.loadPage(pageId);
    await this.permissions.assertCanReadPage({ accountId: session?.userId ?? null, page });
    const actor = await this.actorForSession(session);
    const management = await this.permissions.canManagePageAcl({ actor, page });
    const [rules, groups, aclGroups] = await Promise.all([
      management.allowed ? this.prisma.aclRule.findMany({
        where: { targetType: 'page', targetId: page.id },
        orderBy: [{ action: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }]
      }) : Promise.resolve([]),
      management.allowed ? this.prisma.wikiGroup.findMany({
        orderBy: [{ displayName: 'asc' }],
        select: { code: true, displayName: true }
      }) : Promise.resolve([]),
      management.allowed ? this.prisma.aclGroup.findMany({
        where: activeAclGroupScopeWhere(page.spaceId),
        orderBy: [{ title: 'asc' }],
        select: { groupKey: true, title: true }
      }) : Promise.resolve([])
    ]);
    return {
      page: {
        id: page.id.toString(),
        spaceId: page.spaceId.toString(),
        namespaceId: page.namespaceId,
        title: page.title,
        displayTitle: page.displayTitle,
        protectionLevel: page.protectionLevel
      },
      actions: ACL_ACTIONS,
      rules: rules.map(toRuleSummary),
      canManage: management.allowed,
      manageReason: management.allowed ? management.reason : 'insufficient_permission',
      catalog: {
        groups: groups.map((group) => ({ code: group.code, name: group.displayName })),
        aclGroups: aclGroups.map((group) => ({ key: group.groupKey, name: group.title })),
        roles: management.allowed ? [...ACL_ROLES] : []
      }
    };
  }

  async createRule(pageId: string, session: SessionPayload, input: {
    readonly action?: string;
    readonly effect?: string;
    readonly subjectType?: string;
    readonly subjectValue?: string;
    readonly reason?: string | null;
    readonly expiresAt?: string | null;
  }) {
    const { page, actor } = await this.authorizeMutation(pageId, session);
    const action = input.action?.trim() ?? '';
    const effect = input.effect?.trim() ?? '';
    const subjectType = input.subjectType?.trim() ?? '';
    const subjectValue = input.subjectValue?.trim() ?? '';
    if (!ACL_ACTIONS.includes(action as (typeof ACL_ACTIONS)[number])) throw new BadRequestException('Invalid ACL action.');
    if (!ACL_EFFECTS.has(effect)) throw new BadRequestException('Invalid ACL effect.');
    if (!ACL_SUBJECT_TYPES.has(subjectType)) throw new BadRequestException('Invalid ACL subject type.');
    await this.validateSubject(subjectType, subjectValue, page.spaceId);
    if (input.expiresAt?.trim()) {
      const expiresAt = new Date(input.expiresAt);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        throw new BadRequestException('expiresAt must be a future date.');
      }
    }
    return this.admin.createAclRule({
      targetType: 'page',
      targetId: page.id.toString(),
      action,
      effect,
      subjectType,
      subjectValue,
      reason: input.reason,
      expiresAt: input.expiresAt,
      actorProfileId: actor.profileId
    });
  }

  async deleteRule(pageId: string, ruleId: string, session: SessionPayload, reason?: string | null) {
    const { page, actor } = await this.authorizeMutation(pageId, session);
    const id = parseId(ruleId, 'ruleId');
    const rule = await this.prisma.aclRule.findUnique({ where: { id } });
    if (!rule || rule.targetType !== 'page' || rule.targetId !== page.id) {
      throw new NotFoundException('Page ACL rule not found.');
    }
    return this.admin.deleteAclRule({ ruleId, actorProfileId: actor.profileId, reason });
  }

  async reorderRules(pageId: string, session: SessionPayload, input: {
    readonly action?: string;
    readonly ruleIds?: readonly string[];
    readonly reason?: string | null;
  }) {
    const { page, actor } = await this.authorizeMutation(pageId, session);
    return this.admin.reorderPageAclRules({
      pageId: page.id.toString(),
      action: input.action,
      ruleIds: input.ruleIds,
      reason: input.reason,
      actorProfileId: actor.profileId
    });
  }

  private async authorizeMutation(pageId: string, session: SessionPayload) {
    const page = await this.loadPage(pageId);
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    const actor = this.permissions.actorFromSession(session, profile);
    await this.permissions.assertCanManagePageAcl({ actor, page });
    return { page, actor };
  }

  private async actorForSession(session?: SessionPayload | null): Promise<WikiPermissionActor | null> {
    if (!session) return null;
    const actor = await this.permissions.resolveActor(session.userId);
    return actor ? {
      ...actor,
      isElevated: session.isElevated,
      permissions: session.permissions,
      groups: session.groups
    } : null;
  }

  private async loadPage(pageId: string): Promise<WikiPermissionPage & { displayTitle: string }> {
    const page = await this.prisma.wikiPage.findUnique({
      where: { id: parseId(pageId, 'pageId') },
      select: {
        id: true,
        namespaceId: true,
        spaceId: true,
        title: true,
        displayTitle: true,
        protectionLevel: true,
        status: true,
        createdBy: true
      }
    });
    if (!page) throw new NotFoundException('Wiki page not found.');
    return page;
  }

  private async validateSubject(subjectType: string, subjectValue: string, spaceId: bigint): Promise<void> {
    if (!subjectValue || subjectValue.length > 255) throw new BadRequestException('ACL subject is required.');
    if (subjectType === 'user') {
      const profile = await this.prisma.wikiProfile.findUnique({ where: { id: parseId(subjectValue, 'subjectValue') }, select: { id: true } });
      if (!profile) throw new BadRequestException('ACL user does not exist.');
      return;
    }
    if (subjectType === 'group') {
      if (!CODE_PATTERN.test(subjectValue) || !(await this.prisma.wikiGroup.findUnique({ where: { code: subjectValue }, select: { id: true } }))) {
        throw new BadRequestException('ACL group does not exist.');
      }
      return;
    }
    if (subjectType === 'aclgroup') {
      const group = await this.prisma.aclGroup.findUnique({
        where: { groupKey: subjectValue },
        select: { status: true, scopeType: true, spaceId: true }
      });
      if (!group || group.status !== 'active' || !aclGroupScopeMatches(group, spaceId)) {
        throw new BadRequestException('ACL group does not exist in this wiki space.');
      }
      return;
    }
    if (subjectType === 'role') {
      if (!ACL_ROLES.has(subjectValue)) throw new BadRequestException('Invalid ACL role.');
      return;
    }
    if (!CODE_PATTERN.test(subjectValue)) throw new BadRequestException('Invalid ACL permission.');
  }
}

function parseId(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) throw new BadRequestException(`${label} must be an unsigned integer.`);
  return BigInt(value);
}

function toRuleSummary(rule: {
  id: bigint;
  targetType: string;
  targetId: bigint | null;
  action: string;
  effect: string;
  subjectType: string;
  subjectValue: string;
  sortOrder: number;
  reason: string | null;
  expiresAt: Date | null;
  createdBy: bigint | null;
  createdAt: Date;
  updatedAt: Date;
}): WikiPageAclRuleSummary {
  return {
    id: rule.id.toString(), targetType: rule.targetType, targetId: rule.targetId?.toString() ?? null,
    action: rule.action, effect: rule.effect, subjectType: rule.subjectType, subjectValue: rule.subjectValue,
    sortOrder: rule.sortOrder, reason: rule.reason, expiresAt: rule.expiresAt?.toISOString() ?? null,
    createdBy: rule.createdBy?.toString() ?? null, createdAt: rule.createdAt.toISOString(), updatedAt: rule.updatedAt.toISOString()
  };
}

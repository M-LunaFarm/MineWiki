import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import type { SessionPayload } from '../session/session.service';
import { WikiPermissionService, type WikiPermissionActor } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiDiscussionLiveService } from './wiki-discussion-live.service';
import { activeAclGroupScopeWhere, aclGroupScopeMatches } from './wiki-acl-group-scope';

const THREAD_ACL_ACTIONS = ['read', 'write_thread_comment'] as const;
const THREAD_ACL_EFFECTS = new Set(['allow', 'deny']);
const THREAD_ACL_SUBJECT_TYPES = new Set(['perm', 'user', 'group', 'aclgroup', 'role']);
const THREAD_ACL_PERMISSIONS = new Set(['any', 'guest', 'member', 'autoconfirmed', 'trusted', 'moderator', 'admin', 'developer']);
const THREAD_ACL_ROLES = new Set([
  'owner_user', 'page_contributor', 'space_contributor',
  'server_owner', 'server_manager', 'server_editor',
  'mod_wiki_manager', 'mod_wiki_editor'
]);
const CODE_PATTERN = /^[a-z][a-z0-9._:-]{0,127}$/;

type ThreadAclAction = (typeof THREAD_ACL_ACTIONS)[number];
type ThreadAclRule = Awaited<ReturnType<PrismaService['aclRule']['findFirstOrThrow']>>;

@Injectable()
export class WikiThreadAclService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: WikiProfileService,
    private readonly permissions: WikiPermissionService,
    @Optional() private readonly events?: BusinessEventService,
    @Optional() private readonly live?: WikiDiscussionLiveService
  ) {}

  async getThreadAcl(threadIdValue: string, session?: SessionPayload | null) {
    const { thread, page } = await this.loadThread(threadIdValue);
    const actor = await this.actorForSession(session);
    const management = await this.permissions.canManageThreadAcl({ actor, thread, page });
    if (!management.allowed) {
      await this.permissions.assertCanReadThread({
        accountId: session?.userId ?? null,
        actor,
        thread,
        page
      });
    }
    const [rules, groups, aclGroups] = await Promise.all([
      this.rulesForThread(thread.id),
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
    const now = Date.now();
    const activeWriteRules = rules.some((rule) =>
      rule.action === 'write_thread_comment' && (!rule.expiresAt || rule.expiresAt.getTime() > now)
    );
    return {
      thread: { id: thread.id.toString(), pageId: thread.pageId.toString(), title: thread.title, status: thread.status },
      page: {
        id: page.id.toString(), spaceId: page.spaceId.toString(), namespaceId: page.namespaceId,
        title: page.title, displayTitle: page.displayTitle
      },
      actions: THREAD_ACL_ACTIONS,
      rules: rules.map(toRuleSummary),
      ruleSetHash: ruleSetHash(rules),
      canManage: management.allowed,
      manageReason: management.reason,
      inheritance: {
        read: 'page-boundary' as const,
        writeThreadComment: activeWriteRules ? 'thread-closed' as const : 'page' as const
      },
      catalog: {
        groups: groups.map((group) => ({ code: group.code, name: group.displayName })),
        aclGroups: aclGroups.map((group) => ({ key: group.groupKey, name: group.title })),
        roles: management.allowed ? [...THREAD_ACL_ROLES] : []
      }
    };
  }

  async createRule(threadIdValue: string, session: SessionPayload, input: {
    readonly action?: string;
    readonly effect?: string;
    readonly subjectType?: string;
    readonly subjectValue?: string;
    readonly reason?: string | null;
    readonly expiresAt?: string | null;
  }) {
    const action = this.action(input.action);
    const effect = input.effect?.trim() ?? '';
    const subjectType = input.subjectType?.trim() ?? '';
    const subjectValue = input.subjectValue?.trim() ?? '';
    if (!THREAD_ACL_EFFECTS.has(effect)) throw new BadRequestException('Invalid ACL effect.');
    if (!THREAD_ACL_SUBJECT_TYPES.has(subjectType)) throw new BadRequestException('Invalid ACL subject type.');
    if (subjectType === 'perm' && !THREAD_ACL_PERMISSIONS.has(subjectValue)) {
      throw new BadRequestException('Invalid ACL permission.');
    }
    if (subjectType === 'role' && !THREAD_ACL_ROLES.has(subjectValue)) {
      throw new BadRequestException('Invalid ACL role.');
    }
    const expiresAt = parseOptionalFutureDate(input.expiresAt);
    const reason = requiredReason(input.reason);
    const { thread, page, actor } = await this.authorizeMutation(threadIdValue, session);
    await this.validateSubject(subjectType, subjectValue, page.spaceId);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      await lockThread(tx, thread.id);
      const currentThread = await tx.wikiDiscussionThread.findUnique({ where: { id: thread.id } });
      const currentPage = currentThread ? await tx.wikiPage.findUnique({ where: { id: currentThread.pageId } }) : null;
      await this.permissions.assertCanManageThreadAcl({ actor, thread: currentThread, page: currentPage, store: tx });
      const aggregate = await tx.aclRule.aggregate({
        where: { targetType: 'thread', targetId: thread.id, action },
        _max: { sortOrder: true }
      });
      const rule = await tx.aclRule.create({
        data: {
          targetType: 'thread', targetId: thread.id, action, effect, subjectType, subjectValue,
          sortOrder: (aggregate._max.sortOrder ?? 0) + 10,
          reason, expiresAt, createdBy: actor.profileId, createdAt: now, updatedAt: now
        }
      });
      await tx.aclChangeLog.create({
        data: {
          targetType: 'thread', targetId: thread.id, actionType: 'create', oldRuleJson: null,
          newRuleJson: toRuleSummary(rule), reason, changedBy: actor.profileId, createdAt: now
        }
      });
      const rules = await tx.aclRule.findMany({
        where: { targetType: 'thread', targetId: thread.id },
        orderBy: [{ action: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }]
      });
      return { rule, rules };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.live?.publish(thread.id);
    await this.audit('wiki.thread_acl.create', session, actor.profileId, thread.id, page.id, {
      ruleId: result.rule.id.toString(), action, effect, subjectType, subjectValue, reason
    });
    return { rule: toRuleSummary(result.rule), ruleSetHash: ruleSetHash(result.rules) };
  }

  async deleteRule(
    threadIdValue: string,
    ruleIdValue: string,
    session: SessionPayload,
    reasonInput?: string | null
  ) {
    const ruleId = parseId(ruleIdValue, 'ruleId');
    const reason = requiredReason(reasonInput);
    const { thread, page, actor } = await this.authorizeMutation(threadIdValue, session);
    const now = new Date();
    const remaining = await this.prisma.$transaction(async (tx) => {
      await lockThread(tx, thread.id);
      const currentThread = await tx.wikiDiscussionThread.findUnique({ where: { id: thread.id } });
      const currentPage = currentThread ? await tx.wikiPage.findUnique({ where: { id: currentThread.pageId } }) : null;
      await this.permissions.assertCanManageThreadAcl({ actor, thread: currentThread, page: currentPage, store: tx });
      const rule = await tx.aclRule.findUnique({ where: { id: ruleId } });
      if (!rule || rule.targetType !== 'thread' || rule.targetId !== thread.id) {
        throw new NotFoundException('Wiki discussion ACL rule not found.');
      }
      await tx.aclRule.delete({ where: { id: rule.id } });
      await tx.aclChangeLog.create({
        data: {
          targetType: 'thread', targetId: thread.id, actionType: 'delete', oldRuleJson: toRuleSummary(rule),
          newRuleJson: null, reason, changedBy: actor.profileId, createdAt: now
        }
      });
      return tx.aclRule.findMany({
        where: { targetType: 'thread', targetId: thread.id },
        orderBy: [{ action: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }]
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.live?.publish(thread.id);
    await this.audit('wiki.thread_acl.delete', session, actor.profileId, thread.id, page.id, {
      ruleId: ruleId.toString(), reason
    });
    return { deleted: true as const, ruleId: ruleId.toString(), ruleSetHash: ruleSetHash(remaining) };
  }

  async reorderRules(threadIdValue: string, session: SessionPayload, input: {
    readonly action?: string;
    readonly ruleIds?: readonly string[];
    readonly expectedRuleSetHash?: string;
    readonly reason?: string | null;
  }) {
    const action = this.action(input.action);
    const expectedRuleSetHash = input.expectedRuleSetHash?.trim() ?? '';
    if (!/^[a-f0-9]{64}$/.test(expectedRuleSetHash)) throw new BadRequestException('expectedRuleSetHash is required.');
    const requestedIds = input.ruleIds ?? [];
    if (requestedIds.length === 0 || requestedIds.length > 500) {
      throw new BadRequestException('ruleIds must contain between 1 and 500 rules.');
    }
    const ids = requestedIds.map((id) => parseId(id, 'ruleId'));
    if (new Set(ids.map(String)).size !== ids.length) throw new BadRequestException('ruleIds must not contain duplicates.');
    const reason = requiredReason(input.reason);
    const { thread, page, actor } = await this.authorizeMutation(threadIdValue, session);
    const now = new Date();
    const reordered = await this.prisma.$transaction(async (tx) => {
      await lockThread(tx, thread.id);
      const currentThread = await tx.wikiDiscussionThread.findUnique({ where: { id: thread.id } });
      const currentPage = currentThread ? await tx.wikiPage.findUnique({ where: { id: currentThread.pageId } }) : null;
      await this.permissions.assertCanManageThreadAcl({ actor, thread: currentThread, page: currentPage, store: tx });
      const allRules = await tx.aclRule.findMany({
        where: { targetType: 'thread', targetId: thread.id },
        orderBy: [{ action: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }]
      });
      if (ruleSetHash(allRules) !== expectedRuleSetHash) {
        throw new ConflictException('The discussion ACL rule set changed. Refresh and try again.');
      }
      const current = allRules.filter((rule) => rule.action === action);
      const currentIds = new Set(current.map((rule) => rule.id.toString()));
      if (current.length !== ids.length || ids.some((id) => !currentIds.has(id.toString()))) {
        throw new ConflictException('The discussion ACL rule set changed. Refresh and try again.');
      }
      const rules = [];
      for (let index = 0; index < ids.length; index += 1) {
        rules.push(await tx.aclRule.update({
          where: { id: ids[index] },
          data: { sortOrder: (index + 1) * 10, updatedAt: now }
        }));
      }
      await tx.aclChangeLog.create({
        data: {
          targetType: 'thread', targetId: thread.id, actionType: 'reorder',
          oldRuleJson: current.map(toRuleSummary), newRuleJson: rules.map(toRuleSummary),
          reason, changedBy: actor.profileId, createdAt: now
        }
      });
      const updatedAll = await tx.aclRule.findMany({
        where: { targetType: 'thread', targetId: thread.id },
        orderBy: [{ action: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }]
      });
      return { rules, updatedAll };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.live?.publish(thread.id);
    await this.audit('wiki.thread_acl.reorder', session, actor.profileId, thread.id, page.id, {
      action, ruleIds: ids.map(String), reason
    });
    return { rules: reordered.rules.map(toRuleSummary), ruleSetHash: ruleSetHash(reordered.updatedAll) };
  }

  private async authorizeMutation(threadIdValue: string, session: SessionPayload) {
    const { thread, page } = await this.loadThread(threadIdValue);
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    const actor = this.permissions.actorFromSession(session, profile);
    await this.permissions.assertCanManageThreadAcl({ actor, thread, page });
    return { thread, page, actor };
  }

  private async actorForSession(session?: SessionPayload | null): Promise<WikiPermissionActor | null> {
    if (!session) return null;
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    return this.permissions.actorFromSession(session, profile);
  }

  private async loadThread(threadIdValue: string) {
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id: parseId(threadIdValue, 'threadId') } });
    if (!thread || thread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: thread.pageId } });
    if (!page) throw new NotFoundException('Wiki discussion thread not found.');
    return { thread, page };
  }

  private rulesForThread(threadId: bigint) {
    return this.prisma.aclRule.findMany({
      where: { targetType: 'thread', targetId: threadId },
      orderBy: [{ action: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }]
    });
  }

  private action(value?: string): ThreadAclAction {
    const action = value?.trim() ?? '';
    if (!THREAD_ACL_ACTIONS.includes(action as ThreadAclAction)) throw new BadRequestException('Invalid discussion ACL action.');
    return action as ThreadAclAction;
  }

  private async validateSubject(subjectType: string, subjectValue: string, spaceId: bigint): Promise<void> {
    if (!subjectValue || subjectValue.length > 255) throw new BadRequestException('ACL subject is required.');
    if (subjectType === 'user') {
      const profile = await this.prisma.wikiProfile.findUnique({
        where: { id: parseId(subjectValue, 'subjectValue') }, select: { id: true }
      });
      if (!profile) throw new BadRequestException('ACL user does not exist.');
      return;
    }
    if (subjectType === 'group') {
      const group = CODE_PATTERN.test(subjectValue)
        ? await this.prisma.wikiGroup.findUnique({ where: { code: subjectValue }, select: { id: true } })
        : null;
      if (!group) throw new BadRequestException('ACL group does not exist.');
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
      if (!THREAD_ACL_ROLES.has(subjectValue)) throw new BadRequestException('Invalid ACL role.');
      return;
    }
    if (!THREAD_ACL_PERMISSIONS.has(subjectValue)) throw new BadRequestException('Invalid ACL permission.');
  }

  private async audit(
    action: string,
    session: SessionPayload,
    actorProfileId: bigint,
    threadId: bigint,
    pageId: bigint,
    metadata: Record<string, unknown>
  ) {
    await this.events?.audit(action, {
      category: 'wiki', actorAccountId: session.userId, actorProfileId,
      subjectType: 'wiki_discussion_acl', subjectId: threadId.toString(),
      metadata: { pageId: pageId.toString(), ...metadata }
    });
  }
}

async function lockThread(tx: Prisma.TransactionClient, threadId: bigint): Promise<void> {
  const queryable = tx as unknown as { $queryRaw?: unknown };
  if (typeof queryable.$queryRaw !== 'function') return;
  await tx.$queryRaw<Array<{ id: bigint }>>`SELECT id FROM wiki_discussion_threads WHERE id = ${threadId} FOR UPDATE`;
}

function parseId(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) throw new BadRequestException(`${label} must be an unsigned integer.`);
  return BigInt(value);
}

function requiredReason(value?: string | null): string {
  const reason = value?.trim() ?? '';
  if (!reason || reason.length > 1000) throw new BadRequestException('reason must contain between 1 and 1000 characters.');
  return reason;
}

function parseOptionalFutureDate(value?: string | null): Date | null {
  if (!value?.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    throw new BadRequestException('expiresAt must be a future date.');
  }
  return date;
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
}) {
  return {
    id: rule.id.toString(), targetType: rule.targetType, targetId: rule.targetId?.toString() ?? null,
    action: rule.action, effect: rule.effect, subjectType: rule.subjectType, subjectValue: rule.subjectValue,
    sortOrder: rule.sortOrder, reason: rule.reason, expiresAt: rule.expiresAt?.toISOString() ?? null,
    createdBy: rule.createdBy?.toString() ?? null, createdAt: rule.createdAt.toISOString(), updatedAt: rule.updatedAt.toISOString()
  };
}

function ruleSetHash(rules: readonly ThreadAclRule[]): string {
  return createHash('sha256').update(JSON.stringify(rules.map((rule) => ({
    id: rule.id.toString(), action: rule.action, effect: rule.effect,
    subjectType: rule.subjectType, subjectValue: rule.subjectValue, sortOrder: rule.sortOrder,
    reason: rule.reason, expiresAt: rule.expiresAt?.toISOString() ?? null,
    updatedAt: rule.updatedAt.toISOString()
  })))).digest('hex');
}

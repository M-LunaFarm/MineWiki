import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { hashContent, parseMarkup, renderDocument, WIKI_RENDERER_VERSION } from '@minewiki/wiki-core';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import { WikiLinkIndexService } from './wiki-link-index.service';
import { WikiRoutePathResolver } from './wiki-route-path.resolver';

const ALLOWED_PROTECTION_LEVELS = new Set([
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
const ALLOWED_REVISION_VISIBILITIES = new Set(['public', 'hidden', 'deleted', 'private']);
const ACL_TARGET_TYPES = new Set(['site', 'namespace', 'space', 'page']);
const ACL_ACTIONS = new Set(['read', 'edit', 'create', 'move', 'delete', 'revert', 'history', 'raw', 'discuss', 'create_thread', 'write_thread_comment', 'upload_file', 'acl']);
const ACL_EFFECTS = new Set(['allow', 'deny']);
const ACL_SUBJECT_TYPES = new Set(['perm', 'user', 'group', 'aclgroup', 'role']);

export interface WikiAdminRecentChange {
  readonly id: string;
  readonly pageId: string | null;
  readonly revisionId: string | null;
  readonly actorId: string | null;
  readonly changeType: string;
  readonly title: string;
  readonly namespaceCode: string;
  readonly summary: string | null;
  readonly createdAt: string;
}

export interface WikiAdminPageSummary {
  readonly id: string;
  readonly namespaceId: number;
  readonly spaceId: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly protectionLevel: string;
  readonly status: string;
  readonly currentRevisionId: string | null;
  readonly updatedAt: string;
  readonly namespaceCode?: string;
  readonly routePath?: string;
}

export interface WikiAdminRevisionSummary {
  readonly id: string;
  readonly pageId: string;
  readonly revisionNo: number;
  readonly parentRevisionId: string | null;
  readonly contentSize: number;
  readonly editSummary: string | null;
  readonly isMinor: boolean;
  readonly createdBy: string | null;
  readonly createdByName: string;
  readonly createdAt: string;
  readonly visibility: string;
  readonly isCurrent: boolean;
}

export interface WikiAdminRevisionPage {
  readonly page: WikiAdminPageSummary;
  readonly items: WikiAdminRevisionSummary[];
  readonly nextCursor: string | null;
}

export interface WikiAdminRevisionDetail extends WikiAdminRevisionSummary {
  readonly contentRaw: string;
  readonly contentHash: string;
  readonly syntaxVersion: string;
  readonly page: WikiAdminPageSummary;
}

export interface WikiAdminUserSummary {
  readonly id: string;
  readonly accountId: string | null;
  readonly username: string;
  readonly displayName: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WikiUserBlockEventSummary {
  readonly id: string;
  readonly targetProfileId: string;
  readonly targetName: string;
  readonly actorProfileId: string;
  readonly actorName: string;
  readonly action: string;
  readonly previousStatus: string;
  readonly newStatus: string;
  readonly reason: string;
  readonly createdAt: string;
}

@Injectable()
export class WikiAdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly events?: BusinessEventService,
    @Optional() private readonly wikiLinks?: WikiLinkIndexService,
    @Optional() private readonly routePaths?: WikiRoutePathResolver
  ) {}

  async getRecent(): Promise<WikiAdminRecentChange[]> {
    const changes = await this.prisma.wikiRecentChange.findMany({
      orderBy: [{ createdAt: 'desc' }],
      take: 100
    });
    return changes.map((change) => ({
      id: change.id.toString(),
      pageId: change.pageId?.toString() ?? null,
      revisionId: change.revisionId?.toString() ?? null,
      actorId: change.actorId?.toString() ?? null,
      changeType: change.changeType,
      title: change.title,
      namespaceCode: change.namespaceCode,
      summary: change.summary,
      createdAt: change.createdAt.toISOString()
    }));
  }

  async getPages(status?: string): Promise<WikiAdminPageSummary[]> {
    const pages = await this.prisma.wikiPage.findMany({
      where: status?.trim() ? { status: status.trim() } : undefined,
      orderBy: [{ updatedAt: 'desc' }],
      take: 100
    });
    return this.toPageSummaries(pages);
  }

  async getPageRevisions(pageIdValue: string, cursorValue?: string, limitValue?: string): Promise<WikiAdminRevisionPage> {
    const pageId = this.parseBigIntId(pageIdValue, 'pageId');
    const cursor = cursorValue?.trim() ? Number(cursorValue) : null;
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1)) {
      throw new BadRequestException('cursor must be a positive revision number.');
    }
    const requestedLimit = limitValue?.trim() ? Number(limitValue) : 50;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      throw new BadRequestException('limit must be a positive integer.');
    }
    const limit = Math.min(requestedLimit, 100);
    const page = await this.prisma.wikiPage.findUnique({ where: { id: pageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const revisions = await this.prisma.wikiPageRevision.findMany({
      where: { pageId, ...(cursor === null ? {} : { revisionNo: { lt: cursor } }) },
      orderBy: [{ revisionNo: 'desc' }],
      take: limit + 1
    });
    const hasMore = revisions.length > limit;
    const items = revisions.slice(0, limit);
    const names = await this.revisionAuthorNames(items);
    return {
      page: (await this.toPageSummaries([page]))[0],
      items: items.map((revision) => toRevisionSummary(revision, page.currentRevisionId, names)),
      nextCursor: hasMore ? String(items[items.length - 1].revisionNo) : null
    };
  }

  async getRevision(revisionIdValue: string): Promise<WikiAdminRevisionDetail> {
    const revisionId = this.parseBigIntId(revisionIdValue, 'revisionId');
    const revision = await this.prisma.wikiPageRevision.findUnique({ where: { id: revisionId } });
    if (!revision) throw new NotFoundException('Wiki revision not found.');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: revision.pageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const names = await this.revisionAuthorNames([revision]);
    return {
      ...toRevisionSummary(revision, page.currentRevisionId, names),
      contentRaw: revision.contentRaw,
      contentHash: revision.contentHash,
      syntaxVersion: revision.syntaxVersion,
      page: (await this.toPageSummaries([page]))[0]
    };
  }

  async getUsers(query?: string): Promise<WikiAdminUserSummary[]> {
    const q = query?.trim().slice(0, 64) ?? '';
    const users = await this.prisma.wikiProfile.findMany({
      where: q ? { OR: [{ username: { contains: q } }, { displayName: { contains: q } }] } : undefined,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 100
    });
    return users.map((user) => ({
      id: user.id.toString(),
      accountId: user.accountId,
      username: user.username,
      displayName: user.displayName,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString()
    }));
  }

  async getUserBlockEvents(targetProfileId?: string): Promise<WikiUserBlockEventSummary[]> {
    const targetId = targetProfileId ? this.parseBigIntId(targetProfileId, 'targetProfileId') : null;
    const events = await this.prisma.wikiUserBlockEvent.findMany({
      where: targetId ? { targetProfileId: targetId } : undefined,
      orderBy: [{ id: 'desc' }],
      take: 100
    });
    const profileIds = [...new Set(events.flatMap((event) => [event.targetProfileId, event.actorProfileId]))];
    const profiles = profileIds.length > 0
      ? await this.prisma.wikiProfile.findMany({ where: { id: { in: profileIds } }, select: { id: true, displayName: true } })
      : [];
    const names = new Map(profiles.map((profile) => [profile.id, profile.displayName]));
    return events.map((event) => ({
      id: event.id.toString(),
      targetProfileId: event.targetProfileId.toString(),
      targetName: names.get(event.targetProfileId) ?? '알 수 없는 사용자',
      actorProfileId: event.actorProfileId.toString(),
      actorName: names.get(event.actorProfileId) ?? '알 수 없는 관리자',
      action: event.action,
      previousStatus: event.previousStatus,
      newStatus: event.newStatus,
      reason: event.reason,
      createdAt: event.createdAt.toISOString()
    }));
  }

  async setUserBlocked(input: {
    readonly targetProfileId: string;
    readonly actorProfileId: bigint;
    readonly blocked: boolean;
    readonly reason?: string;
  }): Promise<WikiAdminUserSummary> {
    const targetId = this.parseBigIntId(input.targetProfileId, 'targetProfileId');
    if (targetId === input.actorProfileId) throw new BadRequestException('자기 자신의 위키 기여 권한은 변경할 수 없습니다.');
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 5 || reason.length > 1000) throw new BadRequestException('사유는 5자 이상 1000자 이하로 입력하세요.');
    const newStatus = input.blocked ? 'blocked' : 'active';
    const previousStatus = input.blocked ? 'active' : 'blocked';
    const now = new Date();
    const updated = await this.prisma.$transaction(
      async (tx) => {
        const target = await tx.wikiProfile.findUnique({ where: { id: targetId } });
        if (!target) throw new NotFoundException('Wiki profile not found.');
        if (target.accountId) {
          const protectedRoles = await tx.accountRole.findMany({
            where: { accountId: target.accountId },
            include: { role: true }
          });
          if (protectedRoles.some((entry) => entry.role.code === 'owner' || entry.role.code === 'admin')) {
            throw new BadRequestException('보호된 운영자 계정의 위키 기여 권한은 이 화면에서 변경할 수 없습니다.');
          }
        }
        if (target.status !== previousStatus) {
          throw new ConflictException(input.blocked ? '이미 차단되었거나 상태가 변경된 사용자입니다.' : '이미 해제되었거나 상태가 변경된 사용자입니다.');
        }
        const changed = await tx.wikiProfile.updateMany({
          where: { id: target.id, status: previousStatus },
          data: { status: newStatus, updatedAt: now }
        });
        if (changed.count !== 1) {
          throw new ConflictException('사용자 상태가 동시에 변경되었습니다. 새로고침 후 다시 시도하세요.');
        }
        await tx.wikiUserBlockEvent.create({
          data: {
            targetProfileId: target.id,
            actorProfileId: input.actorProfileId,
            action: input.blocked ? 'block' : 'unblock',
            previousStatus,
            newStatus,
            reason,
            createdAt: now
          }
        });
        return { ...target, status: newStatus, updatedAt: now };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    await this.events?.audit(input.blocked ? 'wiki.user_block' : 'wiki.user_unblock', {
      category: 'wiki',
      actorProfileId: input.actorProfileId,
      subjectType: 'wiki_profile',
      subjectId: targetId,
      metadata: { previousStatus, status: newStatus, reason }
    });
    return {
      id: updated.id.toString(), accountId: updated.accountId, username: updated.username,
      displayName: updated.displayName, status: updated.status,
      createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString()
    };
  }

  async getAclRules() {
    const rules = await this.prisma.aclRule.findMany({
      orderBy: [{ targetType: 'asc' }, { targetId: 'asc' }, { action: 'asc' }, { sortOrder: 'asc' }],
      take: 500
    });
    return rules.map(toAclRuleSummary);
  }

  async getAclCatalog() {
    const [namespaces, spaces, pages, groups, aclGroups] = await Promise.all([
      this.prisma.wikiNamespace.findMany({ orderBy: [{ id: 'asc' }] }),
      this.prisma.wikiSpace.findMany({
        where: { status: 'active' },
        orderBy: [{ name: 'asc' }],
        take: 500,
        select: { id: true, name: true, spaceType: true, rootPath: true }
      }),
      this.prisma.wikiPage.findMany({
        where: { status: { not: 'deleted' } },
        orderBy: [{ updatedAt: 'desc' }],
        take: 500,
        select: { id: true, displayTitle: true, spaceId: true }
      }),
      this.prisma.wikiGroup.findMany({ orderBy: [{ displayName: 'asc' }] }),
      this.prisma.aclGroup.findMany({
        orderBy: [{ status: 'asc' }, { title: 'asc' }],
        select: { id: true, groupKey: true, title: true, status: true }
      })
    ]);
    return {
      namespaces: namespaces.map((item) => ({ id: String(item.id), code: item.code, name: item.displayName })),
      spaces: spaces.map((item) => ({ id: item.id.toString(), name: item.name, type: item.spaceType, path: item.rootPath })),
      pages: pages.map((item) => ({ id: item.id.toString(), name: item.displayTitle, spaceId: item.spaceId.toString() })),
      groups: groups.map((item) => ({ code: item.code, name: item.displayName })),
      aclGroups: aclGroups.map((item) => ({ id: item.id.toString(), key: item.groupKey, name: item.title, status: item.status }))
    };
  }

  async createAclRule(input: {
    readonly targetType?: string;
    readonly targetId?: string | null;
    readonly action?: string;
    readonly effect?: string;
    readonly subjectType?: string;
    readonly subjectValue?: string;
    readonly reason?: string | null;
    readonly expiresAt?: string | null;
    readonly actorProfileId: bigint;
  }) {
    const targetType = input.targetType?.trim() ?? '';
    const action = input.action?.trim() ?? '';
    const effect = input.effect?.trim() ?? '';
    const subjectType = input.subjectType?.trim() ?? '';
    const subjectValue = input.subjectValue?.trim() ?? '';
    if (!ACL_TARGET_TYPES.has(targetType) || !ACL_ACTIONS.has(action) || !ACL_EFFECTS.has(effect) || !ACL_SUBJECT_TYPES.has(subjectType)) {
      throw new BadRequestException('Invalid ACL rule type.');
    }
    if (!subjectValue || subjectValue.length > 255) {
      throw new BadRequestException('ACL subject is required.');
    }
    const targetId = targetType === 'site' ? null : this.parseBigIntId(input.targetId ?? '', 'targetId');
    const expiresAt = parseOptionalDate(input.expiresAt, 'expiresAt');
    const reason = input.reason?.trim().slice(0, 1000) || null;
    const created = await this.prisma.$transaction(async (tx) => {
      const aggregate = await tx.aclRule.aggregate({
        where: { targetType, targetId, action },
        _max: { sortOrder: true }
      });
      const rule = await tx.aclRule.create({
        data: {
          targetType,
          targetId,
          action,
          effect,
          subjectType,
          subjectValue,
          sortOrder: (aggregate._max.sortOrder ?? 0) + 10,
          reason,
          expiresAt,
          createdBy: input.actorProfileId,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      });
      await tx.aclChangeLog.create({
        data: {
          targetType,
          targetId,
          actionType: 'create',
          oldRuleJson: null,
          newRuleJson: toAclRuleSummary(rule),
          reason,
          changedBy: input.actorProfileId,
          createdAt: new Date()
        }
      });
      return rule;
    });
    await this.auditAdmin('wiki.acl_create', {
      actorProfileId: input.actorProfileId,
      metadata: { ruleId: created.id.toString(), targetType, targetId: targetId?.toString() ?? null, action, effect, subjectType, subjectValue, reason }
    });
    return toAclRuleSummary(created);
  }

  async deleteAclRule(input: {
    readonly ruleId: string;
    readonly actorProfileId: bigint;
    readonly reason?: string | null;
  }) {
    const id = this.parseBigIntId(input.ruleId, 'ruleId');
    const rule = await this.prisma.aclRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('ACL rule not found.');
    const reason = input.reason?.trim().slice(0, 1000) || null;
    await this.prisma.$transaction([
      this.prisma.aclRule.delete({ where: { id } }),
      this.prisma.aclChangeLog.create({
        data: {
          targetType: rule.targetType,
          targetId: rule.targetId,
          actionType: 'delete',
          oldRuleJson: toAclRuleSummary(rule),
          newRuleJson: null,
          reason,
          changedBy: input.actorProfileId,
          createdAt: new Date()
        }
      })
    ]);
    await this.auditAdmin('wiki.acl_delete', {
      actorProfileId: input.actorProfileId,
      metadata: { ruleId: id.toString(), reason }
    });
    return { deleted: true, ruleId: id.toString() };
  }

  async reorderPageAclRules(input: {
    readonly pageId: string;
    readonly action?: string;
    readonly ruleIds?: readonly string[];
    readonly actorProfileId: bigint;
    readonly reason?: string | null;
  }) {
    const pageId = this.parseBigIntId(input.pageId, 'pageId');
    const action = input.action?.trim() ?? '';
    if (!ACL_ACTIONS.has(action)) throw new BadRequestException('Invalid ACL action.');
    const requestedIds = input.ruleIds ?? [];
    if (requestedIds.length === 0 || requestedIds.length > 500) {
      throw new BadRequestException('ruleIds must contain between 1 and 500 rules.');
    }
    const ids = requestedIds.map((id) => this.parseBigIntId(id, 'ruleId'));
    if (new Set(ids.map(String)).size !== ids.length) {
      throw new BadRequestException('ruleIds must not contain duplicates.');
    }
    const current = await this.prisma.aclRule.findMany({
      where: { targetType: 'page', targetId: pageId, action },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }]
    });
    const currentIds = new Set(current.map((rule) => rule.id.toString()));
    if (current.length !== ids.length || ids.some((id) => !currentIds.has(id.toString()))) {
      throw new BadRequestException('The ACL rule set changed. Refresh and try again.');
    }
    const oldRules = current.map(toAclRuleSummary);
    const reason = input.reason?.trim().slice(0, 1000) || null;
    const now = new Date();
    const reordered = await this.prisma.$transaction(async (tx) => {
      const rules = [];
      for (let index = 0; index < ids.length; index += 1) {
        rules.push(await tx.aclRule.update({
          where: { id: ids[index] },
          data: { sortOrder: (index + 1) * 10, updatedAt: now }
        }));
      }
      await tx.aclChangeLog.create({
        data: {
          targetType: 'page',
          targetId: pageId,
          actionType: 'reorder',
          oldRuleJson: oldRules,
          newRuleJson: rules.map(toAclRuleSummary),
          reason,
          changedBy: input.actorProfileId,
          createdAt: now
        }
      });
      return rules;
    });
    await this.auditAdmin('wiki.acl_reorder', {
      actorProfileId: input.actorProfileId,
      pageId,
      metadata: { action, ruleIds: ids.map(String), reason }
    });
    return reordered.map(toAclRuleSummary);
  }

  async updateProtection(input: {
    readonly pageId: string;
    readonly protectionLevel?: string;
    readonly actorProfileId: bigint | null;
    readonly reason?: string | null;
  }): Promise<WikiAdminPageSummary> {
    const pageId = this.parseBigIntId(input.pageId, 'pageId');
    const protectionLevel = input.protectionLevel?.trim();
    if (!protectionLevel || !ALLOWED_PROTECTION_LEVELS.has(protectionLevel)) {
      throw new BadRequestException('Invalid wiki protection level.');
    }
    const page = await this.prisma.wikiPage.findUnique({ where: { id: pageId } });
    if (!page) {
      throw new NotFoundException('Wiki page not found.');
    }
    const updated = await this.prisma.wikiPage.update({
      where: { id: pageId },
      data: {
        protectionLevel,
        updatedAt: new Date()
      }
    });
    const namespace = await this.namespaceCode(updated.namespaceId);
    await this.insertRecentChange({
      pageId: updated.id,
      revisionId: updated.currentRevisionId,
      actorId: input.actorProfileId,
      changeType: 'protect',
      title: updated.title,
      namespaceCode: namespace,
      summary: input.reason?.trim() || `보호 수준 변경: ${page.protectionLevel} -> ${protectionLevel}`
    });
    await this.auditAdmin('wiki.protect', {
      actorProfileId: input.actorProfileId,
      pageId: updated.id,
      revisionId: updated.currentRevisionId,
      metadata: {
        previousProtectionLevel: page.protectionLevel,
        protectionLevel,
        reason: input.reason?.trim() || null
      }
    });
    return (await this.toPageSummaries([updated]))[0];
  }

  async updateRevisionVisibility(input: {
    readonly revisionId: string;
    readonly visibility?: string;
    readonly actorProfileId: bigint | null;
    readonly reason?: string | null;
  }): Promise<{ revisionId: string; visibility: string }> {
    const revisionId = this.parseBigIntId(input.revisionId, 'revisionId');
    const visibility = input.visibility?.trim();
    const reason = this.requiredModerationReason(input.reason);
    if (!visibility || !ALLOWED_REVISION_VISIBILITIES.has(visibility)) {
      throw new BadRequestException('Invalid wiki revision visibility.');
    }
    const located = await this.prisma.wikiPageRevision.findUnique({
      where: { id: revisionId },
      select: { pageId: true }
    });
    if (!located) throw new NotFoundException('Wiki revision not found.');
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockPageForRevision(tx, located.pageId);
      const [revision, page] = await Promise.all([
        tx.wikiPageRevision.findUnique({ where: { id: revisionId } }),
        tx.wikiPage.findUnique({ where: { id: located.pageId } })
      ]);
      if (!revision) throw new NotFoundException('Wiki revision not found.');
      if (!page) throw new NotFoundException('Wiki page not found.');
      const updated = await tx.wikiPageRevision.update({
        where: { id: revisionId },
        data: { visibility }
      });
      if (page.currentRevisionId === revisionId && visibility !== 'public') {
        const fallback = await tx.wikiPageRevision.findFirst({
          where: {
            pageId: revision.pageId,
            visibility: 'public',
            id: { not: revisionId }
          },
          orderBy: [{ revisionNo: 'desc' }]
        });
        await tx.wikiPage.update({
          where: { id: revision.pageId },
          data: {
            currentRevisionId: fallback?.id ?? null,
            updatedAt: new Date()
          }
        });
      }
      const namespace = await tx.wikiNamespace.findUnique({ where: { id: page.namespaceId } });
      await this.insertRecentChange({
        pageId: page.id,
        revisionId: updated.id,
        actorId: input.actorProfileId,
        changeType: 'revision_visibility',
        title: page.title,
        namespaceCode: namespace?.code ?? 'main',
        summary: reason
      }, tx);
      return { updated, page };
    });
    await this.auditAdmin('wiki.revision_visibility', {
      actorProfileId: input.actorProfileId,
      pageId: result.page.id,
      revisionId: result.updated.id,
      metadata: {
        visibility,
        reason
      }
    });
    return { revisionId: result.updated.id.toString(), visibility: result.updated.visibility };
  }

  async rollback(input: {
    readonly pageId: string;
    readonly revisionId?: string;
    readonly actorProfileId: bigint;
    readonly reason?: string | null;
  }): Promise<{ pageId: string; revisionId: string; revisionNo: number }> {
    const pageId = this.parseBigIntId(input.pageId, 'pageId');
    const reason = this.requiredModerationReason(input.reason);
    const sourceRevisionId = input.revisionId
      ? this.parseBigIntId(input.revisionId, 'revisionId')
      : null;
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockPageForRevision(tx, pageId);
      const page = await tx.wikiPage.findUnique({ where: { id: pageId } });
      if (!page || page.status === 'deleted') throw new NotFoundException('Wiki page not found.');
      const [source, current, latestStored, namespace] = await Promise.all([
        sourceRevisionId
          ? tx.wikiPageRevision.findUnique({ where: { id: sourceRevisionId } })
          : tx.wikiPageRevision.findFirst({
              where: { pageId, visibility: 'public' },
              orderBy: [{ revisionNo: 'asc' }]
            }),
        page.currentRevisionId
          ? tx.wikiPageRevision.findUnique({ where: { id: page.currentRevisionId } })
          : Promise.resolve(null),
        tx.wikiPageRevision.findFirst({
          where: { pageId },
          orderBy: [{ revisionNo: 'desc' }]
        }),
        tx.wikiNamespace.findUnique({ where: { id: page.namespaceId } })
      ]);
      if (!source || source.pageId !== page.id || source.visibility !== 'public') {
        throw new NotFoundException('Rollback source revision not found.');
      }
      const now = new Date();
      const parsed = parseMarkup(source.contentRaw);
      if (parsed.blockingErrors.length > 0) {
        throw new BadRequestException('Rollback source contains blocking wiki markup.');
      }
      const revision = await tx.wikiPageRevision.create({
        data: {
          pageId: page.id,
          revisionNo: latestStored ? latestStored.revisionNo + 1 : 1,
          parentRevisionId: current?.id ?? null,
          contentRaw: source.contentRaw,
          contentAst: JSON.parse(JSON.stringify(parsed.ast)),
          contentHash: hashContent(source.contentRaw),
          contentSize: Buffer.byteLength(source.contentRaw, 'utf8'),
          syntaxVersion: source.syntaxVersion,
          editSummary: reason,
          isMinor: false,
          editTags: null,
          createdBy: input.actorProfileId,
          actorType: 'user',
          actorUserId: input.actorProfileId,
          actorIp: null,
          actorIpText: null,
          actorIpHash: null,
          createdAt: now,
          visibility: 'public'
        }
      });
      if (parsed.includes.length === 0) {
        await tx.wikiPageRenderCache.create({
          data: {
            pageId: page.id,
            revisionId: revision.id,
            rendererVersion: WIKI_RENDERER_VERSION,
            html: renderDocument(parsed.ast),
            createdAt: now
          }
        });
      }
      await this.wikiLinks?.replaceForRevision(
        tx,
        page.id,
        revision.id,
        parsed.links,
        parsed.categories,
        parsed.includes,
        { contentSize: revision.contentSize, contentRaw: revision.contentRaw }
      );
      await tx.wikiPage.update({
        where: { id: page.id },
        data: { currentRevisionId: revision.id, updatedAt: now }
      });
      await this.insertRecentChange({
        pageId: page.id,
        revisionId: revision.id,
        actorId: input.actorProfileId,
        changeType: 'rollback',
        title: page.title,
        namespaceCode: namespace?.code ?? 'main',
        summary: revision.editSummary
      }, tx);
      return { page, revision, source };
    });
    await this.auditAdmin('wiki.rollback', {
      actorProfileId: input.actorProfileId,
      pageId: result.page.id,
      revisionId: result.revision.id,
      metadata: {
        sourceRevisionId: result.source.id.toString(),
        sourceRevisionNo: result.source.revisionNo,
        reason
      }
    });
    return {
      pageId: result.page.id.toString(),
      revisionId: result.revision.id.toString(),
      revisionNo: result.revision.revisionNo
    };
  }

  async setPageStatus(input: {
    readonly pageId: string;
    readonly status: 'deleted' | 'normal';
    readonly actorProfileId: bigint | null;
    readonly reason?: string | null;
  }): Promise<WikiAdminPageSummary> {
    const pageId = this.parseBigIntId(input.pageId, 'pageId');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: pageId } });
    if (!page) {
      throw new NotFoundException('Wiki page not found.');
    }
    const updated = await this.prisma.wikiPage.update({
      where: { id: pageId },
      data: {
        status: input.status,
        updatedAt: new Date()
      }
    });
    await this.insertRecentChange({
      pageId: updated.id,
      revisionId: updated.currentRevisionId,
      actorId: input.actorProfileId,
      changeType: input.status === 'deleted' ? 'delete' : 'restore',
      title: updated.title,
      namespaceCode: await this.namespaceCode(updated.namespaceId),
      summary: input.reason?.trim() || (input.status === 'deleted' ? '관리자 삭제' : '관리자 복구')
    });
    await this.auditAdmin(input.status === 'deleted' ? 'wiki.delete' : 'wiki.restore', {
      actorProfileId: input.actorProfileId,
      pageId: updated.id,
      revisionId: updated.currentRevisionId,
      metadata: {
        previousStatus: page.status,
        status: input.status,
        reason: input.reason?.trim() || null
      }
    });
    return (await this.toPageSummaries([updated]))[0];
  }

  private async insertRecentChange(input: {
    readonly pageId: bigint;
    readonly revisionId: bigint | null;
    readonly actorId: bigint | null;
    readonly changeType: string;
    readonly title: string;
    readonly namespaceCode: string;
    readonly summary?: string | null;
  }, store: Pick<PrismaService, 'wikiRecentChange'> = this.prisma): Promise<void> {
    await store.wikiRecentChange.create({
      data: {
        pageId: input.pageId,
        revisionId: input.revisionId,
        actorId: input.actorId,
        changeType: input.changeType,
        title: input.title,
        namespaceCode: input.namespaceCode,
        summary: input.summary ?? null,
        isMinor: false,
        createdAt: new Date()
      }
    });
  }

  private async lockPageForRevision(tx: Prisma.TransactionClient, pageId: bigint): Promise<void> {
    await tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id
      FROM pages
      WHERE id = ${pageId}
      FOR UPDATE
    `;
  }

  private async auditAdmin(
    action: string,
    input: {
      readonly actorProfileId: bigint | null;
      readonly pageId?: bigint | null;
      readonly revisionId?: bigint | null;
      readonly metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    await this.events?.audit(action, {
      category: 'wiki',
      actorProfileId: input.actorProfileId,
      subjectType: input.pageId ? 'wiki_page' : 'wiki_acl',
      subjectId: input.pageId ?? null,
      metadata: {
        pageId: input.pageId ?? null,
        revisionId: input.revisionId ?? null,
        ...input.metadata
      }
    });
  }

  private async namespaceCode(namespaceId: number): Promise<string> {
    const namespace = await this.prisma.wikiNamespace.findUnique({ where: { id: namespaceId } });
    return namespace?.code ?? 'main';
  }

  private async toPageSummaries<T extends Parameters<typeof toPageSummary>[0] & { localPath: string }>(pages: readonly T[]): Promise<WikiAdminPageSummary[]> {
    if (pages.length === 0) return [];
    const routes = await this.routePaths?.preload(pages);
    if (routes) {
      return pages.map((page) => ({
        ...toPageSummary(page),
        namespaceCode: routes.namespace(page),
        routePath: routes.routePath(page)
      }));
    }
    const namespaces = await this.prisma.wikiNamespace.findMany({
      where: { id: { in: [...new Set(pages.map((page) => page.namespaceId))] } },
      select: { id: true, code: true }
    });
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    return pages.map((page) => ({
      ...toPageSummary(page),
      namespaceCode: namespaceById.get(page.namespaceId) ?? 'main'
    }));
  }

  private async revisionAuthorNames(revisions: readonly { createdBy: bigint | null }[]): Promise<ReadonlyMap<bigint, string>> {
    const profileIds = [...new Set(revisions.flatMap((revision) => revision.createdBy === null ? [] : [revision.createdBy]))];
    if (profileIds.length === 0) return new Map();
    const profiles = await this.prisma.wikiProfile.findMany({
      where: { id: { in: profileIds } },
      select: { id: true, displayName: true }
    });
    return new Map(profiles.map((profile) => [profile.id, profile.displayName]));
  }

  private parseBigIntId(value: string, label: string): bigint {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException(`${label} must be an unsigned integer.`);
    }
    return BigInt(value);
  }

  private requiredModerationReason(value?: string | null): string {
    const reason = value?.trim() ?? '';
    if (reason.length < 5 || reason.length > 1000) {
      throw new BadRequestException('Moderation reason must be between 5 and 1000 characters.');
    }
    return reason;
  }
}

function toPageSummary(page: {
  id: bigint;
  namespaceId: number;
  spaceId: bigint;
  title: string;
  displayTitle: string;
  protectionLevel: string;
  status: string;
  currentRevisionId: bigint | null;
  updatedAt: Date;
}): WikiAdminPageSummary {
  return {
    id: page.id.toString(),
    namespaceId: page.namespaceId,
    spaceId: page.spaceId.toString(),
    title: page.title,
    displayTitle: page.displayTitle,
    protectionLevel: page.protectionLevel,
    status: page.status,
    currentRevisionId: page.currentRevisionId?.toString() ?? null,
    updatedAt: page.updatedAt.toISOString()
  };
}

function toRevisionSummary(
  revision: {
    id: bigint;
    pageId: bigint;
    revisionNo: number;
    parentRevisionId: bigint | null;
    contentSize: number;
    editSummary: string | null;
    isMinor: boolean;
    createdBy: bigint | null;
    createdAt: Date;
    visibility: string;
  },
  currentRevisionId: bigint | null,
  authorNames: ReadonlyMap<bigint, string>
): WikiAdminRevisionSummary {
  return {
    id: revision.id.toString(),
    pageId: revision.pageId.toString(),
    revisionNo: revision.revisionNo,
    parentRevisionId: revision.parentRevisionId?.toString() ?? null,
    contentSize: revision.contentSize,
    editSummary: revision.editSummary,
    isMinor: revision.isMinor,
    createdBy: revision.createdBy?.toString() ?? null,
    createdByName: revision.createdBy === null ? '시스템' : authorNames.get(revision.createdBy) ?? '알 수 없는 사용자',
    createdAt: revision.createdAt.toISOString(),
    visibility: revision.visibility,
    isCurrent: revision.id === currentRevisionId
  };
}

function toAclRuleSummary(rule: {
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
    id: rule.id.toString(),
    targetType: rule.targetType,
    targetId: rule.targetId?.toString() ?? null,
    action: rule.action,
    effect: rule.effect,
    subjectType: rule.subjectType,
    subjectValue: rule.subjectValue,
    sortOrder: rule.sortOrder,
    reason: rule.reason,
    expiresAt: rule.expiresAt?.toISOString() ?? null,
    createdBy: rule.createdBy?.toString() ?? null,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString()
  };
}

function parseOptionalDate(value: string | null | undefined, label: string): Date | null {
  if (!value?.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${label} must be a valid date.`);
  }
  return date;
}

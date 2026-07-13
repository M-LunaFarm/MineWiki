import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { hashContent, parseMarkup, renderDocument, WIKI_RENDERER_VERSION } from '@minewiki/wiki-core';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import { WikiLinkIndexService } from './wiki-link-index.service';

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
const ACL_ACTIONS = new Set(['read', 'edit', 'create', 'move', 'delete', 'revert', 'history', 'raw', 'upload_file', 'acl']);
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
}

@Injectable()
export class WikiAdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly events?: BusinessEventService,
    @Optional() private readonly wikiLinks?: WikiLinkIndexService
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
    return pages.map(toPageSummary);
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
        where: { status: 'active' },
        orderBy: [{ title: 'asc' }],
        select: { id: true, groupKey: true, title: true }
      })
    ]);
    return {
      namespaces: namespaces.map((item) => ({ id: String(item.id), code: item.code, name: item.displayName })),
      spaces: spaces.map((item) => ({ id: item.id.toString(), name: item.name, type: item.spaceType, path: item.rootPath })),
      pages: pages.map((item) => ({ id: item.id.toString(), name: item.displayTitle, spaceId: item.spaceId.toString() })),
      groups: groups.map((item) => ({ code: item.code, name: item.displayName })),
      aclGroups: aclGroups.map((item) => ({ id: item.id.toString(), key: item.groupKey, name: item.title }))
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
    return toPageSummary(updated);
  }

  async updateRevisionVisibility(input: {
    readonly revisionId: string;
    readonly visibility?: string;
    readonly actorProfileId: bigint | null;
    readonly reason?: string | null;
  }): Promise<{ revisionId: string; visibility: string }> {
    const revisionId = this.parseBigIntId(input.revisionId, 'revisionId');
    const visibility = input.visibility?.trim();
    if (!visibility || !ALLOWED_REVISION_VISIBILITIES.has(visibility)) {
      throw new BadRequestException('Invalid wiki revision visibility.');
    }
    const revision = await this.prisma.wikiPageRevision.findUnique({ where: { id: revisionId } });
    if (!revision) {
      throw new NotFoundException('Wiki revision not found.');
    }
    const updated = await this.prisma.wikiPageRevision.update({
      where: { id: revisionId },
      data: { visibility }
    });
    const page = await this.prisma.wikiPage.findUnique({ where: { id: revision.pageId } });
    if (page?.currentRevisionId === revisionId && visibility !== 'public') {
      const fallback = await this.prisma.wikiPageRevision.findFirst({
        where: {
          pageId: revision.pageId,
          visibility: 'public',
          id: { not: revisionId }
        },
        orderBy: [{ revisionNo: 'desc' }]
      });
      await this.prisma.wikiPage.update({
        where: { id: revision.pageId },
        data: {
          currentRevisionId: fallback?.id ?? null,
          updatedAt: new Date()
        }
      });
    }
    if (page) {
      await this.insertRecentChange({
        pageId: page.id,
        revisionId: updated.id,
        actorId: input.actorProfileId,
        changeType: 'revision_visibility',
        title: page.title,
        namespaceCode: await this.namespaceCode(page.namespaceId),
        summary: input.reason?.trim() || `리비전 표시 상태 변경: ${visibility}`
      });
      await this.auditAdmin('wiki.revision_visibility', {
        actorProfileId: input.actorProfileId,
        pageId: page.id,
        revisionId: updated.id,
        metadata: {
          visibility,
          reason: input.reason?.trim() || null
        }
      });
    }
    return { revisionId: updated.id.toString(), visibility: updated.visibility };
  }

  async rollback(input: {
    readonly pageId: string;
    readonly revisionId?: string;
    readonly actorProfileId: bigint;
    readonly reason?: string | null;
  }): Promise<{ pageId: string; revisionId: string; revisionNo: number }> {
    const pageId = this.parseBigIntId(input.pageId, 'pageId');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: pageId } });
    if (!page || page.status === 'deleted') {
      throw new NotFoundException('Wiki page not found.');
    }
    const source = input.revisionId
      ? await this.prisma.wikiPageRevision.findUnique({
          where: { id: this.parseBigIntId(input.revisionId, 'revisionId') }
        })
      : await this.prisma.wikiPageRevision.findFirst({
          where: { pageId, visibility: 'public' },
          orderBy: [{ revisionNo: 'asc' }]
        });
    if (!source || source.pageId !== page.id || source.visibility !== 'public') {
      throw new NotFoundException('Rollback source revision not found.');
    }
    const latest = await this.prisma.wikiPageRevision.findFirst({
      where: { pageId, visibility: 'public' },
      orderBy: [{ revisionNo: 'desc' }]
    });
    const now = new Date();
    const parsed = parseMarkup(source.contentRaw);
    if (parsed.blockingErrors.length > 0) {
      throw new BadRequestException('Rollback source contains blocking wiki markup.');
    }
    const revision = await this.prisma.wikiPageRevision.create({
      data: {
        pageId: page.id,
        revisionNo: latest ? latest.revisionNo + 1 : 1,
        parentRevisionId: latest?.id ?? null,
        contentRaw: source.contentRaw,
        contentAst: JSON.parse(JSON.stringify(parsed.ast)),
        contentHash: hashContent(source.contentRaw),
        contentSize: Buffer.byteLength(source.contentRaw, 'utf8'),
        syntaxVersion: source.syntaxVersion,
        editSummary: input.reason?.trim() || `관리자 롤백: r${source.revisionNo}`,
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
    await this.prisma.wikiPageRenderCache.create({
      data: {
        pageId: page.id,
        revisionId: revision.id,
        rendererVersion: WIKI_RENDERER_VERSION,
        html: renderDocument(parsed.ast),
        createdAt: now
      }
    });
    await this.wikiLinks?.replaceForRevision(this.prisma, page.id, revision.id, parsed.links);
    await this.prisma.wikiPage.update({
      where: { id: page.id },
      data: {
        currentRevisionId: revision.id,
        updatedAt: now
      }
    });
    await this.insertRecentChange({
      pageId: page.id,
      revisionId: revision.id,
      actorId: input.actorProfileId,
      changeType: 'rollback',
      title: page.title,
      namespaceCode: await this.namespaceCode(page.namespaceId),
      summary: revision.editSummary
    });
    await this.auditAdmin('wiki.rollback', {
      actorProfileId: input.actorProfileId,
      pageId: page.id,
      revisionId: revision.id,
      metadata: {
        sourceRevisionId: source.id.toString(),
        sourceRevisionNo: source.revisionNo,
        reason: input.reason?.trim() || null
      }
    });
    return { pageId: page.id.toString(), revisionId: revision.id.toString(), revisionNo: revision.revisionNo };
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
    return toPageSummary(updated);
  }

  private async insertRecentChange(input: {
    readonly pageId: bigint;
    readonly revisionId: bigint | null;
    readonly actorId: bigint | null;
    readonly changeType: string;
    readonly title: string;
    readonly namespaceCode: string;
    readonly summary?: string | null;
  }): Promise<void> {
    await this.prisma.wikiRecentChange.create({
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

  private parseBigIntId(value: string, label: string): bigint {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException(`${label} must be an unsigned integer.`);
    }
    return BigInt(value);
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

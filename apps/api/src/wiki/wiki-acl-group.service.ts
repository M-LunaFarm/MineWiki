import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { cidrContains, CidrValidationError, normalizeIpOrCidr } from '@minewiki/security';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

const GROUP_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/u;
const GROUP_STATUSES = new Set(['active', 'archived']);
const GROUP_SCOPE_TYPES = new Set(['site', 'space']);
const MEMBER_TYPES = new Set(['user', 'ip', 'cidr']);

export interface WikiAclGroupSummary {
  readonly id: string;
  readonly key: string;
  readonly scopeType: 'site' | 'space';
  readonly spaceId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly selfRemovable: boolean;
  readonly activeMemberCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WikiAclGroupMemberSummary {
  readonly id: string;
  readonly groupId: string;
  readonly memberType: 'user' | 'ip' | 'cidr';
  readonly userId: string | null;
  readonly userName: string | null;
  readonly cidr: string | null;
  readonly reason: string | null;
  readonly expiresAt: string | null;
  readonly addedBy: string | null;
  readonly addedAt: string;
  readonly removedAt: string | null;
}

@Injectable()
export class WikiAclGroupService {
  constructor(private readonly prisma: PrismaService) {}

  async listGroups(input: {
    readonly cursor?: string;
    readonly limit?: string | number;
    readonly status?: string;
    readonly scopeType?: string;
    readonly spaceId?: string;
  } = {}): Promise<{ readonly items: WikiAclGroupSummary[]; readonly nextCursor: string | null }> {
    const limit = parseLimit(input.limit);
    const cursor = parseOptionalId(input.cursor, 'cursor');
    const status = input.status?.trim() || undefined;
    if (status && !GROUP_STATUSES.has(status)) throw new BadRequestException('Invalid ACL group status.');
    const scopeType = input.scopeType?.trim() || undefined;
    if (scopeType && !GROUP_SCOPE_TYPES.has(scopeType)) throw new BadRequestException('Invalid ACL group scope.');
    const spaceId = parseOptionalId(input.spaceId, 'spaceId');
    if (scopeType === 'site' && spaceId) throw new BadRequestException('Site ACL groups cannot have a space.');
    if (scopeType === 'space' && !spaceId) throw new BadRequestException('Space ACL groups require a space.');
    const rows = await this.prisma.aclGroup.findMany({
      where: {
        status,
        scopeType,
        ...(spaceId ? { spaceId } : {}),
        ...(cursor ? { id: { lt: cursor } } : {})
      },
      orderBy: [{ id: 'desc' }],
      take: limit + 1
    });
    const page = rows.slice(0, limit);
    const counts = page.length > 0
      ? await this.prisma.aclGroupMember.groupBy({
          by: ['groupId'],
          where: {
            groupId: { in: page.map((group) => group.id) },
            removedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
          },
          _count: { _all: true }
        })
      : [];
    const countByGroup = new Map(counts.map((entry) => [entry.groupId, entry._count._all]));
    return {
      items: page.map((group) => toGroupSummary(group, countByGroup.get(group.id) ?? 0)),
      nextCursor: rows.length > limit ? page.at(-1)?.id.toString() ?? null : null
    };
  }

  async createGroup(input: {
    readonly key?: string;
    readonly title?: string;
    readonly description?: string | null;
    readonly selfRemovable?: boolean;
    readonly scopeType?: string;
    readonly spaceId?: string | null;
    readonly actorProfileId: bigint;
  }): Promise<WikiAclGroupSummary> {
    const key = normalizeGroupKey(input.key);
    const title = normalizeTitle(input.title);
    const description = normalizeDescription(input.description);
    const scopeType = normalizeScopeType(input.scopeType);
    if (scopeType === 'site' && input.spaceId?.trim()) {
      throw new BadRequestException('Site ACL groups cannot have a space.');
    }
    const spaceId = scopeType === 'space' ? parseId(input.spaceId ?? '', 'spaceId') : null;
    const now = new Date();
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.aclGroup.findUnique({ where: { groupKey: key }, select: { id: true } });
        if (existing) throw new ConflictException('같은 ACL 그룹 키가 이미 존재합니다.');
        if (spaceId) {
          const space = await tx.wikiSpace.findUnique({ where: { id: spaceId }, select: { status: true } });
          if (!space || space.status !== 'active') throw new NotFoundException('Active wiki space not found.');
        }
        const group = await tx.aclGroup.create({
          data: {
            groupKey: key,
            scopeType,
            spaceId,
            title,
            description,
            status: 'active',
            selfRemovable: Boolean(input.selfRemovable),
            createdAt: now,
            updatedAt: now
          }
        });
        await appendChangeLog(tx, {
          targetType: 'acl_group', targetId: group.id, actionType: 'group_create',
          oldValue: null, newValue: groupAuditValue(group), reason: description, actorProfileId: input.actorProfileId, now
        });
        return group;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return toGroupSummary(created, 0);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (isUniqueConstraint(error)) throw new ConflictException('같은 ACL 그룹 키가 이미 존재합니다.');
      throw error;
    }
  }

  async updateGroup(input: {
    readonly groupId: string;
    readonly title?: string;
    readonly description?: string | null;
    readonly status?: string;
    readonly selfRemovable?: boolean;
    readonly reason?: string | null;
    readonly actorProfileId: bigint;
  }): Promise<WikiAclGroupSummary> {
    const groupId = parseId(input.groupId, 'groupId');
    const data: { title?: string; description?: string | null; status?: string; selfRemovable?: boolean; updatedAt: Date } = { updatedAt: new Date() };
    if (input.title !== undefined) data.title = normalizeTitle(input.title);
    if (input.description !== undefined) data.description = normalizeDescription(input.description);
    if (input.status !== undefined) {
      const status = input.status.trim();
      if (!GROUP_STATUSES.has(status)) throw new BadRequestException('Invalid ACL group status.');
      data.status = status;
    }
    if (input.selfRemovable !== undefined) data.selfRemovable = input.selfRemovable;
    if (Object.keys(data).length === 1) throw new BadRequestException('변경할 ACL 그룹 값을 입력하세요.');
    const reason = normalizeReason(input.reason, false);
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await tx.aclGroup.findUnique({ where: { id: groupId } });
      if (!current) throw new NotFoundException('ACL group not found.');
      const group = await tx.aclGroup.update({ where: { id: groupId }, data });
      await appendChangeLog(tx, {
        targetType: 'acl_group', targetId: group.id, actionType: 'group_update',
        oldValue: groupAuditValue(current), newValue: groupAuditValue(group), reason, actorProfileId: input.actorProfileId, now: data.updatedAt
      });
      return group;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    const activeMemberCount = await this.activeMemberCount(updated.id);
    return toGroupSummary(updated, activeMemberCount);
  }

  async deleteGroup(input: {
    readonly groupId: string;
    readonly reason?: string | null;
    readonly actorProfileId: bigint;
  }): Promise<{ readonly deleted: true; readonly groupId: string }> {
    const groupId = parseId(input.groupId, 'groupId');
    const reason = normalizeReason(input.reason, true);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.aclGroup.findUnique({ where: { id: groupId } });
      if (!current) throw new NotFoundException('ACL group not found.');
      if (current.status === 'archived') throw new ConflictException('ACL group is already archived.');
      const group = await tx.aclGroup.update({
        where: { id: groupId },
        data: { status: 'archived', selfRemovable: false, updatedAt: now }
      });
      await tx.aclGroupMember.updateMany({
        where: { groupId, removedAt: null },
        data: { removedAt: now }
      });
      await appendChangeLog(tx, {
        targetType: 'acl_group', targetId: group.id, actionType: 'group_delete',
        oldValue: groupAuditValue(current), newValue: groupAuditValue(group), reason, actorProfileId: input.actorProfileId, now
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { deleted: true, groupId: groupId.toString() };
  }

  async listMembers(input: {
    readonly groupId: string;
    readonly cursor?: string;
    readonly limit?: string | number;
    readonly includeRemoved?: boolean;
  }): Promise<{ readonly items: WikiAclGroupMemberSummary[]; readonly nextCursor: string | null }> {
    const groupId = parseId(input.groupId, 'groupId');
    const limit = parseLimit(input.limit);
    const cursor = parseOptionalId(input.cursor, 'cursor');
    await this.requireGroup(groupId, false);
    const rows = await this.prisma.aclGroupMember.findMany({
      where: {
        groupId,
        ...(!input.includeRemoved ? { removedAt: null } : {}),
        ...(cursor ? { id: { lt: cursor } } : {})
      },
      orderBy: [{ id: 'desc' }],
      take: limit + 1
    });
    const page = rows.slice(0, limit);
    const userIds = [...new Set(page.flatMap((member) => member.userId ? [member.userId] : []))];
    const users = userIds.length > 0
      ? await this.prisma.wikiProfile.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true, username: true } })
      : [];
    const names = new Map(users.map((user) => [user.id, `${user.displayName} (${user.username})`]));
    return {
      items: page.map((member) => toMemberSummary(member, member.userId ? names.get(member.userId) ?? null : null)),
      nextCursor: rows.length > limit ? page.at(-1)?.id.toString() ?? null : null
    };
  }

  async addMember(input: {
    readonly groupId: string;
    readonly memberType?: string;
    readonly userId?: string | null;
    readonly address?: string | null;
    readonly expiresAt?: string | null;
    readonly reason?: string | null;
    readonly actorProfileId: bigint;
  }): Promise<WikiAclGroupMemberSummary> {
    const groupId = parseId(input.groupId, 'groupId');
    const memberType = input.memberType?.trim() ?? '';
    if (!MEMBER_TYPES.has(memberType)) throw new BadRequestException('Invalid ACL group member type.');
    const reason = normalizeReason(input.reason, true);
    const expiresAt = parseExpiry(input.expiresAt);
    const now = new Date();
    const userId = memberType === 'user' ? parseId(input.userId ?? '', 'userId') : null;
    const network = memberType === 'user' ? null : normalizeNetwork(input.address ?? '', memberType === 'cidr');

    const created = await this.prisma.$transaction(async (tx) => {
      const group = await tx.aclGroup.findUnique({ where: { id: groupId } });
      if (!group || group.status !== 'active') throw new NotFoundException('Active ACL group not found.');
      if (userId) {
        const user = await tx.wikiProfile.findUnique({ where: { id: userId }, select: { id: true } });
        if (!user) throw new NotFoundException('Wiki profile not found.');
      }
      const duplicate = await tx.aclGroupMember.findFirst({
        where: {
          groupId,
          removedAt: null,
          ...(userId ? { memberType: 'user', userId } : { memberType, cidr: network!.cidr })
        },
        select: { id: true }
      });
      if (duplicate) throw new ConflictException('같은 활성 ACL 그룹 구성원이 이미 존재합니다.');
      const member = await tx.aclGroupMember.create({
        data: {
          groupId,
          memberType,
          userId,
          ip: network ? Buffer.from(network.networkBytes) : null,
          ipVersion: network?.family ?? null,
          cidr: network?.cidr ?? null,
          reason,
          expiresAt,
          addedBy: input.actorProfileId,
          addedAt: now,
          removedAt: null
        }
      });
      await tx.aclGroup.update({ where: { id: groupId }, data: { updatedAt: now } });
      await appendChangeLog(tx, {
        targetType: 'acl_member', targetId: member.id, actionType: 'member_add',
        oldValue: null, newValue: memberAuditValue(member), reason, actorProfileId: input.actorProfileId, now
      });
      return member;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    const userName = created.userId ? await this.userName(created.userId) : null;
    return toMemberSummary(created, userName);
  }

  async updateMemberExpiry(input: {
    readonly groupId: string;
    readonly memberId: string;
    readonly expiresAt?: string | null;
    readonly reason?: string | null;
    readonly actorProfileId: bigint;
  }): Promise<WikiAclGroupMemberSummary> {
    const groupId = parseId(input.groupId, 'groupId');
    const memberId = parseId(input.memberId, 'memberId');
    const expiresAt = parseExpiry(input.expiresAt);
    const reason = normalizeReason(input.reason, true);
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await tx.aclGroupMember.findFirst({ where: { id: memberId, groupId, removedAt: null } });
      if (!current) throw new NotFoundException('Active ACL group member not found.');
      const member = await tx.aclGroupMember.update({ where: { id: memberId }, data: { expiresAt } });
      await tx.aclGroup.update({ where: { id: groupId }, data: { updatedAt: now } });
      await appendChangeLog(tx, {
        targetType: 'acl_member', targetId: member.id, actionType: 'member_expiry',
        oldValue: memberAuditValue(current), newValue: memberAuditValue(member), reason, actorProfileId: input.actorProfileId, now
      });
      return member;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return toMemberSummary(updated, updated.userId ? await this.userName(updated.userId) : null);
  }

  async removeMember(input: {
    readonly groupId: string;
    readonly memberId: string;
    readonly reason?: string | null;
    readonly actorProfileId: bigint;
  }): Promise<{ readonly removed: true; readonly memberId: string }> {
    const groupId = parseId(input.groupId, 'groupId');
    const memberId = parseId(input.memberId, 'memberId');
    const reason = normalizeReason(input.reason, true);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.aclGroupMember.findFirst({ where: { id: memberId, groupId, removedAt: null } });
      if (!current) throw new NotFoundException('Active ACL group member not found.');
      const changed = await tx.aclGroupMember.updateMany({ where: { id: memberId, groupId, removedAt: null }, data: { removedAt: now } });
      if (changed.count !== 1) throw new ConflictException('ACL group member changed concurrently.');
      await tx.aclGroup.update({ where: { id: groupId }, data: { updatedAt: now } });
      await appendChangeLog(tx, {
        targetType: 'acl_member', targetId: current.id, actionType: 'member_remove',
        oldValue: memberAuditValue(current), newValue: memberAuditValue({ ...current, removedAt: now }),
        reason, actorProfileId: input.actorProfileId, now
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { removed: true, memberId: memberId.toString() };
  }

  async selfRemove(input: {
    readonly groupId: string;
    readonly profileId: bigint;
    readonly requestIp?: string | null;
  }): Promise<{ readonly removed: true; readonly memberIds: string[] }> {
    const groupId = parseId(input.groupId, 'groupId');
    const requestIp = input.requestIp ? normalizeRequestIp(input.requestIp) : null;
    const now = new Date();
    const removedIds = await this.prisma.$transaction(async (tx) => {
      const group = await tx.aclGroup.findUnique({ where: { id: groupId } });
      if (!group || group.status !== 'active') throw new NotFoundException('Active ACL group not found.');
      if (!group.selfRemovable) throw new ForbiddenException('이 ACL 그룹은 직접 탈퇴할 수 없습니다.');
      const candidates = await tx.aclGroupMember.findMany({
        where: {
          groupId,
          removedAt: null,
          OR: [
            { memberType: 'user', userId: input.profileId },
            ...(requestIp ? [{ memberType: { in: ['ip', 'cidr'] }, ipVersion: requestIp.family }] : [])
          ]
        }
      });
      const matched = candidates.filter((member) =>
        member.memberType === 'user' || Boolean(requestIp && member.cidr && cidrContains(member.cidr, requestIp.address))
      );
      if (matched.length === 0) throw new NotFoundException('직접 제거할 활성 ACL 그룹 구성원이 없습니다.');
      for (const member of matched) {
        const changed = await tx.aclGroupMember.updateMany({ where: { id: member.id, removedAt: null }, data: { removedAt: now } });
        if (changed.count !== 1) throw new ConflictException('ACL group member changed concurrently.');
        await appendChangeLog(tx, {
          targetType: 'acl_member', targetId: member.id, actionType: 'self_remove',
          oldValue: memberAuditValue(member), newValue: memberAuditValue({ ...member, removedAt: now }),
          reason: '구성원 직접 제거', actorProfileId: input.profileId, now
        });
      }
      await tx.aclGroup.update({ where: { id: groupId }, data: { updatedAt: now } });
      return matched.map((member) => member.id.toString());
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { removed: true, memberIds: removedIds };
  }

  private async activeMemberCount(groupId: bigint): Promise<number> {
    return this.prisma.aclGroupMember.count({
      where: { groupId, removedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }
    });
  }

  private async requireGroup(groupId: bigint, activeOnly: boolean) {
    const group = await this.prisma.aclGroup.findUnique({ where: { id: groupId } });
    if (!group || (activeOnly && group.status !== 'active')) throw new NotFoundException('ACL group not found.');
    return group;
  }

  private async userName(userId: bigint): Promise<string | null> {
    const user = await this.prisma.wikiProfile.findUnique({ where: { id: userId }, select: { displayName: true, username: true } });
    return user ? `${user.displayName} (${user.username})` : null;
  }
}

function parseLimit(value?: string | number): number {
  const parsed = Number(value ?? 50);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new BadRequestException('limit must be between 1 and 100.');
  return parsed;
}

function parseId(value: string, field: string): bigint {
  if (!/^\d+$/u.test(value)) throw new BadRequestException(`${field} must be a positive integer.`);
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new BadRequestException(`${field} must be a positive integer.`);
  return parsed;
}

function parseOptionalId(value: string | undefined, field: string): bigint | null {
  return value?.trim() ? parseId(value.trim(), field) : null;
}

function normalizeGroupKey(value?: string): string {
  const key = value?.trim().toLowerCase() ?? '';
  if (!GROUP_KEY_PATTERN.test(key)) throw new BadRequestException('ACL 그룹 키는 영문 소문자, 숫자, 밑줄, 하이픈 2~64자로 입력하세요.');
  return key;
}

function normalizeScopeType(value?: string): 'site' | 'space' {
  const scopeType = value?.trim() || 'site';
  if (!GROUP_SCOPE_TYPES.has(scopeType)) throw new BadRequestException('Invalid ACL group scope.');
  return scopeType as 'site' | 'space';
}

function normalizeTitle(value?: string): string {
  const title = value?.trim() ?? '';
  if (title.length < 2 || title.length > 255) throw new BadRequestException('ACL 그룹 이름은 2자 이상 255자 이하로 입력하세요.');
  return title;
}

function normalizeDescription(value?: string | null): string | null {
  const description = value?.trim() ?? '';
  if (description.length > 5000) throw new BadRequestException('ACL 그룹 설명은 5000자 이하로 입력하세요.');
  return description || null;
}

function normalizeReason(value: string | null | undefined, required: boolean): string | null {
  const reason = value?.trim() ?? '';
  if ((required && reason.length < 3) || reason.length > 1000) {
    throw new BadRequestException('운영 사유는 3자 이상 1000자 이하로 입력하세요.');
  }
  return reason || null;
}

function parseExpiry(value?: string | null): Date | null {
  if (!value?.trim()) return null;
  const expiresAt = new Date(value);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new BadRequestException('expiresAt must be a future date.');
  }
  return expiresAt;
}

function normalizeNetwork(value: string, requireNetwork: boolean) {
  try {
    const normalized = normalizeIpOrCidr(value, requireNetwork);
    const maximumPrefix = normalized.family === 4 ? 32 : 128;
    if (!requireNetwork && normalized.prefixLength !== maximumPrefix) {
      throw new BadRequestException('단일 IP 구성원에는 CIDR 범위를 사용할 수 없습니다.');
    }
    return normalized;
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    if (error instanceof CidrValidationError) throw new BadRequestException(error.message);
    throw error;
  }
}

function normalizeRequestIp(value: string) {
  try {
    const normalized = normalizeIpOrCidr(value);
    const maximumPrefix = normalized.family === 4 ? 32 : 128;
    if (normalized.prefixLength !== maximumPrefix) throw new Error('request IP must be an address');
    return normalized;
  } catch {
    throw new BadRequestException('중앙 요청 IP를 확인할 수 없습니다.');
  }
}

function toGroupSummary(group: {
  id: bigint; groupKey: string; title: string; description: string | null; status: string;
  scopeType: string; spaceId: bigint | null; selfRemovable: boolean; createdAt: Date; updatedAt: Date;
}, activeMemberCount: number): WikiAclGroupSummary {
  return {
    id: group.id.toString(), key: group.groupKey, title: group.title, description: group.description,
    scopeType: group.scopeType as WikiAclGroupSummary['scopeType'], spaceId: group.spaceId?.toString() ?? null,
    status: group.status, selfRemovable: group.selfRemovable, activeMemberCount,
    createdAt: group.createdAt.toISOString(), updatedAt: group.updatedAt.toISOString()
  };
}

function toMemberSummary(member: {
  id: bigint; groupId: bigint; memberType: string; userId: bigint | null; cidr: string | null;
  reason: string | null; expiresAt: Date | null; addedBy: bigint | null; addedAt: Date; removedAt: Date | null;
}, userName: string | null): WikiAclGroupMemberSummary {
  return {
    id: member.id.toString(), groupId: member.groupId.toString(),
    memberType: member.memberType as WikiAclGroupMemberSummary['memberType'],
    userId: member.userId?.toString() ?? null, userName, cidr: member.cidr, reason: member.reason,
    expiresAt: member.expiresAt?.toISOString() ?? null, addedBy: member.addedBy?.toString() ?? null,
    addedAt: member.addedAt.toISOString(), removedAt: member.removedAt?.toISOString() ?? null
  };
}

function groupAuditValue(group: {
  id: bigint; groupKey: string; scopeType: string; spaceId: bigint | null; title: string;
  description: string | null; status: string; selfRemovable: boolean;
}) {
  return {
    id: group.id.toString(), key: group.groupKey, scopeType: group.scopeType,
    spaceId: group.spaceId?.toString() ?? null, title: group.title, description: group.description,
    status: group.status, selfRemovable: group.selfRemovable
  };
}

function memberAuditValue(member: {
  id: bigint; groupId: bigint; memberType: string; userId: bigint | null; cidr: string | null;
  reason: string | null; expiresAt: Date | null; addedBy: bigint | null; addedAt: Date; removedAt: Date | null;
}) {
  return {
    id: member.id.toString(), groupId: member.groupId.toString(), memberType: member.memberType,
    userId: member.userId?.toString() ?? null, cidr: member.cidr, reason: member.reason,
    expiresAt: member.expiresAt?.toISOString() ?? null, addedBy: member.addedBy?.toString() ?? null,
    addedAt: member.addedAt.toISOString(), removedAt: member.removedAt?.toISOString() ?? null
  };
}

async function appendChangeLog(tx: Prisma.TransactionClient, input: {
  readonly targetType: string;
  readonly targetId: bigint;
  readonly actionType: string;
  readonly oldValue: Prisma.InputJsonValue | null;
  readonly newValue: Prisma.InputJsonValue | null;
  readonly reason: string | null;
  readonly actorProfileId: bigint;
  readonly now: Date;
}) {
  const oldValue = input.oldValue === null ? Prisma.JsonNull : input.oldValue;
  const newValue = input.newValue === null ? Prisma.JsonNull : input.newValue;
  await tx.aclChangeLog.create({
    data: {
      targetType: input.targetType,
      targetId: input.targetId,
      actionType: input.actionType,
      oldRuleJson: oldValue,
      newRuleJson: newValue,
      reason: input.reason,
      changedBy: input.actorProfileId,
      createdAt: input.now
    }
  });
  await tx.auditEvent.create({
    data: {
      category: 'wiki',
      action: `wiki.acl.${input.actionType}`,
      severity: input.actionType.includes('delete') || input.actionType.includes('remove') ? 'warning' : 'info',
      actorProfileId: input.actorProfileId,
      subjectType: input.targetType,
      subjectId: input.targetId.toString(),
      metadata: {
        reason: input.reason,
        oldValue: input.oldValue,
        newValue: input.newValue
      },
      createdAt: input.now
    }
  });
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

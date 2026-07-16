import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AccountModerationAction,
  AccountModerationHistoryEntry,
  AccountModerationResult,
  AdminAccountDetail,
  AdminAccountListQuery,
  AdminAccountListResponse,
  AdminAccountSummary,
} from '@minewiki/schemas';
import { PrismaService } from '../common/prisma.service';
import {
  type CanonicalAccountGroup,
  withCanonicalAccountGroups,
} from './account-lifecycle-fence';

const MODERATION_ACTIONS = ['account.suspended', 'account.restored'] as const;
type ModerationOperation = 'suspend' | 'restore';
type MutableLifecycleStatus = 'active' | 'suspended';

interface AccountSummaryRow {
  readonly id: string;
  readonly canonicalAccountId: string | null;
  readonly provider: 'email' | 'discord' | 'naver';
  readonly email: string | null;
  readonly displayName: string | null;
  readonly lifecycleStatus: string;
  readonly createdAt: Date;
  readonly lastLoginAt: Date | null;
  readonly suspendedAt: Date | null;
  readonly suspendedBy: string | null;
  readonly suspensionReason: string | null;
}

@Injectable()
export class AccountModerationService {
  constructor(private readonly prisma: PrismaService) {}

  async list(input: AdminAccountListQuery): Promise<AdminAccountListResponse> {
    const candidates = await this.prisma.account.findMany({
      where: {
        lifecycleStatus: input.status,
        ...(input.q
          ? {
              OR: [
                { id: input.q },
                { canonicalAccountId: input.q },
                { email: { contains: input.q } },
                { displayName: { contains: input.q } },
              ],
            }
          : {}),
      },
      select: accountSummarySelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(input.limit * 10, 1000),
    });
    if (candidates.length === 0) return { accounts: [] };

    const canonicalIds = uniqueSorted(
      candidates.map((account) => account.canonicalAccountId ?? account.id),
    );
    const members = await this.prisma.account.findMany({
      where: {
        OR: [
          { id: { in: canonicalIds } },
          { canonicalAccountId: { in: canonicalIds } },
        ],
      },
      select: accountSummarySelect,
    });
    const roles = await this.prisma.accountRole.findMany({
      where: { accountId: { in: members.map((account) => account.id) } },
      select: { accountId: true, role: { select: { code: true } } },
    });
    const rolesByAccount = roleMap(roles);
    const candidateOrder = new Map(canonicalIds.map((id, index) => [id, index]));
    const grouped = new Map<string, AccountSummaryRow[]>();
    for (const account of members) {
      const canonicalId = account.canonicalAccountId ?? account.id;
      if (!candidateOrder.has(canonicalId)) continue;
      const rows = grouped.get(canonicalId) ?? [];
      rows.push(account);
      grouped.set(canonicalId, rows);
    }

    const accounts = [...grouped.entries()]
      .sort(([left], [right]) => (candidateOrder.get(left) ?? 0) - (candidateOrder.get(right) ?? 0))
      .map(([canonicalAccountId, rows]) => toSummary(canonicalAccountId, rows, rolesByAccount))
      .slice(0, input.limit);
    return { accounts };
  }

  async getDetail(accountId: string): Promise<AdminAccountDetail> {
    return withCanonicalAccountGroups(this.prisma, [accountId], async (tx, groups) => {
      const group = requiredGroup(groups, accountId);
      return this.loadDetail(tx, group);
    });
  }

  async suspend(
    actorAccountId: string,
    targetAccountId: string,
    input: AccountModerationAction,
  ): Promise<AccountModerationResult> {
    return this.changeLifecycle('suspend', actorAccountId, targetAccountId, input);
  }

  async restore(
    actorAccountId: string,
    targetAccountId: string,
    input: AccountModerationAction,
  ): Promise<AccountModerationResult> {
    return this.changeLifecycle('restore', actorAccountId, targetAccountId, input);
  }

  private async changeLifecycle(
    operation: ModerationOperation,
    actorAccountId: string,
    targetAccountId: string,
    input: AccountModerationAction,
  ): Promise<AccountModerationResult> {
    const expectedStatus: MutableLifecycleStatus = operation === 'suspend' ? 'active' : 'suspended';
    const newStatus: MutableLifecycleStatus = operation === 'suspend' ? 'suspended' : 'active';
    if (input.expectedStatus !== expectedStatus) {
      throw new BadRequestException({
        code: 'ACCOUNT_EXPECTED_STATUS_INVALID',
        message: `이 작업의 expectedStatus는 ${expectedStatus}여야 합니다.`,
        expectedStatus,
      });
    }

    return withCanonicalAccountGroups(
      this.prisma,
      [actorAccountId, targetAccountId],
      async (tx, groups) => {
        const actorGroup = requiredGroup(groups, actorAccountId);
        const targetGroup = requiredGroup(groups, targetAccountId);
        if (groupsOverlap(actorGroup, targetGroup)) {
          throw new ForbiddenException('자기 자신의 연결 계정 그룹은 정지하거나 복구할 수 없습니다.');
        }
        if (input.confirmation !== targetGroup.canonicalAccountId) {
          throw new BadRequestException({
            code: 'ACCOUNT_CONFIRMATION_MISMATCH',
            message: '확인 값이 대표 계정 ID와 일치하지 않습니다.',
            confirmationValue: targetGroup.canonicalAccountId,
          });
        }

        const accountRows = await tx.account.findMany({
          where: { id: { in: uniqueSorted([...actorGroup.accountIds, ...targetGroup.accountIds]) } },
          select: { id: true, lifecycleStatus: true },
        });
        assertUniformStatus(accountRows, actorGroup, 'active', '관리자 계정이 활성 상태가 아닙니다.');
        assertUniformStatus(
          accountRows,
          targetGroup,
          expectedStatus,
          operation === 'suspend'
            ? '활성 상태인 계정만 정지할 수 있습니다.'
            : '정지 상태인 계정만 복구할 수 있습니다.',
        );

        await lockHierarchyRoles(tx);
        const assignments = await tx.accountRole.findMany({
          where: { accountId: { in: uniqueSorted([...actorGroup.accountIds, ...targetGroup.accountIds]) } },
          select: { accountId: true, role: { select: { code: true } } },
        });
        const rolesByAccount = roleMap(assignments);
        const actorRoles = rolesForGroup(actorGroup, rolesByAccount);
        const targetRoles = rolesForGroup(targetGroup, rolesByAccount);
        assertHierarchy(actorRoles, targetRoles);
        if (operation === 'suspend' && targetRoles.includes('owner')) {
          await assertAnotherActiveOwner(tx, targetGroup.canonicalAccountId);
        }

        const now = new Date();
        const changed = await tx.account.updateMany({
          where: {
            id: { in: [...targetGroup.accountIds] },
            lifecycleStatus: expectedStatus,
          },
          data: operation === 'suspend'
            ? {
                lifecycleStatus: newStatus,
                suspendedAt: now,
                suspendedBy: actorGroup.canonicalAccountId,
                suspensionReason: input.reason,
              }
            : {
                lifecycleStatus: newStatus,
                suspendedAt: null,
                suspendedBy: null,
                suspensionReason: null,
              },
        });
        if (changed.count !== targetGroup.accountIds.length) {
          throw new ConflictException('계정 상태가 동시에 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
        }

        const [sessions, wikiApiTokens] = await Promise.all([
          tx.session.deleteMany({ where: { accountId: { in: [...targetGroup.accountIds] } } }),
          tx.wikiApiToken.updateMany({
            where: { accountId: { in: [...targetGroup.accountIds] }, status: 'active' },
            data: { status: 'revoked', revokedAt: now },
          }),
        ]);
        const action = operation === 'suspend' ? 'account.suspended' : 'account.restored';
        await tx.auditEvent.create({
          data: {
            category: 'account',
            action,
            severity: operation === 'suspend' ? 'warning' : 'info',
            actorAccountId: actorGroup.canonicalAccountId,
            subjectType: 'canonical_account',
            subjectId: targetGroup.canonicalAccountId,
            metadata: {
              reason: input.reason,
              previousStatus: expectedStatus,
              newStatus,
              expectedStatus: input.expectedStatus,
              accountIds: [...targetGroup.accountIds],
              revokedSessionCount: sessions.count,
              revokedWikiApiTokenCount: wikiApiTokens.count,
            },
          },
        });

        return {
          account: await this.loadDetail(tx, targetGroup),
          revokedSessionCount: sessions.count,
          revokedWikiApiTokenCount: wikiApiTokens.count,
        };
      },
    );
  }

  private async loadDetail(
    store: Prisma.TransactionClient,
    group: CanonicalAccountGroup,
  ): Promise<AdminAccountDetail> {
    const [accounts, roles, history] = await Promise.all([
      store.account.findMany({
        where: { id: { in: [...group.accountIds] } },
        select: accountSummarySelect,
      }),
      store.accountRole.findMany({
        where: { accountId: { in: [...group.accountIds] } },
        select: { accountId: true, role: { select: { code: true } } },
      }),
      store.auditEvent.findMany({
        where: {
          subjectType: 'canonical_account',
          subjectId: group.canonicalAccountId,
          action: { in: [...MODERATION_ACTIONS] },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
    ]);
    if (accounts.length !== group.accountIds.length) {
      throw new NotFoundException('계정을 찾을 수 없습니다.');
    }
    const rolesByAccount = roleMap(roles);
    const summary = toSummary(group.canonicalAccountId, accounts, rolesByAccount);
    return {
      ...summary,
      accounts: [...accounts]
        .sort((left, right) => accountOrder(left, right, group.canonicalAccountId))
        .map((account) => ({
          id: account.id,
          provider: account.provider,
          email: account.email,
          displayName: account.displayName,
          lifecycleStatus: parseLifecycleStatus(account.lifecycleStatus),
          createdAt: account.createdAt.toISOString(),
          lastLoginAt: account.lastLoginAt?.toISOString() ?? null,
        })),
      moderationHistory: history.map(toHistoryEntry),
    };
  }
}

const accountSummarySelect = {
  id: true,
  canonicalAccountId: true,
  provider: true,
  email: true,
  displayName: true,
  lifecycleStatus: true,
  createdAt: true,
  lastLoginAt: true,
  suspendedAt: true,
  suspendedBy: true,
  suspensionReason: true,
} as const;

function requiredGroup(
  groups: readonly CanonicalAccountGroup[],
  seedAccountId: string,
): CanonicalAccountGroup {
  const group = groups.find((candidate) => candidate.seedAccountId === seedAccountId);
  if (!group) throw new NotFoundException('계정을 찾을 수 없습니다.');
  return group;
}

function assertUniformStatus(
  rows: ReadonlyArray<{ readonly id: string; readonly lifecycleStatus: string }>,
  group: CanonicalAccountGroup,
  expectedStatus: MutableLifecycleStatus,
  message: string,
): void {
  const statuses = group.accountIds.map(
    (id) => rows.find((row) => row.id === id)?.lifecycleStatus ?? 'missing',
  );
  if (statuses.some((status) => status !== expectedStatus)) {
    throw new ConflictException({
      code: 'ACCOUNT_STATUS_MISMATCH',
      message,
      expectedStatus,
      actualStatuses: uniqueSorted(statuses),
    });
  }
}

async function lockHierarchyRoles(tx: Prisma.TransactionClient): Promise<void> {
  const roles = await tx.globalRole.findMany({
    where: { code: { in: ['owner', 'admin'] } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (roles.length === 0) throw new ForbiddenException('계정 관리 역할 구성이 없습니다.');
  await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM \`global_roles\` WHERE id IN (${Prisma.join(roles.map((role) => role.id))}) ORDER BY id FOR UPDATE`,
  );
}

function assertHierarchy(actorRoles: readonly string[], targetRoles: readonly string[]): void {
  if (actorRoles.includes('owner')) return;
  if (!actorRoles.includes('admin')) {
    throw new ForbiddenException('계정 정지 관리자 역할이 필요합니다.');
  }
  if (targetRoles.some((role) => role === 'owner' || role === 'admin')) {
    throw new ForbiddenException('관리자는 다른 관리자 또는 소유자 계정을 정지하거나 복구할 수 없습니다.');
  }
}

async function assertAnotherActiveOwner(
  tx: Prisma.TransactionClient,
  targetCanonicalAccountId: string,
): Promise<void> {
  const assignments = await tx.accountRole.findMany({
    where: { role: { code: 'owner' }, account: { lifecycleStatus: 'active' } },
    select: { account: { select: { id: true, canonicalAccountId: true } } },
  });
  const activeOwners = new Set(
    assignments.map(({ account }) => account.canonicalAccountId ?? account.id),
  );
  if (activeOwners.has(targetCanonicalAccountId) && activeOwners.size <= 1) {
    throw new ConflictException('마지막 활성 소유자 계정은 정지할 수 없습니다.');
  }
}

function groupsOverlap(left: CanonicalAccountGroup, right: CanonicalAccountGroup): boolean {
  const rightIds = new Set(right.accountIds);
  return left.accountIds.some((id) => rightIds.has(id));
}

function roleMap(
  rows: ReadonlyArray<{ readonly accountId: string; readonly role: { readonly code: string } }>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const roles = result.get(row.accountId) ?? [];
    roles.push(row.role.code);
    result.set(row.accountId, roles);
  }
  return result;
}

function rolesForGroup(
  group: CanonicalAccountGroup,
  rolesByAccount: ReadonlyMap<string, readonly string[]>,
): string[] {
  return uniqueSorted(group.accountIds.flatMap((id) => rolesByAccount.get(id) ?? []));
}

function toSummary(
  canonicalAccountId: string,
  rows: readonly AccountSummaryRow[],
  rolesByAccount: ReadonlyMap<string, readonly string[]>,
): AdminAccountSummary {
  if (rows.length === 0) throw new NotFoundException('계정을 찾을 수 없습니다.');
  const ordered = [...rows].sort((left, right) => accountOrder(left, right, canonicalAccountId));
  const canonical = ordered[0]!;
  const statuses = uniqueSorted(rows.map((account) => account.lifecycleStatus));
  const suspension = [...rows]
    .filter((account) => account.suspendedAt)
    .sort((left, right) => (right.suspendedAt?.getTime() ?? 0) - (left.suspendedAt?.getTime() ?? 0))[0];
  const createdAt = new Date(Math.min(...rows.map((account) => account.createdAt.getTime())));
  const lastLoginAt = rows.reduce<Date | null>((latest, account) => {
    if (!account.lastLoginAt) return latest;
    return !latest || account.lastLoginAt > latest ? account.lastLoginAt : latest;
  }, null);
  return {
    canonicalAccountId,
    confirmationValue: canonicalAccountId,
    accountIds: uniqueSorted(rows.map((account) => account.id)),
    linkedAccountCount: Math.max(rows.length - 1, 0),
    lifecycleStatus: statuses.length === 1 ? parseLifecycleStatus(statuses[0]!) : 'mixed',
    email: canonical.email ?? rows.find((account) => account.email)?.email ?? null,
    displayName: canonical.displayName ?? rows.find((account) => account.displayName)?.displayName ?? null,
    providers: [...new Set(rows.map((account) => account.provider))].sort(),
    roles: uniqueSorted(rows.flatMap((account) => rolesByAccount.get(account.id) ?? [])),
    createdAt: createdAt.toISOString(),
    lastLoginAt: lastLoginAt?.toISOString() ?? null,
    suspendedAt: suspension?.suspendedAt?.toISOString() ?? null,
    suspendedBy: suspension?.suspendedBy ?? null,
    suspensionReason: suspension?.suspensionReason ?? null,
  };
}

function toHistoryEntry(row: {
  readonly id: string;
  readonly action: string;
  readonly actorAccountId: string | null;
  readonly metadata: Prisma.JsonValue | null;
  readonly createdAt: Date;
}): AccountModerationHistoryEntry {
  const metadata = isJsonObject(row.metadata) ? row.metadata : {};
  return {
    id: row.id,
    action: row.action === 'account.restored' ? 'account.restored' : 'account.suspended',
    actorAccountId: row.actorAccountId,
    reason: jsonString(metadata.reason),
    previousStatus: jsonString(metadata.previousStatus),
    newStatus: jsonString(metadata.newStatus),
    createdAt: row.createdAt.toISOString(),
  };
}

function isJsonObject(value: Prisma.JsonValue | null): value is Prisma.JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonString(value: Prisma.JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function accountOrder(
  left: Pick<AccountSummaryRow, 'id'>,
  right: Pick<AccountSummaryRow, 'id'>,
  canonicalAccountId: string,
): number {
  if (left.id === canonicalAccountId) return -1;
  if (right.id === canonicalAccountId) return 1;
  return left.id.localeCompare(right.id);
}

function parseLifecycleStatus(value: string): 'active' | 'suspended' | 'deletion_pending' | 'anonymized' {
  if (value === 'active' || value === 'suspended' || value === 'deletion_pending' || value === 'anonymized') {
    return value;
  }
  throw new ConflictException(`지원하지 않는 계정 수명 주기 상태입니다: ${value}`);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

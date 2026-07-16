import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { withActiveCanonicalAccountGroup } from '../auth/account-lifecycle-fence';
import { PrismaService } from '../common/prisma.service';
import { isProtectedRoleCode } from './role-policy';

export const BUILT_IN_ROLE_CODES = [
  'owner',
  'admin',
  'moderator',
  'wiki_admin',
  'server_admin',
  'vote_moderator',
  'support_agent',
] as const;

export const BUILT_IN_PERMISSION_CODES = [
  'wiki.read.restricted',
  'wiki.edit.locked',
  'wiki.admin',
  'wiki.acl.manage',
  'wiki.user.block',
  'wiki.batch_rollback',
  'wiki.report.moderate',
  'server.admin',
  'review.moderate',
  'vote.admin',
  'guild.admin',
  'support.admin',
  'file.admin',
  'admin.account.delete',
  'admin.account.suspend',
  'admin.audit.read',
] as const;

export interface AccountAccess {
  readonly roles: string[];
  readonly permissions: string[];
}

export interface RoleSummary {
  readonly id: string;
  readonly code: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly permissions: string[];
}

export interface AccountRoleSummary {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly provider: string;
  readonly createdAt: string;
  readonly roles: string[];
}

@Injectable()
export class RoleService {
  constructor(private readonly prisma: PrismaService) {}

  async getAccountAccess(accountId: string): Promise<AccountAccess> {
    const canonicalId = await this.resolveCanonicalAccountId(accountId);
    const rows = await this.prisma.accountRole.findMany({
      where: { accountId: canonicalId },
      include: {
        role: {
          include: {
            rolePermissions: {
              include: { permission: true },
            },
          },
        },
      },
    });
    const roles = new Set<string>();
    const permissions = new Set<string>();
    for (const row of rows) {
      roles.add(row.role.code);
      for (const rolePermission of row.role.rolePermissions) {
        permissions.add(rolePermission.permission.code);
      }
    }
    return {
      roles: [...roles].sort(),
      permissions: [...permissions].sort(),
    };
  }

  async hasPermission(accountId: string, permission: string): Promise<boolean> {
    const access = await this.getAccountAccess(accountId);
    return access.permissions.includes(permission);
  }

  async listRoles(): Promise<RoleSummary[]> {
    const roles = await this.prisma.globalRole.findMany({
      include: {
        rolePermissions: {
          include: { permission: true },
        },
      },
      orderBy: { displayName: 'asc' },
    });
    return roles.map((role) => ({
      id: role.id,
      code: role.code,
      displayName: role.displayName,
      description: role.description,
      permissions: role.rolePermissions.map((entry) => entry.permission.code).sort(),
    }));
  }

  async searchAccounts(query?: string, limitInput?: string | number): Promise<AccountRoleSummary[]> {
    const search = query?.trim();
    const limit = Math.min(Math.max(Number(limitInput ?? 50) || 50, 1), 100);
    const accounts = await this.prisma.account.findMany({
      where: search
        ? {
            OR: [
              { id: search },
              { email: { contains: search } },
              { displayName: { contains: search } },
            ],
          }
        : undefined,
      include: { accountRoles: { include: { role: true } } },
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
    });
    return accounts.map((account) => ({
      id: account.id,
      email: account.email,
      displayName: account.displayName,
      provider: account.provider,
      createdAt: account.createdAt.toISOString(),
      roles: account.accountRoles.map((entry) => entry.role.code).sort(),
    }));
  }

  async assignRole(
    accountId: string,
    roleCode: string,
    options: { readonly actorAccountId?: string } = {},
  ): Promise<AccountAccess> {
    if (isProtectedRoleCode(roleCode)) {
      if (!options.actorAccountId) {
        throw new ForbiddenException('보호된 관리자 역할은 인증된 관리 작업으로만 부여할 수 있습니다.');
      }
      const canonicalId = await withActiveCanonicalAccountGroup(
        this.prisma,
        [accountId, options.actorAccountId],
        async (transaction) => {
          const [targetCanonicalId, actorCanonicalId] = await Promise.all([
            resolveCanonicalAccountId(transaction, accountId),
            resolveCanonicalAccountId(transaction, options.actorAccountId!),
          ]);
          if (targetCanonicalId === actorCanonicalId) {
            throw new ForbiddenException('자기 계정 그룹에는 보호된 관리자 역할을 부여할 수 없습니다.');
          }
          const role = await transaction.globalRole.findUnique({ where: { code: roleCode } });
          if (!role) throw new NotFoundException('Role was not found.');
          await lockRole(transaction, role.id);
          const [credential, passkeyCount] = await Promise.all([
            transaction.mfaTotpCredential.findUnique({
              where: { accountId: targetCanonicalId },
              select: { enabledAt: true },
            }),
            transaction.webAuthnCredential.count({ where: { accountId: targetCanonicalId } }),
          ]);
          if (!credential?.enabledAt && passkeyCount === 0) {
            throw new BadRequestException(
              '보호된 관리자 역할을 받으려면 대상 계정에 다중 인증이 활성화되어 있어야 합니다.',
            );
          }
          await transaction.accountRole.upsert({
            where: { accountId_roleId: { accountId: targetCanonicalId, roleId: role.id } },
            update: {},
            create: { accountId: targetCanonicalId, roleId: role.id },
          });
          return targetCanonicalId;
        },
      );
      return this.getAccountAccess(canonicalId);
    }
    const role = await this.prisma.globalRole.findUnique({ where: { code: roleCode } });
    if (!role) {
      throw new NotFoundException('Role was not found.');
    }
    const account = await this.prisma.account.findUnique({ where: { id: accountId }, select: { id: true } });
    if (!account) {
      throw new NotFoundException('Account was not found.');
    }
    await this.prisma.accountRole.upsert({
      where: { accountId_roleId: { accountId, roleId: role.id } },
      update: {},
      create: { accountId, roleId: role.id },
    });
    return this.getAccountAccess(accountId);
  }

  async removeRole(accountId: string, roleCode: string): Promise<AccountAccess> {
    const canonicalId = await withActiveCanonicalAccountGroup(
      this.prisma,
      [accountId],
      async (transaction, group) => {
        const role = await transaction.globalRole.findUnique({ where: { code: roleCode } });
        if (!role) {
          throw new NotFoundException('Role was not found.');
        }
        await lockRole(transaction, role.id);
        const targetCanonicalId = await resolveCanonicalAccountId(transaction, accountId);
        if (role.code === 'owner') {
          const assignments = await transaction.accountRole.findMany({
            where: { roleId: role.id },
            select: {
              accountId: true,
              account: { select: { id: true, canonicalAccountId: true } },
            },
          });
          const canonicalOwners = new Set(
            assignments.map(({ account }) => account.canonicalAccountId ?? account.id),
          );
          if (canonicalOwners.has(targetCanonicalId) && canonicalOwners.size <= 1) {
            throw new ConflictException('The last owner role cannot be removed.');
          }
        }
        await transaction.accountRole.deleteMany({
          where: { accountId: { in: [...group.accountIds] }, roleId: role.id },
        });
        return targetCanonicalId;
      },
    );
    return this.getAccountAccess(canonicalId);
  }

  private async resolveCanonicalAccountId(accountId: string): Promise<string> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, canonicalAccountId: true },
    });
    if (!account) throw new NotFoundException('Account was not found.');
    return account.canonicalAccountId ?? account.id;
  }
}

async function resolveCanonicalAccountId(
  transaction: Prisma.TransactionClient,
  accountId: string,
): Promise<string> {
  const account = await transaction.account.findUnique({
    where: { id: accountId },
    select: { id: true, canonicalAccountId: true },
  });
  if (!account) throw new NotFoundException('Account was not found.');
  return account.canonicalAccountId ?? account.id;
}

async function lockRole(transaction: Prisma.TransactionClient, roleId: string): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM \`global_roles\` WHERE id = ${roleId} FOR UPDATE`,
  );
  if (rows.length !== 1) throw new NotFoundException('Role was not found.');
}

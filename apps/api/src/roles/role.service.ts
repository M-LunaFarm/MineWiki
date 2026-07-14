import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

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
  'wiki.batch_rollback',
  'server.admin',
  'vote.admin',
  'guild.admin',
  'support.admin',
  'file.admin',
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
    const rows = await this.prisma.accountRole.findMany({
      where: { accountId },
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

  async assignRole(accountId: string, roleCode: string): Promise<AccountAccess> {
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
    await this.prisma.$transaction(
      async (transaction) => {
        const role = await transaction.globalRole.findUnique({ where: { code: roleCode } });
        if (!role) {
          throw new NotFoundException('Role was not found.');
        }
        const account = await transaction.account.findUnique({
          where: { id: accountId },
          select: { id: true },
        });
        if (!account) {
          throw new NotFoundException('Account was not found.');
        }
        if (role.code === 'owner') {
          const assignment = await transaction.accountRole.findUnique({
            where: { accountId_roleId: { accountId, roleId: role.id } },
            select: { id: true },
          });
          if (assignment) {
            const ownerCount = await transaction.accountRole.count({ where: { roleId: role.id } });
            if (ownerCount <= 1) {
              throw new ConflictException('The last owner role cannot be removed.');
            }
          }
        }
        await transaction.accountRole.deleteMany({ where: { accountId, roleId: role.id } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return this.getAccountAccess(accountId);
  }
}

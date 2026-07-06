import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

export const BUILT_IN_ROLE_CODES = [
  'owner',
  'admin',
  'moderator',
  'wiki_admin',
  'server_admin',
  'support_agent',
] as const;

export const BUILT_IN_PERMISSION_CODES = [
  'wiki.read.restricted',
  'wiki.edit.locked',
  'wiki.admin',
  'server.admin',
  'guild.admin',
  'support.admin',
  'file.admin',
] as const;

export interface AccountAccess {
  readonly roles: string[];
  readonly permissions: string[];
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
}

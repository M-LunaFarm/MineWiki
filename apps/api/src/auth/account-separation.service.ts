import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { authProviderSchema } from '@minewiki/schemas';
import { PrismaService } from '../common/prisma.service';
import { withActiveCanonicalAccountGroup } from './account-lifecycle-fence';

export type AuthProvider = z.infer<typeof authProviderSchema>;

export interface AccountRecord {
  readonly id: string;
  readonly provider: AuthProvider;
  readonly providerUserId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
  readonly emailVerified: boolean;
  readonly passwordHash: string | null;
  readonly lifecycleStatus: string;
}

export interface RegisterAccountInput {
  readonly provider: AuthProvider;
  readonly providerUserId: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly emailVerified?: boolean;
  readonly passwordHash?: string;
  readonly consents?: readonly {
    readonly consentType: string;
    readonly policyVersion: string;
    readonly ipAddress?: string | null;
    readonly userAgent?: string | null;
  }[];
}

@Injectable()
export class AccountSeparationService {
  constructor(private readonly prisma: PrismaService) {}

  async registerAccount(input: RegisterAccountInput): Promise<AccountRecord> {
    const existing = await this.prisma.account.findUnique({
      where: {
        provider_providerUserId: {
          provider: input.provider,
          providerUserId: input.providerUserId
        }
      }
    });
    if (existing) {
      throw new ConflictException('Account already exists for provider credentials.');
    }

    const emailNormalized = input.email ? input.email.toLowerCase() : null;
    const accountId = randomUUID();
    const record = await this.prisma.account.create({
      data: {
        id: accountId,
        canonicalAccountId: accountId,
        provider: input.provider,
        providerUserId: input.providerUserId,
        email: emailNormalized,
        displayName: input.displayName ?? null,
        emailVerified:
          input.emailVerified ?? (input.provider === 'email' ? false : Boolean(emailNormalized)),
        passwordHash: input.passwordHash ?? null,
        consents: input.consents?.length
          ? {
              create: input.consents.map((consent) => ({
                consentType: consent.consentType,
                policyVersion: consent.policyVersion,
                ipAddress: consent.ipAddress ?? null,
                userAgent: consent.userAgent?.slice(0, 512) ?? null
              }))
            }
          : undefined
      }
    });

    return this.toAccountRecord(record);
  }

  async listAccountsByEmail(email: string): Promise<AccountRecord[]> {
    const normalized = email.toLowerCase();
    const records = await this.prisma.account.findMany({
      where: { email: normalized }
    });
    return records.map((record) => this.toAccountRecord(record));
  }

  async findByProvider(
    provider: AuthProvider,
    providerUserId: string
  ): Promise<AccountRecord | undefined> {
    const record = await this.prisma.account.findUnique({
      where: {
        provider_providerUserId: {
          provider,
          providerUserId
        }
      }
    });
    return record ? this.toAccountRecord(record) : undefined;
  }

  async getAccount(accountId: string): Promise<AccountRecord | undefined> {
    const record = await this.prisma.account.findUnique({
      where: { id: accountId }
    });
    return record ? this.toAccountRecord(record) : undefined;
  }

  async getLinkedAccountIds(accountId: string): Promise<string[]> {
    const links = await this.prisma.accountLink.findMany({
      where: { primaryAccountId: accountId },
      select: { linkedAccountId: true }
    });
    return links.map((link) => link.linkedAccountId);
  }

  async listLinkedAccounts(accountId: string): Promise<LinkedAccountRecord[]> {
    const links = await this.prisma.accountLink.findMany({
      where: { primaryAccountId: accountId },
      include: { linkedAccount: true }
    });
    return links.map((link) => ({
      id: link.linkedAccount.id,
      provider: link.linkedAccount.provider,
      email: link.linkedAccount.email,
      displayName: link.linkedAccount.displayName
    }));
  }

  async createLinkRequest(
    primaryAccountId: string,
    targetAccountId: string
  ): Promise<AccountLinkRequest> {
    if (primaryAccountId === targetAccountId) {
      throw new BadRequestException('동일한 계정은 연결할 수 없습니다.');
    }

    const [primary, target] = await Promise.all([
      this.prisma.account.findUnique({ where: { id: primaryAccountId } }),
      this.prisma.account.findUnique({ where: { id: targetAccountId } })
    ]);
    if (!primary || !target) {
      throw new NotFoundException('계정 정보를 찾을 수 없습니다.');
    }
    if (primary.lifecycleStatus !== 'active' || target.lifecycleStatus !== 'active') {
      throw new ConflictException('종료가 진행 중인 계정은 연결할 수 없습니다.');
    }
    if (primary.provider === target.provider) {
      throw new BadRequestException('같은 공급자의 계정은 연결할 수 없습니다.');
    }

    const existingLink = await this.prisma.accountLink.findUnique({
      where: {
        primaryAccountId_linkedAccountId: {
          primaryAccountId,
          linkedAccountId: targetAccountId
        }
      }
    });
    if (existingLink) {
      throw new BadRequestException('이미 연결된 계정입니다.');
    }

    const request = await this.prisma.accountLinkRequest.create({
      data: {
        primaryAccountId,
        targetAccountId,
        verificationCode: this.generateCode(),
        status: 'pending'
      }
    });

    return {
      id: request.id,
      primaryAccountId: request.primaryAccountId,
      targetAccountId: request.targetAccountId,
      verificationCode: request.verificationCode,
      createdAt: request.createdAt.toISOString(),
      status: request.status
    };
  }

  async confirmLink(requestId: string, code: string): Promise<AccountLinkResult> {
    const request = await this.prisma.accountLinkRequest.findUnique({
      where: { id: requestId }
    });
    if (!request) {
      throw new NotFoundException('연결 요청을 찾을 수 없습니다.');
    }
    if (request.status !== 'pending') {
      throw new BadRequestException('이미 처리된 연결 요청입니다.');
    }
    if (request.verificationCode !== code) {
      throw new BadRequestException('검증 코드가 일치하지 않습니다.');
    }

    await withActiveCanonicalAccountGroup(
      this.prisma,
      [request.primaryAccountId, request.targetAccountId],
      async (tx, group) => {
        const fresh = await tx.accountLinkRequest.findUnique({ where: { id: requestId } });
        if (!fresh || fresh.status !== 'pending' || fresh.verificationCode !== code) {
          throw new ConflictException('계정 연결 요청 상태가 변경되었습니다.');
        }
        await this.assertSingleMinecraftIdentity(tx, group.accountIds);
        await tx.accountLink.createMany({
          data: [
            { primaryAccountId: fresh.primaryAccountId, linkedAccountId: fresh.targetAccountId },
            { primaryAccountId: fresh.targetAccountId, linkedAccountId: fresh.primaryAccountId },
          ],
          skipDuplicates: true,
        });
        await this.stabilizeCanonicalAccountInTransaction(tx, fresh.primaryAccountId, group.accountIds);
        await this.synchronizeWikiProfileBlocksForAccountLink(tx, group.accountIds);
        await this.revokeWikiApiTokensForAccountLink(tx, group.accountIds);
        await tx.accountLinkRequest.update({
          where: { id: requestId },
          data: { status: 'linked', confirmedAt: new Date() },
        });
      },
    );

    const linkedAccountIds = await this.getLinkedAccountIds(request.primaryAccountId);
    return {
      requestId,
      primaryAccountId: request.primaryAccountId,
      targetAccountId: request.targetAccountId,
      linkedAccountIds
    };
  }

  async linkActiveAccounts(primaryAccountId: string, linkedAccountId: string): Promise<void> {
    await withActiveCanonicalAccountGroup(
      this.prisma,
      [primaryAccountId, linkedAccountId],
      async (tx, group) => {
        await this.assertSingleMinecraftIdentity(tx, group.accountIds);
        await tx.accountLink.createMany({
          data: [
            { primaryAccountId, linkedAccountId },
            { primaryAccountId: linkedAccountId, linkedAccountId: primaryAccountId },
          ],
          skipDuplicates: true,
        });
        await this.stabilizeCanonicalAccountInTransaction(tx, primaryAccountId, group.accountIds);
        await this.synchronizeWikiProfileBlocksForAccountLink(tx, group.accountIds);
        await this.revokeWikiApiTokensForAccountLink(tx, group.accountIds);
      },
    );
  }

  async markEmailVerified(accountId: string): Promise<AccountRecord> {
    const updated = await withActiveCanonicalAccountGroup(this.prisma, [accountId], (tx) =>
      tx.account.update({ where: { id: accountId }, data: { emailVerified: true } })
    );
    return this.toAccountRecord(updated);
  }

  async setPasswordHash(accountId: string, passwordHash: string): Promise<AccountRecord> {
    const updated = await withActiveCanonicalAccountGroup(this.prisma, [accountId], (tx) =>
      tx.account.update({ where: { id: accountId }, data: { passwordHash } })
    );
    return this.toAccountRecord(updated);
  }

  async updateLastLogin(accountId: string, date: Date): Promise<AccountRecord> {
    const account = await this.ensureAccount(accountId);
    const updated = await this.prisma.account.update({
      where: { id: account.id },
      data: { lastLoginAt: date }
    });
    return this.toAccountRecord(updated);
  }

  async stabilizeCanonicalAccount(
    primaryAccountId: string,
    linkedAccountId: string
  ): Promise<string> {
    const primary = await this.prisma.account.findUnique({
      where: { id: primaryAccountId },
      select: { canonicalAccountId: true }
    });
    if (!primary) {
      throw new NotFoundException('계정 정보를 찾을 수 없습니다.');
    }

    const canonicalAccountId = primary.canonicalAccountId ?? primaryAccountId;
    const connectedIds = new Set<string>([primaryAccountId, linkedAccountId]);
    let frontier = [primaryAccountId, linkedAccountId];
    while (frontier.length > 0) {
      const links = await this.prisma.accountLink.findMany({
        where: {
          OR: [
            { primaryAccountId: { in: frontier } },
            { linkedAccountId: { in: frontier } }
          ]
        },
        select: { primaryAccountId: true, linkedAccountId: true }
      });
      const next: string[] = [];
      for (const link of links) {
        for (const accountId of [link.primaryAccountId, link.linkedAccountId]) {
          if (!connectedIds.has(accountId)) {
            connectedIds.add(accountId);
            next.push(accountId);
          }
        }
      }
      frontier = next;
    }

    if (!connectedIds.has(canonicalAccountId)) {
      throw new ConflictException('연결 계정의 대표 계정 정보가 올바르지 않습니다.');
    }
    await this.prisma.account.updateMany({
      where: { id: { in: Array.from(connectedIds) } },
      data: { canonicalAccountId }
    });
    return canonicalAccountId;
  }

  private async stabilizeCanonicalAccountInTransaction(
    tx: import('@prisma/client').Prisma.TransactionClient,
    primaryAccountId: string,
    accountIds: readonly string[],
  ): Promise<void> {
    const primary = await tx.account.findUnique({
      where: { id: primaryAccountId },
      select: { canonicalAccountId: true },
    });
    if (!primary) throw new NotFoundException('계정 정보를 찾을 수 없습니다.');
    const canonicalAccountId = primary.canonicalAccountId && accountIds.includes(primary.canonicalAccountId)
      ? primary.canonicalAccountId
      : primaryAccountId;
    await tx.account.updateMany({
      where: { id: { in: [...accountIds] } },
      data: { canonicalAccountId },
    });
  }

  private async assertSingleMinecraftIdentity(
    tx: import('@prisma/client').Prisma.TransactionClient,
    accountIds: readonly string[],
  ): Promise<void> {
    const identities = await tx.minecraftIdentity.findMany({
      where: { accountId: { in: [...accountIds] } },
      select: { uuid: true },
      take: 2,
    });
    if (identities.length > 1) {
      throw new ConflictException(
        '서로 다른 Minecraft 계정이 인증된 MineWiki 계정은 바로 연결할 수 없습니다. support@minewiki.kr로 병합을 요청해 주세요.',
      );
    }
  }

  private async revokeWikiApiTokensForAccountLink(
    tx: import('@prisma/client').Prisma.TransactionClient,
    accountIds: readonly string[],
  ): Promise<void> {
    await tx.wikiApiToken.updateMany({
      where: { accountId: { in: [...accountIds] }, status: 'active' },
      data: { status: 'revoked', revokedAt: new Date() },
    });
  }

  private async synchronizeWikiProfileBlocksForAccountLink(
    tx: import('@prisma/client').Prisma.TransactionClient,
    accountIds: readonly string[],
  ): Promise<void> {
    const profiles = await tx.wikiProfile.findMany({
      where: { accountId: { in: [...accountIds] }, mergedIntoProfileId: null },
      select: { id: true, status: true },
    });
    if (!profiles.some((profile) => profile.status === 'blocked')) return;
    const activeProfileIds = profiles.filter((profile) => profile.status === 'active').map((profile) => profile.id);
    if (activeProfileIds.length === 0) return;
    const protectedRoles = await tx.accountRole.findMany({
      where: { accountId: { in: [...accountIds] } },
      include: { role: true },
    });
    if (protectedRoles.some((entry) => entry.role.code === 'owner' || entry.role.code === 'admin')) {
      throw new ConflictException('차단된 Wiki 프로필은 운영자 계정 그룹에 연결할 수 없습니다. 먼저 support@minewiki.kr로 문의해 주세요.');
    }
    await tx.wikiProfile.updateMany({
      where: { id: { in: activeProfileIds }, status: 'active' },
      data: { status: 'blocked', updatedAt: new Date() },
    });
  }

  private async ensureAccount(accountId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId }
    });
    if (!account) {
      throw new NotFoundException('계정 정보를 찾을 수 없습니다.');
    }
    return account;
  }

  private generateCode(): string {
    const raw = randomUUID().replace(/-/g, '').slice(0, 6);
    return raw.toUpperCase();
  }

  private toAccountRecord(account: {
    id: string;
    provider: AuthProvider;
    providerUserId: string;
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    createdAt: Date;
    lastLoginAt: Date | null;
    emailVerified: boolean;
    passwordHash: string | null;
    lifecycleStatus: string;
  }): AccountRecord {
    return {
      id: account.id,
      provider: account.provider,
      providerUserId: account.providerUserId,
      email: account.email,
      displayName: account.displayName,
      avatarUrl: account.avatarUrl,
      createdAt: account.createdAt.toISOString(),
      lastLoginAt: account.lastLoginAt ? account.lastLoginAt.toISOString() : null,
      emailVerified: account.emailVerified,
      passwordHash: account.passwordHash,
      lifecycleStatus: account.lifecycleStatus
    };
  }
}

export interface AccountLinkRequest {
  readonly id: string;
  readonly primaryAccountId: string;
  readonly targetAccountId: string;
  verificationCode: string;
  readonly createdAt: string;
  status: 'pending' | 'linked';
}

export interface AccountLinkResult {
  readonly requestId: string;
  readonly primaryAccountId: string;
  readonly targetAccountId: string;
  readonly linkedAccountIds: string[];
}

export interface LinkedAccountRecord {
  readonly id: string;
  readonly provider: AuthProvider;
  readonly email: string | null;
  readonly displayName: string | null;
}

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
import { rehomeReviewsForCanonicalMerge } from '../review/review-account-merge';
import { isProtectedRoleCode } from '../roles/role-policy';

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
        await tx.accountLink.createMany({
          data: [
            { primaryAccountId: fresh.primaryAccountId, linkedAccountId: fresh.targetAccountId },
            { primaryAccountId: fresh.targetAccountId, linkedAccountId: fresh.primaryAccountId },
          ],
          skipDuplicates: true,
        });
        const canonicalAccountId = await this.stabilizeCanonicalAccountInTransaction(
          tx,
          fresh.primaryAccountId,
          group.accountIds,
        );
        await this.finalizeCanonicalAccountMerge(tx, canonicalAccountId, group.accountIds);
        await this.rehomeWebAuthnForCanonicalMerge(tx, fresh.primaryAccountId, group.accountIds);
        await this.assertProtectedRolesRetainMfa(tx, canonicalAccountId);
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
        await this.linkActiveAccountsInTransaction(
          tx,
          primaryAccountId,
          linkedAccountId,
          group.accountIds,
        );
      },
    );
  }

  async linkActiveAccountsInTransaction(
    tx: import('@prisma/client').Prisma.TransactionClient,
    primaryAccountId: string,
    linkedAccountId: string,
    accountIds: readonly string[],
  ): Promise<string> {
    if (
      primaryAccountId === linkedAccountId ||
      !accountIds.includes(primaryAccountId) ||
      !accountIds.includes(linkedAccountId)
    ) {
      throw new ConflictException('연결할 계정 그룹 정보가 올바르지 않습니다.');
    }
    const active = await tx.account.count({
      where: { id: { in: [...accountIds] }, lifecycleStatus: 'active' },
    });
    if (active !== accountIds.length) {
      throw new ConflictException('종료 또는 정지 상태인 계정은 연결할 수 없습니다.');
    }
    await tx.accountLink.createMany({
      data: [
        { primaryAccountId, linkedAccountId },
        { primaryAccountId: linkedAccountId, linkedAccountId: primaryAccountId },
      ],
      skipDuplicates: true,
    });
    const canonicalAccountId = await this.stabilizeCanonicalAccountInTransaction(
      tx,
      primaryAccountId,
      accountIds,
    );
    await this.finalizeCanonicalAccountMerge(tx, canonicalAccountId, accountIds);
    await this.rehomeWebAuthnForCanonicalMerge(tx, primaryAccountId, accountIds);
    await this.assertProtectedRolesRetainMfa(tx, canonicalAccountId);
    await this.synchronizeWikiProfileBlocksForAccountLink(tx, accountIds);
    await this.revokeWikiApiTokensForAccountLink(tx, accountIds);
    return canonicalAccountId;
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
  ): Promise<string> {
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
    return canonicalAccountId;
  }

  private async finalizeCanonicalAccountMerge(
    tx: import('@prisma/client').Prisma.TransactionClient,
    canonicalAccountId: string,
    accountIds: readonly string[],
  ): Promise<void> {
    if (!accountIds.includes(canonicalAccountId)) {
      throw new ConflictException('대표 계정이 연결 계정 그룹과 일치하지 않습니다.');
    }

    const accountIdFilter = { in: [...accountIds], not: canonicalAccountId };
    await tx.server.updateMany({
      where: { ownerAccountId: accountIdFilter },
      data: { ownerAccountId: canonicalAccountId },
    });
    await tx.server.updateMany({
      where: { registrantAccountId: accountIdFilter },
      data: { registrantAccountId: canonicalAccountId },
    });
    await tx.serverClaimMethod.updateMany({
      where: { accountId: accountIdFilter },
      data: { accountId: canonicalAccountId },
    });
    await rehomeReviewsForCanonicalMerge(tx, canonicalAccountId, accountIds);
    await rehomeAccountRolesForCanonicalMerge(tx, canonicalAccountId, accountIds);

    const identities = await tx.minecraftIdentity.findMany({
      where: { accountId: { in: [...accountIds] } },
      select: { id: true, accountId: true, isPrimary: true },
      orderBy: { id: 'asc' },
    });
    if (identities.length === 0) return;

    const primaryIdentity = identities.find(
      (identity) => identity.accountId === canonicalAccountId && identity.isPrimary,
    ) ?? identities.find((identity) => identity.isPrimary)
      ?? identities.find((identity) => identity.accountId === canonicalAccountId)
      ?? identities[0];
    if (!primaryIdentity) return;

    await tx.minecraftIdentity.updateMany({
      where: { accountId: { in: [...accountIds] }, isPrimary: true },
      data: { isPrimary: false },
    });
    await tx.minecraftIdentity.update({
      where: { id: primaryIdentity.id },
      data: { isPrimary: true },
    });
  }

  private async rehomeWebAuthnForCanonicalMerge(
    tx: import('@prisma/client').Prisma.TransactionClient,
    primaryAccountId: string,
    accountIds: readonly string[],
  ): Promise<void> {
    const primary = await tx.account.findUnique({
      where: { id: primaryAccountId },
      select: { id: true, canonicalAccountId: true },
    });
    if (!primary) throw new NotFoundException('계정 정보를 찾을 수 없습니다.');
    const canonicalAccountId = primary.canonicalAccountId ?? primary.id;
    if (!accountIds.includes(canonicalAccountId)) {
      throw new ConflictException('패스키를 이전할 대표 계정이 계정 그룹과 일치하지 않습니다.');
    }

    await rehomeMfaTotpForCanonicalMerge(tx, canonicalAccountId, accountIds);
    await tx.webAuthnChallenge.deleteMany({ where: { accountId: { in: [...accountIds] } } });
    const credentials = await tx.webAuthnCredential.findMany({
      where: { accountId: { in: [...accountIds] } },
      orderBy: { createdAt: 'asc' },
    });
    credentials.sort((left, right) =>
      Number(right.accountId === canonicalAccountId) - Number(left.accountId === canonicalAccountId),
    );
    const reservedNames = new Set(credentials.map((credential) => credential.name.toLocaleLowerCase('en-US')));
    const retainedNames = new Set<string>();
    for (const credential of credentials) {
      const normalized = credential.name.toLocaleLowerCase('en-US');
      if (!retainedNames.has(normalized)) {
        retainedNames.add(normalized);
        continue;
      }
      let suffix = 2;
      let candidate = '';
      do {
        const tail = ` (${suffix})`;
        candidate = `${credential.name.slice(0, Math.max(1, 64 - tail.length))}${tail}`;
        suffix += 1;
      } while (reservedNames.has(candidate.toLocaleLowerCase('en-US')));
      await tx.webAuthnCredential.update({
        where: { id: credential.id },
        data: { name: candidate },
      });
      reservedNames.add(candidate.toLocaleLowerCase('en-US'));
      retainedNames.add(candidate.toLocaleLowerCase('en-US'));
    }
    await tx.webAuthnCredential.updateMany({
      where: { accountId: { in: [...accountIds], not: canonicalAccountId } },
      data: { accountId: canonicalAccountId },
    });
  }

  private async assertProtectedRolesRetainMfa(
    tx: import('@prisma/client').Prisma.TransactionClient,
    canonicalAccountId: string,
  ): Promise<void> {
    const roles = await tx.accountRole.findMany({
      where: { accountId: canonicalAccountId },
      select: { role: { select: { code: true } } },
    });
    if (!roles.some(({ role }) => isProtectedRoleCode(role.code))) return;
    const [totp, passkeyCount] = await Promise.all([
      tx.mfaTotpCredential.findUnique({
        where: { accountId: canonicalAccountId },
        select: { enabledAt: true },
      }),
      tx.webAuthnCredential.count({ where: { accountId: canonicalAccountId } }),
    ]);
    if (!totp?.enabledAt && passkeyCount === 0) {
      throw new ConflictException(
        '보호된 관리자 역할이 있는 계정은 다중 인증을 유지해야 통합할 수 있습니다.',
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

export async function rehomeAccountRolesForCanonicalMerge(
  tx: Pick<import('@prisma/client').Prisma.TransactionClient, 'accountRole'>,
  canonicalAccountId: string,
  accountIds: readonly string[],
): Promise<void> {
  const roles = await tx.accountRole.findMany({
    where: { accountId: { in: [...accountIds] } },
    select: { id: true, accountId: true, roleId: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const rowsByRole = new Map<string, typeof roles>();
  for (const row of roles) {
    const rows = rowsByRole.get(row.roleId) ?? [];
    rows.push(row);
    rowsByRole.set(row.roleId, rows);
  }

  for (const rows of rowsByRole.values()) {
    const canonical = rows.find((row) => row.accountId === canonicalAccountId);
    const keeper = canonical ?? rows[0];
    if (!keeper) continue;
    const duplicateIds = rows.filter((row) => row.id !== keeper.id).map((row) => row.id);
    if (duplicateIds.length > 0) {
      await tx.accountRole.deleteMany({ where: { id: { in: duplicateIds } } });
    }
    if (!canonical) {
      await tx.accountRole.update({
        where: { id: keeper.id },
        data: { accountId: canonicalAccountId },
      });
    }
  }
}

export async function rehomeMfaTotpForCanonicalMerge(
  tx: Pick<
    import('@prisma/client').Prisma.TransactionClient,
    'mfaTotpCredential' | 'mfaRecoveryCode'
  >,
  canonicalAccountId: string,
  accountIds: readonly string[],
): Promise<void> {
  const credentials = await tx.mfaTotpCredential.findMany({
    where: { accountId: { in: [...accountIds] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  credentials.sort((left, right) =>
    Number(Boolean(right.enabledAt)) - Number(Boolean(left.enabledAt))
    || Number(right.accountId === canonicalAccountId) - Number(left.accountId === canonicalAccountId),
  );
  const keeper = credentials[0];
  if (!keeper) {
    await tx.mfaRecoveryCode.deleteMany({
      where: { accountId: { in: [...accountIds] } },
    });
    return;
  }
  const keeperSourceAccountId = keeper.accountId;
  const duplicateIds = credentials.slice(1).map((credential) => credential.id);
  if (duplicateIds.length > 0) {
    await tx.mfaTotpCredential.deleteMany({ where: { id: { in: duplicateIds } } });
  }
  if (keeper.accountId !== canonicalAccountId) {
    await tx.mfaTotpCredential.update({
      where: { id: keeper.id },
      data: { accountId: canonicalAccountId },
    });
  }
  await tx.mfaRecoveryCode.deleteMany({
    where: {
      accountId: { in: [...accountIds], not: keeperSourceAccountId },
    },
  });
  if (keeperSourceAccountId !== canonicalAccountId) {
    await tx.mfaRecoveryCode.updateMany({
      where: { accountId: keeperSourceAccountId },
      data: { accountId: canonicalAccountId },
    });
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

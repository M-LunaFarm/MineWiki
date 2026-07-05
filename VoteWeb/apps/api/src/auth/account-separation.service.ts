import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { authProviderSchema } from '@creepervote/schemas';
import { PrismaService } from '../common/prisma.service';

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
}

export interface RegisterAccountInput {
  readonly provider: AuthProvider;
  readonly providerUserId: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly emailVerified?: boolean;
  readonly passwordHash?: string;
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
    const record = await this.prisma.account.create({
      data: {
        provider: input.provider,
        providerUserId: input.providerUserId,
        email: emailNormalized,
        displayName: input.displayName ?? null,
        emailVerified:
          input.emailVerified ?? (input.provider === 'email' ? false : Boolean(emailNormalized)),
        passwordHash: input.passwordHash ?? null
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
      throw new BadRequestException('?숈씪??怨꾩젙? ?곌껐?????놁뒿?덈떎.');
    }

    const [primary, target] = await Promise.all([
      this.prisma.account.findUnique({ where: { id: primaryAccountId } }),
      this.prisma.account.findUnique({ where: { id: targetAccountId } })
    ]);
    if (!primary || !target) {
      throw new NotFoundException('怨꾩젙 ?뺣낫瑜?李얠쓣 ???놁뒿?덈떎.');
    }
    if (primary.provider === target.provider) {
      throw new BadRequestException('媛숈? ?쒓났??怨꾩젙? ?곌껐?????놁뒿?덈떎.');
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
      throw new BadRequestException('?대? ?곌껐??怨꾩젙?낅땲??');
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
      throw new NotFoundException('?곌껐 ?붿껌??李얠쓣 ???놁뒿?덈떎.');
    }
    if (request.status !== 'pending') {
      throw new BadRequestException('?대? 泥섎━???곌껐 ?붿껌?낅땲??');
    }
    if (request.verificationCode !== code) {
      throw new BadRequestException('寃利?肄붾뱶媛 ?쇱튂?섏? ?딆뒿?덈떎.');
    }

    await this.prisma.$transaction([
      this.prisma.accountLink.create({
        data: {
          primaryAccountId: request.primaryAccountId,
          linkedAccountId: request.targetAccountId
        }
      }),
      this.prisma.accountLink.create({
        data: {
          primaryAccountId: request.targetAccountId,
          linkedAccountId: request.primaryAccountId
        }
      }),
      this.prisma.accountLinkRequest.update({
        where: { id: requestId },
        data: {
          status: 'linked',
          confirmedAt: new Date()
        }
      })
    ]);

    const linkedAccountIds = await this.getLinkedAccountIds(request.primaryAccountId);
    return {
      requestId,
      primaryAccountId: request.primaryAccountId,
      targetAccountId: request.targetAccountId,
      linkedAccountIds
    };
  }

  async markEmailVerified(accountId: string): Promise<AccountRecord> {
    const account = await this.ensureAccount(accountId);
    const updated = await this.prisma.account.update({
      where: { id: account.id },
      data: { emailVerified: true }
    });
    return this.toAccountRecord(updated);
  }

  async setPasswordHash(accountId: string, passwordHash: string): Promise<AccountRecord> {
    const account = await this.ensureAccount(accountId);
    const updated = await this.prisma.account.update({
      where: { id: account.id },
      data: { passwordHash }
    });
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

  private async ensureAccount(accountId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId }
    });
    if (!account) {
      throw new NotFoundException('怨꾩젙 ?뺣낫瑜?李얠쓣 ???놁뒿?덈떎.');
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
      passwordHash: account.passwordHash
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

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

export interface WikiMeResponse {
  readonly account: {
    readonly id: string;
    readonly email: string | null;
    readonly displayName: string | null;
    readonly provider: string;
  };
  readonly wikiProfile: {
    readonly id: string;
    readonly username: string;
    readonly displayName: string;
    readonly status: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
}

@Injectable()
export class WikiProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(accountId: string): Promise<WikiMeResponse> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId }
    });
    if (!account) {
      throw new NotFoundException('Account not found.');
    }
    const wikiProfile = await this.ensureWikiProfile(accountId);
    return {
      account: {
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        provider: account.provider
      },
      wikiProfile: {
        id: wikiProfile.id.toString(),
        username: wikiProfile.username,
        displayName: wikiProfile.displayName,
        status: wikiProfile.status,
        createdAt: wikiProfile.createdAt.toISOString(),
        updatedAt: wikiProfile.updatedAt.toISOString()
      }
    };
  }

  async ensureWikiProfile(accountId: string) {
    const existing = await this.prisma.wikiProfile.findUnique({
      where: { accountId }
    });
    if (existing) {
      return existing;
    }

    const account = await this.prisma.account.findUnique({
      where: { id: accountId }
    });
    if (!account) {
      throw new NotFoundException('Account not found.');
    }

    if (account.email) {
      const legacyByEmail = await this.prisma.wikiProfile.findUnique({
        where: { email: account.email }
      });
      if (legacyByEmail?.accountId === accountId) {
        return legacyByEmail;
      }
      if (legacyByEmail) {
        return this.createWikiProfile(account, null);
      }
    }

    return this.createWikiProfile(account, account.email);
  }

  private createWikiProfile(
    account: { id: string; provider: string; displayName: string | null; email: string | null },
    profileEmail: string | null
  ) {
    const now = new Date();
    return this.prisma.wikiProfile.create({
      data: {
        accountId: account.id,
        username: this.usernameFor(account.provider, account.id),
        displayName: this.displayNameFor(account.displayName, account.email),
        email: profileEmail,
        status: 'active',
        createdAt: now,
        updatedAt: now
      }
    });
  }

  private usernameFor(provider: string, accountId: string): string {
    return `${provider}_${accountId.replace(/-/g, '').slice(0, 24)}`.slice(0, 64);
  }

  private displayNameFor(displayName?: string | null, email?: string | null, fallback?: string): string {
    const candidate = displayName?.trim() || email?.split('@')[0]?.trim() || fallback || 'MineWiki User';
    return candidate.slice(0, 64);
  }
}

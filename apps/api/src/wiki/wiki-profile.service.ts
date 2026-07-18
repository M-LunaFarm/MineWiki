import { Injectable, NotFoundException } from '@nestjs/common';
import { wikiUrl } from '@minewiki/wiki-core';
import type { WikiProfile } from '@prisma/client';
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

export interface WikiPublicProfileResponse {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly status: 'active' | 'blocked';
  readonly createdAt: string;
  readonly documentPath: string;
  readonly documentExists: boolean;
  readonly contributionsPath: string;
  readonly isOwner: boolean;
  readonly canEditDocument: boolean;
  readonly requestedUsername: string;
  readonly canonicalUsername: string;
  readonly isAlias: boolean;
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

  async getPublicProfile(username: string, viewerAccountId: string | null): Promise<WikiPublicProfileResponse> {
    const canonicalUsername = username.normalize('NFKC');
    if (!canonicalUsername || canonicalUsername !== username || canonicalUsername.includes('/')) {
      throw new NotFoundException('Wiki user not found.');
    }
    const directProfile = await this.prisma.wikiProfile.findUnique({ where: { username: canonicalUsername } });
    const usernameAlias = directProfile ? null : await this.prisma.wikiUsernameAlias.findUnique({
      where: { oldUsername: canonicalUsername },
      select: { profileId: true }
    });
    const requestedProfile = directProfile ?? (usernameAlias
      ? await this.prisma.wikiProfile.findUnique({ where: { id: usernameAlias.profileId } })
      : null);
    if (!requestedProfile) {
      throw new NotFoundException('Wiki user not found.');
    }
    const profile = await this.resolveCanonicalProfile(requestedProfile);
    if (!['active', 'blocked'].includes(profile.status)) throw new NotFoundException('Wiki user not found.');
    const namespace = await this.prisma.wikiNamespace.findUnique({
      where: { code: 'user' },
      select: { id: true }
    });
    const rootPage = namespace
      ? await this.prisma.wikiPage.findUnique({
          where: { namespaceId_slug: { namespaceId: namespace.id, slug: profile.username } },
          select: { status: true, ownerProfileId: true }
        })
      : null;
    const isOwner = viewerAccountId !== null && profile.accountId === viewerAccountId;
    return {
      id: profile.id.toString(),
      username: profile.username,
      displayName: profile.displayName,
      status: profile.status as 'active' | 'blocked',
      createdAt: profile.createdAt.toISOString(),
      documentPath: wikiUrl('user', profile.username),
      documentExists: Boolean(rootPage && rootPage.status !== 'deleted' && rootPage.ownerProfileId === profile.id),
      contributionsPath: `/wiki/contributions/${profile.id}`,
      isOwner,
      canEditDocument: isOwner && profile.status === 'active',
      requestedUsername: canonicalUsername,
      canonicalUsername: profile.username,
      isAlias: usernameAlias !== null || requestedProfile.id !== profile.id
    };
  }

  async ensureWikiProfile(accountId: string) {
    const existing = await this.prisma.wikiProfile.findUnique({
      where: { accountId }
    });
    if (existing) {
      return this.resolveCanonicalProfile(existing);
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

  private async resolveCanonicalProfile(profile: WikiProfile): Promise<WikiProfile> {
    let current = profile;
    const visited = new Set<string>();
    for (let depth = 0; depth < 8 && (current.status === 'merged' || current.mergedIntoProfileId); depth += 1) {
      const key = current.id.toString();
      if (visited.has(key)) throw new NotFoundException('Wiki profile alias cycle detected.');
      visited.add(key);
      const alias = await this.prisma.wikiProfileAlias.findUnique({
        where: { sourceProfileId: current.id },
        select: { targetProfileId: true }
      });
      const targetId = alias?.targetProfileId ?? current.mergedIntoProfileId;
      if (!targetId) throw new NotFoundException('Wiki profile alias target not found.');
      const target = await this.prisma.wikiProfile.findUnique({ where: { id: targetId } });
      if (!target) throw new NotFoundException('Wiki profile alias target not found.');
      current = target;
    }
    return current;
  }

  private usernameFor(provider: string, accountId: string): string {
    return `${provider}_${accountId.replace(/-/g, '').slice(0, 24)}`.slice(0, 64);
  }

  private displayNameFor(displayName?: string | null, email?: string | null, fallback?: string): string {
    const candidate = displayName?.trim() || email?.split('@')[0]?.trim() || fallback || 'MineWiki User';
    return candidate.slice(0, 64);
  }
}

import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import { DiscordMinecraftLinkRepository } from '../verify/guild.repositories';

const mergeRequestSchema = z.object({
  message: z.string().trim().max(1000).optional(),
  conflictMessage: z.string().trim().max(500).optional(),
  source: z
    .enum(['account_center', 'minecraft_verify', 'discord_verify', 'wiki_profile'])
    .optional(),
});

type LinkConflictKind =
  | 'verified_email_duplicate'
  | 'minecraft_identity_duplicate'
  | 'discord_identity_duplicate'
  | 'discord_minecraft_mismatch'
  | 'legacy_wiki_profile';

export interface AccountLinkConflict {
  readonly id: string;
  readonly kind: LinkConflictKind;
  readonly message: string;
  readonly minecraftUuid: string | null;
  readonly discordUserId: string | null;
  readonly conflictingAccountId: string | null;
  readonly legacyWikiProfileId: string | null;
}

export interface LinkConflictResponse {
  readonly conflicts: AccountLinkConflict[];
}

export interface MergeRequestResponse {
  readonly ticketId: string;
  readonly status: 'created';
  readonly conflicts: AccountLinkConflict[];
}

@Injectable()
export class AccountConflictService {
  private readonly discordMinecraftLinks: DiscordMinecraftLinkRepository;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: BusinessEventService,
    @Optional() discordMinecraftLinks?: DiscordMinecraftLinkRepository,
  ) {
    this.discordMinecraftLinks =
      discordMinecraftLinks ?? new DiscordMinecraftLinkRepository(prisma);
  }

  async listLinkConflicts(accountId: string): Promise<LinkConflictResponse> {
    return { conflicts: await this.detectConflicts(accountId) };
  }

  async createMergeRequest(accountId: string, payload: unknown): Promise<MergeRequestResponse> {
    const parsed = mergeRequestSchema.parse(payload ?? {});
    const conflicts = await this.resolveRequestConflicts(accountId, parsed);
    if (conflicts.length === 0) {
      throw new BadRequestException('현재 계정에서 복구 요청이 필요한 연동 충돌을 찾지 못했습니다.');
    }

    const now = new Date();
    const ticketId = randomUUID();
    const body = this.buildTicketBody(accountId, conflicts, parsed.message);

    await this.prisma.$transaction([
      this.prisma.supportTicket.create({
        data: {
          id: ticketId,
          requesterAccountId: accountId,
          subject: '계정 병합 지원 요청',
          status: 'open',
          priority: 'high',
          category: 'account',
          lastMessageAt: now,
          createdAt: now,
          updatedAt: now,
        },
      }),
      this.prisma.supportMessage.create({
        data: {
          id: randomUUID(),
          ticketId,
          authorAccountId: accountId,
          authorRole: 'customer',
          body,
          isInternal: false,
          createdAt: now,
        },
      }),
    ]);

    await this.events.audit('account.merge_request.created', {
      category: 'account',
      actorAccountId: accountId,
      subjectType: 'support_ticket',
      subjectId: ticketId,
      metadata: {
        conflicts: conflicts.map((conflict) => ({
          kind: conflict.kind,
          minecraftUuid: conflict.minecraftUuid,
          discordUserId: conflict.discordUserId,
          conflictingAccountId: conflict.conflictingAccountId,
          legacyWikiProfileId: conflict.legacyWikiProfileId,
        })),
      },
    });

    return {
      ticketId,
      status: 'created',
      conflicts,
    };
  }

  private async detectConflicts(accountId: string): Promise<AccountLinkConflict[]> {
    const accounts = await this.prisma.account.findMany({
      where: { OR: [{ id: accountId }, { canonicalAccountId: accountId }] },
      select: {
        id: true,
        provider: true,
        providerUserId: true,
        email: true,
        emailVerified: true,
      },
    });
    const accountIds = accounts.map((account) => account.id);
    if (!accountIds.includes(accountId)) {
      accountIds.unshift(accountId);
    }
    const [minecraftIdentities, discordUserIds] = await Promise.all([
      this.prisma.minecraftIdentity.findMany({
        where: { accountId: { in: accountIds } },
        select: { uuid: true },
        orderBy: { id: 'asc' },
      }),
      this.resolveDiscordUserIds(accountIds, accounts),
    ]);
    const minecraftUuids = new Set(minecraftIdentities.map((identity) => identity.uuid));

    const conflicts: AccountLinkConflict[] = [];
    const verifiedEmails = accounts
      .filter((account) => account.emailVerified && account.email)
      .map((account) => account.email!.trim().toLowerCase());
    if (verifiedEmails.length > 0) {
      const [duplicateEmailAccount, linkedWikiProfile, legacyWikiProfile] = await Promise.all([
        this.prisma.account.findFirst({
          where: {
            id: { notIn: accountIds },
            email: { in: verifiedEmails },
            emailVerified: true,
            lifecycleStatus: 'active',
          },
          select: { id: true },
        }),
        this.prisma.wikiProfile.findFirst({
          where: { accountId: { in: accountIds } },
          select: { id: true },
        }),
        this.prisma.wikiProfile.findFirst({
          where: {
            accountId: null,
            email: { in: verifiedEmails },
            status: 'active',
          },
          select: { id: true },
        }),
      ]);
      if (duplicateEmailAccount) {
        conflicts.push({
          id: `verified-email:${duplicateEmailAccount.id}`,
          kind: 'verified_email_duplicate',
          message:
            '같은 인증 이메일을 사용하는 별도 MineWiki 계정이 있습니다. 자동 병합하지 않고 로그인 수단 소유권 확인 후 연결해야 합니다.',
          minecraftUuid: null,
          discordUserId: null,
          conflictingAccountId: duplicateEmailAccount.id,
          legacyWikiProfileId: null,
        });
      }
      if (!linkedWikiProfile && legacyWikiProfile) {
        conflicts.push({
          id: `legacy-wiki:${legacyWikiProfile.id.toString()}`,
          kind: 'legacy_wiki_profile',
          message:
            '인증된 이메일과 일치하는 기존 MineWiki 위키 프로필이 있습니다. 기록 이전은 지원팀 확인 후 진행됩니다.',
          minecraftUuid: null,
          discordUserId: null,
          conflictingAccountId: null,
          legacyWikiProfileId: legacyWikiProfile.id.toString(),
        });
      }
    }
    for (const minecraftIdentity of minecraftIdentities) {
      const duplicateIdentity = await this.prisma.minecraftIdentity.findFirst({
        where: {
          uuid: minecraftIdentity.uuid,
          accountId: { notIn: accountIds },
        },
        select: { accountId: true },
      });
      if (duplicateIdentity) {
        conflicts.push({
          id: `minecraft:${minecraftIdentity.uuid}:${duplicateIdentity.accountId}`,
          kind: 'minecraft_identity_duplicate',
          message: '이 Minecraft 계정이 다른 MineWiki 계정에 이미 연결되어 있습니다.',
          minecraftUuid: minecraftIdentity.uuid,
          discordUserId: null,
          conflictingAccountId: duplicateIdentity.accountId,
          legacyWikiProfileId: null,
        });
      }

      const linkedDiscord = await this.discordMinecraftLinks.findByMinecraftUuid(
        minecraftIdentity.uuid,
      );
      if (linkedDiscord && !discordUserIds.includes(linkedDiscord.discordUserId)) {
        conflicts.push({
          id: `minecraft-discord:${minecraftIdentity.uuid}:${linkedDiscord.discordUserId}`,
          kind: 'discord_minecraft_mismatch',
          message: '이 Minecraft 계정이 다른 Discord 계정의 검증 기록과 충돌합니다.',
          minecraftUuid: minecraftIdentity.uuid,
          discordUserId: linkedDiscord.discordUserId,
          conflictingAccountId: null,
          legacyWikiProfileId: null,
        });
      }
    }

    for (const discordUserId of discordUserIds) {
      const [duplicateAccount, duplicateCredential, linkedMinecraft] = await Promise.all([
        this.prisma.account.findFirst({
          where: {
            provider: 'discord',
            providerUserId: discordUserId,
            id: { notIn: accountIds },
          },
          select: { id: true },
        }),
        this.prisma.oAuthCredential.findFirst({
          where: {
            provider: 'discord',
            providerUserId: discordUserId,
            accountId: { notIn: accountIds },
          },
          select: { accountId: true },
        }),
        this.discordMinecraftLinks.findByDiscordUserId(discordUserId),
      ]);
      const conflictingAccountId = duplicateAccount?.id ?? duplicateCredential?.accountId ?? null;
      if (conflictingAccountId) {
        conflicts.push({
          id: `discord:${discordUserId}:${conflictingAccountId}`,
          kind: 'discord_identity_duplicate',
          message: '이 Discord 계정이 다른 MineWiki 계정에 이미 연결되어 있습니다.',
          minecraftUuid: null,
          discordUserId,
          conflictingAccountId,
          legacyWikiProfileId: null,
        });
      }
      if (
        linkedMinecraft &&
        minecraftUuids.size > 0 &&
        !minecraftUuids.has(linkedMinecraft.minecraftUuid)
      ) {
        conflicts.push({
          id: `discord-minecraft:${discordUserId}:${linkedMinecraft.minecraftUuid}`,
          kind: 'discord_minecraft_mismatch',
          message: '이 Discord 계정이 다른 Minecraft 검증 기록과 충돌합니다.',
          minecraftUuid: linkedMinecraft.minecraftUuid,
          discordUserId,
          conflictingAccountId: null,
          legacyWikiProfileId: null,
        });
      }
    }

    return uniqueConflicts(conflicts);
  }

  private async resolveRequestConflicts(
    accountId: string,
    parsed: z.infer<typeof mergeRequestSchema>,
  ): Promise<AccountLinkConflict[]> {
    const detected = await this.detectConflicts(accountId);
    if (detected.length > 0 || !parsed.conflictMessage) {
      return detected;
    }
    const source = parsed.source ?? 'account_center';
    return [
      {
        id: `manual:${source}:${accountId}`,
        kind:
          source === 'minecraft_verify'
            ? 'minecraft_identity_duplicate'
            : 'discord_minecraft_mismatch',
        message: parsed.conflictMessage,
        minecraftUuid: null,
        discordUserId: null,
        conflictingAccountId: null,
        legacyWikiProfileId: null,
      },
    ];
  }

  private async resolveDiscordUserIds(
    accountIds: string[],
    accounts: Array<{ provider: string; providerUserId: string }>,
  ): Promise<string[]> {
    const credentials = await this.prisma.oAuthCredential.findMany({
      where: { accountId: { in: accountIds }, provider: 'discord' },
      select: { providerUserId: true },
    });
    const ids = new Set<string>();
    for (const account of accounts) {
      if (account.provider === 'discord') {
        ids.add(account.providerUserId);
      }
    }
    for (const credential of credentials) {
      ids.add(credential.providerUserId);
    }
    return [...ids];
  }

  private buildTicketBody(
    accountId: string,
    conflicts: AccountLinkConflict[],
    userMessage?: string,
  ): string {
    const lines = [
      '[계정 병합/충돌 복구 요청]',
      `요청 계정: ${accountId}`,
      '',
      '감지된 충돌:',
      ...conflicts.map(
        (conflict) =>
          `- ${conflict.kind}: ${conflict.message} minecraft=${conflict.minecraftUuid ?? 'n/a'} discord=${conflict.discordUserId ?? 'n/a'} account=${conflict.conflictingAccountId ?? 'n/a'} wiki_profile=${conflict.legacyWikiProfileId ?? 'n/a'}`,
      ),
    ];
    if (userMessage) {
      lines.push('', '사용자 메모:', userMessage);
    }
    lines.push(
      '',
      '자동 병합은 수행되지 않습니다. 상담원이 신원 확인 후 지원 티켓 상태로 승인/반려를 기록합니다.',
    );
    return lines.join('\n').slice(0, 2000);
  }
}

function uniqueConflicts(conflicts: AccountLinkConflict[]): AccountLinkConflict[] {
  const seen = new Set<string>();
  return conflicts.filter((conflict) => {
    if (seen.has(conflict.id)) {
      return false;
    }
    seen.add(conflict.id);
    return true;
  });
}

import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import { DiscordMinecraftLinkRepository } from '../verify/guild.repositories';

const mergeRequestSchema = z.object({
  message: z.string().trim().max(1000).optional(),
  conflictMessage: z.string().trim().max(500).optional(),
  source: z.enum(['account_center', 'minecraft_verify', 'discord_verify']).optional(),
});

type LinkConflictKind =
  | 'minecraft_identity_duplicate'
  | 'discord_identity_duplicate'
  | 'discord_minecraft_mismatch';

export interface AccountLinkConflict {
  readonly id: string;
  readonly kind: LinkConflictKind;
  readonly message: string;
  readonly minecraftUuid: string | null;
  readonly discordUserId: string | null;
  readonly conflictingAccountId: string | null;
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
    const [minecraftIdentity, discordUserIds] = await Promise.all([
      this.prisma.minecraftIdentity.findUnique({
        where: { accountId },
        select: { uuid: true },
      }),
      this.resolveDiscordUserIds(accountId),
    ]);

    const conflicts: AccountLinkConflict[] = [];
    if (minecraftIdentity) {
      const duplicateIdentity = await this.prisma.minecraftIdentity.findFirst({
        where: {
          uuid: minecraftIdentity.uuid,
          accountId: { not: accountId },
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
        });
      }
    }

    for (const discordUserId of discordUserIds) {
      const [duplicateAccount, duplicateCredential, linkedMinecraft] = await Promise.all([
        this.prisma.account.findFirst({
          where: {
            provider: 'discord',
            providerUserId: discordUserId,
            id: { not: accountId },
          },
          select: { id: true },
        }),
        this.prisma.oAuthCredential.findFirst({
          where: {
            provider: 'discord',
            providerUserId: discordUserId,
            accountId: { not: accountId },
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
        });
      }
      if (
        linkedMinecraft &&
        minecraftIdentity &&
        linkedMinecraft.minecraftUuid !== minecraftIdentity.uuid
      ) {
        conflicts.push({
          id: `discord-minecraft:${discordUserId}:${linkedMinecraft.minecraftUuid}`,
          kind: 'discord_minecraft_mismatch',
          message: '이 Discord 계정이 다른 Minecraft 검증 기록과 충돌합니다.',
          minecraftUuid: linkedMinecraft.minecraftUuid,
          discordUserId,
          conflictingAccountId: null,
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
      },
    ];
  }

  private async resolveDiscordUserIds(accountId: string): Promise<string[]> {
    const [account, credentials] = await Promise.all([
      this.prisma.account.findUnique({
        where: { id: accountId },
        select: { provider: true, providerUserId: true },
      }),
      this.prisma.oAuthCredential.findMany({
        where: { accountId, provider: 'discord' },
        select: { providerUserId: true },
      }),
    ]);
    const ids = new Set<string>();
    if (account?.provider === 'discord') {
      ids.add(account.providerUserId);
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
          `- ${conflict.kind}: ${conflict.message} minecraft=${conflict.minecraftUuid ?? 'n/a'} discord=${conflict.discordUserId ?? 'n/a'} account=${conflict.conflictingAccountId ?? 'n/a'}`,
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

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

export interface VoteRecord {
  readonly serverId: string;
  readonly username: string;
  readonly votedAt: Date;
  readonly accountId?: string;
  readonly minecraftUuid?: string;
  readonly ipAddress?: string;
}

@Injectable()
export class VoteStore {
  constructor(private readonly prisma: PrismaService) {}

  async record(record: VoteRecord): Promise<void> {
    await this.prisma.vote.create({
      data: {
        serverId: record.serverId,
        username: record.username,
        usernameNormalized: normalizeUsername(record.username),
        accountId: record.accountId ?? null,
        minecraftUuid: record.minecraftUuid ?? null,
        ipAddress: record.ipAddress ?? null,
        votedAt: record.votedAt
      }
    });
  }

  async getDailyCount(serverId: string, timestamp: Date): Promise<number> {
    const { start, end } = dayBoundsKst(timestamp);
    return this.prisma.vote.count({
      where: {
        serverId,
        votedAt: { gte: start, lt: end }
      }
    });
  }

  async getLastVoteForMinecraft(serverId: string, minecraftUuid: string): Promise<VoteRecord | undefined> {
    return this.getLastVote({ serverId, minecraftUuid });
  }

  async getLastVoteForMinecraftGlobal(minecraftUuid: string): Promise<VoteRecord | undefined> {
    return this.getLastVote({ minecraftUuid });
  }

  async getLastVoteForAccount(serverId: string, accountId: string): Promise<VoteRecord | undefined> {
    return this.getLastVote({ serverId, accountId });
  }

  async getLastVoteForAccountGlobal(accountId: string): Promise<VoteRecord | undefined> {
    return this.getLastVote({ accountId });
  }

  async getLastVoteForUsername(serverId: string, username: string): Promise<VoteRecord | undefined> {
    return this.getLastVote({ serverId, usernameNormalized: normalizeUsername(username) });
  }

  async getLastVoteForUsernameGlobal(username: string): Promise<VoteRecord | undefined> {
    return this.getLastVote({ usernameNormalized: normalizeUsername(username) });
  }

  async getLastVoteForIp(serverId: string, ipAddress: string): Promise<VoteRecord | undefined> {
    return this.getLastVote({ serverId, ipAddress });
  }

  async getLastVoteForIpGlobal(ipAddress: string): Promise<VoteRecord | undefined> {
    return this.getLastVote({ ipAddress });
  }

  private async getLastVote(where: {
    serverId?: string;
    accountId?: string;
    minecraftUuid?: string;
    usernameNormalized?: string;
    ipAddress?: string;
  }): Promise<VoteRecord | undefined> {
    const record = await this.prisma.vote.findFirst({
      where,
      orderBy: { votedAt: 'desc' }
    });
    if (!record) {
      return undefined;
    }
    return {
      serverId: record.serverId,
      username: record.username,
      votedAt: record.votedAt,
      accountId: record.accountId ?? undefined,
      minecraftUuid: record.minecraftUuid ?? undefined,
      ipAddress: record.ipAddress ?? undefined
    };
  }
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function dayBoundsKst(date: Date): { start: Date; end: Date } {
  const dayMs = 24 * 60 * 60 * 1000;
  const kstOffsetMs = 9 * 60 * 60 * 1000;
  const shifted = date.getTime() + kstOffsetMs;
  const startShifted = Math.floor(shifted / dayMs) * dayMs;
  const start = new Date(startShifted - kstOffsetMs);
  const end = new Date(start.getTime() + dayMs);
  return { start, end };
}

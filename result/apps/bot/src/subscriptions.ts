import { DateTime } from 'luxon';
import type { PrismaClient, DiscordSubscription } from '@prisma/client';

export interface SubscriptionRequest {
  readonly channelId: string;
  readonly timezone?: string | null;
  readonly roleRewardId?: string | null;
}

export interface GuildSubscription {
  readonly guildId: string;
  readonly channelId: string;
  readonly timezone: string;
  readonly roleRewardId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextDigestAt: string;
}

const DEFAULT_TIMEZONE = 'Asia/Seoul';

export class SubscriptionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(guildId: string, request: SubscriptionRequest): Promise<GuildSubscription> {
    const timezone = validateTimezone(request.timezone ?? DEFAULT_TIMEZONE);
    const now = DateTime.utc();
    const existing = await this.prisma.discordSubscription.findUnique({
      where: { guildId }
    });
    const nextDigest = computeNextDigest(timezone, now).toUTC().toJSDate();
    const nextDigestAt = existing
      ? pickEarlierDate(existing.nextDigestAt, nextDigest)
      : nextDigest;

    const record = await this.prisma.discordSubscription.upsert({
      where: { guildId },
      create: {
        guildId,
        channelId: request.channelId,
        timezone,
        roleRewardId: request.roleRewardId ?? null,
        nextDigestAt
      },
      update: {
        channelId: request.channelId,
        timezone,
        roleRewardId: request.roleRewardId ?? null,
        nextDigestAt
      }
    });

    return toSubscription(record);
  }

  async get(guildId: string): Promise<GuildSubscription | undefined> {
    const record = await this.prisma.discordSubscription.findUnique({
      where: { guildId }
    });
    return record ? toSubscription(record) : undefined;
  }

  async remove(guildId: string): Promise<void> {
    await this.prisma.discordSubscription.delete({
      where: { guildId }
    });
  }

  async all(): Promise<GuildSubscription[]> {
    const records = await this.prisma.discordSubscription.findMany();
    return records.map(toSubscription);
  }

  async due(reference: Date): Promise<GuildSubscription[]> {
    const records = await this.prisma.discordSubscription.findMany({
      where: { nextDigestAt: { lte: reference } }
    });
    return records.map(toSubscription);
  }

  async updateNextDigest(guildId: string, from?: Date): Promise<GuildSubscription | undefined> {
    const record = await this.prisma.discordSubscription.findUnique({
      where: { guildId }
    });
    if (!record) {
      return undefined;
    }
    const reference = from
      ? DateTime.fromJSDate(from, { zone: 'utc' })
      : DateTime.fromJSDate(record.nextDigestAt, { zone: 'utc' });
    const next = computeNextDigest(record.timezone, reference.plus({ minutes: 1 }));
    const updated = await this.prisma.discordSubscription.update({
      where: { guildId },
      data: {
        nextDigestAt: next.toUTC().toJSDate()
      }
    });
    return toSubscription(updated);
  }
}

export function computeNextDigest(
  timezone: string,
  reference: DateTime = DateTime.utc()
): DateTime {
  const zonedNow = reference.setZone(timezone, { keepLocalTime: false });
  if (!zonedNow.isValid) {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
  const startOfToday = zonedNow.startOf('day');
  const nextMidnight =
    zonedNow <= startOfToday ? startOfToday : startOfToday.plus({ days: 1 });
  return nextMidnight;
}

export function validateTimezone(timezone: string): string {
  const trimmed = timezone.trim();
  if (trimmed.length === 0) {
    throw new Error('Timezone must not be empty.');
  }
  const probe = DateTime.utc().setZone(trimmed);
  if (!probe.isValid) {
    throw new Error(`Unsupported timezone: ${trimmed}`);
  }
  return trimmed;
}

function toSubscription(record: DiscordSubscription): GuildSubscription {
  return {
    guildId: record.guildId,
    channelId: record.channelId,
    timezone: record.timezone,
    roleRewardId: record.roleRewardId ?? undefined,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    nextDigestAt: record.nextDigestAt.toISOString()
  };
}

function pickEarlierDate(existing: Date, candidate: Date): Date {
  return existing.getTime() < candidate.getTime() ? existing : candidate;
}

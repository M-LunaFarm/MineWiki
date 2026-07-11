import { Logger } from '@minewiki/logger';
import type { DiscordDigestJob } from '@minewiki/schemas';
import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DIGEST_TITLE = 'MineWiki Servers Daily Digest';
const DIGEST_COLOR = 0x4338ca;

const DISCORD_ERROR_CODES = {
  MISSING_PERMISSIONS: 50013,
  UNKNOWN_CHANNEL: 10003
} as const;

type DiscordDeliveryStatus =
  | 'delivered'
  | 'missing_permissions'
  | 'channel_missing'
  | 'rate_limited'
  | 'unknown_error';

interface NormalizedDiscordError {
  readonly status: Exclude<DiscordDeliveryStatus, 'delivered'>;
  readonly errorCode?: string | number;
  readonly retryAt?: string | null;
}

export interface DiscordDigestResult {
  readonly delivered: boolean;
  readonly status: DiscordDeliveryStatus;
  readonly retryAt?: string | null;
  readonly errorCode?: string | number;
}

export interface DigestSummary {
  readonly metrics: {
    votes: number;
    reviews: number;
    rankDelta: number;
  };
  readonly rising: Array<{ name: string; rank: number; delta: number }>;
  readonly reviews: Array<{ server: string; body: string; rating: number }>;
}

export interface DigestMessage {
  readonly content?: string;
  readonly embeds: DiscordEmbed[];
  readonly allowedMentions?: DiscordAllowedMentions;
}

export interface DiscordDigestExecutionJob extends DiscordDigestJob {
  readonly channelId: string;
  readonly timezone: string;
  readonly roleRewardId?: string;
}

type DiscordDeliver = (job: DiscordDigestExecutionJob) => Promise<void>;

type PrismaHandle = Pick<PrismaClient, 'serverStats' | 'server' | 'serverReview' | 'vote'>;

interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

interface DiscordAllowedMentions {
  roles?: string[];
  parse?: string[];
}

interface DiscordMessagePayload {
  content?: string;
  embeds?: DiscordEmbed[];
  allowed_mentions?: DiscordAllowedMentions;
}

export function createDiscordDigestSender(deliver: DiscordDeliver) {
  async function send(job: DiscordDigestExecutionJob): Promise<DiscordDigestResult> {
    try {
      await deliver(job);
      return {
        delivered: true,
        status: 'delivered'
      };
    } catch (error) {
      const normalized = normalizeDiscordError(error);
      Logger.warn(
        {
          guildId: job.guildId,
          channelId: job.channelId,
          scheduledFor: job.scheduledFor,
          timezone: job.timezone,
          errorCode: normalized.errorCode,
          status: normalized.status,
          retryAt: normalized.retryAt ?? undefined
        },
        'Discord digest delivery failed'
      );

      return {
        delivered: false,
        status: normalized.status,
        retryAt: normalized.retryAt ?? undefined,
        errorCode: normalized.errorCode
      };
    }
  }

  return { send };
}

export function createDiscordDigestDeliverer(options: {
  prisma: PrismaHandle;
  token: string;
}): DiscordDeliver {
  const { prisma, token } = options;

  return async (job) => {
    if (!token) {
      const error = new Error('Discord bot token missing') as Error & { status?: number };
      error.status = 401;
      throw error;
    }

    const reference = DateTime.fromISO(job.scheduledFor, { zone: 'utc' });
    const effectiveReference = reference.isValid ? reference : DateTime.utc();
    const summary = await buildDigestSummary(prisma, effectiveReference);
    const nextDigestAt = computeNextDigest(job.timezone, effectiveReference.plus({ minutes: 1 }));
    const message = buildDigestMessage(summary, {
      timezone: job.timezone,
      nextDigestAt,
      roleRewardId: job.roleRewardId
    });

    await sendDiscordMessage(token, job.channelId, message);
  };
}

function normalizeDiscordError(error: unknown): NormalizedDiscordError {
  const errorObject = error as
    | undefined
    | null
    | {
        code?: string | number;
        status?: number;
        httpStatus?: number;
        retry_after?: number;
        retryAfter?: number;
        message?: string;
      };

  const code = errorObject?.code ?? errorObject?.status ?? errorObject?.httpStatus;
  const retryAfterSeconds =
    errorObject?.retry_after ?? errorObject?.retryAfter ?? undefined;

  if (code === DISCORD_ERROR_CODES.MISSING_PERMISSIONS || code === 403) {
    return {
      status: 'missing_permissions',
      errorCode: code
    };
  }

  if (code === DISCORD_ERROR_CODES.UNKNOWN_CHANNEL || code === 404) {
    return {
      status: 'channel_missing',
      errorCode: code
    };
  }

  if (code === 429) {
    const retryAt =
      typeof retryAfterSeconds === 'number'
        ? new Date(Date.now() + retryAfterSeconds * 1000).toISOString()
        : null;
    return {
      status: 'rate_limited',
      errorCode: code,
      retryAt
    };
  }

  return {
    status: 'unknown_error',
    errorCode: code ?? errorObject?.message
  };
}

async function buildDigestSummary(
  prisma: PrismaHandle,
  reference: DateTime
): Promise<DigestSummary> {
  const since = reference.minus({ hours: 24 }).toJSDate();

  const [votes, reviews, topServer, risingStats, reviewRows] = await Promise.all([
    prisma.vote.count({
      where: { votedAt: { gte: since } }
    }),
    prisma.serverReview.count({
      where: { createdAt: { gte: since }, visibility: 'public' }
    }),
    prisma.serverStats.findFirst({
      orderBy: { rankCurrent: 'asc' },
      select: { rankDelta24h: true }
    }),
    prisma.serverStats.findMany({
      where: { rankDelta24h: { gt: 0 } },
      orderBy: { rankDelta24h: 'desc' },
      take: 3,
      include: { server: { select: { name: true } } }
    }),
    prisma.serverReview.findMany({
      where: { createdAt: { gte: since }, visibility: 'public' },
      orderBy: [{ rating: 'desc' }, { createdAt: 'desc' }],
      take: 2,
      include: { server: { select: { name: true } } }
    })
  ]);

  return {
    metrics: {
      votes,
      reviews,
      rankDelta: topServer?.rankDelta24h ?? 0
    },
    rising: risingStats.map((entry) => ({
      name: entry.server.name,
      rank: entry.rankCurrent,
      delta: entry.rankDelta24h
    })),
    reviews: reviewRows.map((entry) => ({
      server: entry.server.name,
      body: entry.body,
      rating: entry.rating
    }))
  };
}

function buildDigestMessage(
  summary: DigestSummary,
  options: { timezone: string; nextDigestAt: DateTime; roleRewardId?: string }
): DigestMessage {
  const risingLines = summary.rising.length
    ? summary.rising.map(formatRisingLine).join('\n')
    : 'No movers yet.';
  const reviewLines = summary.reviews.length
    ? summary.reviews.map(formatReviewLine).join('\n')
    : 'No new reviews in the last 24h.';

  const description = [
    '**Top Rising Servers**',
    risingLines,
    '',
    '**Notable Reviews**',
    reviewLines
  ]
    .filter(Boolean)
    .join('\n');

  const rankDeltaLabel = formatDelta(summary.metrics.rankDelta);

  const embed: DiscordEmbed = {
    title: DIGEST_TITLE,
    description,
    color: DIGEST_COLOR,
    footer: {
      text: `Next digest: ${formatNextDigest(options.nextDigestAt, options.timezone)}`
    },
    timestamp: new Date().toISOString(),
    fields: [
      {
        name: 'Votes (24h)',
        value: summary.metrics.votes.toLocaleString('en-US'),
        inline: true
      },
      {
        name: 'New reviews',
        value: summary.metrics.reviews.toLocaleString('en-US'),
        inline: true
      },
      {
        name: 'Rank delta',
        value: rankDeltaLabel,
        inline: true
      }
    ]
  };

  const content = options.roleRewardId
    ? `<@&${options.roleRewardId}> Daily MineWiki Servers digest is ready.`
    : undefined;

  return {
    content,
    embeds: [embed],
    allowedMentions: options.roleRewardId ? { roles: [options.roleRewardId] } : { parse: [] }
  };
}

function formatRisingLine(entry: { name: string; rank: number; delta: number }): string {
  const arrow = entry.delta >= 0 ? '▲' : '▼';
  return `${arrow} **${entry.name}** #${entry.rank} (${formatDelta(entry.delta)})`;
}

function formatReviewLine(entry: { server: string; body: string; rating: number }): string {
  const trimmed = entry.body.length > 80 ? `${entry.body.slice(0, 77)}...` : entry.body;
  return `★ **${entry.server}** (${entry.rating}): _${trimmed}_`;
}

function formatDelta(value: number): string {
  if (value === 0) {
    return '0';
  }
  return value > 0 ? `+${value}` : `-${Math.abs(value)}`;
}

function formatNextDigest(nextDigestAt: DateTime, timezone: string): string {
  const localized = nextDigestAt.setZone(timezone, { keepLocalTime: false });
  return localized.isValid ? localized.toFormat('LLL dd HH:mm (ZZ)') : nextDigestAt.toISO();
}

function computeNextDigest(timezone: string, reference: DateTime): DateTime {
  const zonedNow = reference.setZone(timezone, { keepLocalTime: false });
  if (!zonedNow.isValid) {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
  const startOfToday = zonedNow.startOf('day');
  const nextMidnight = zonedNow <= startOfToday ? startOfToday : startOfToday.plus({ days: 1 });
  return nextMidnight;
}

async function sendDiscordMessage(
  token: string,
  channelId: string,
  message: DigestMessage
): Promise<void> {
  const payload: DiscordMessagePayload = {
    content: message.content,
    embeds: message.embeds,
    allowed_mentions: message.allowedMentions
  };

  const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let body: { code?: number; message?: string; retry_after?: number } | undefined;
    try {
      body = (await response.json()) as { code?: number; message?: string; retry_after?: number };
    } catch {
      body = undefined;
    }
    const error = new Error(body?.message ?? `Discord API error (${response.status})`) as Error & {
      code?: number | string;
      status?: number;
      retry_after?: number;
    };
    error.code = body?.code ?? response.status;
    error.status = response.status;
    if (body?.retry_after !== undefined) {
      error.retry_after = body.retry_after;
    }
    throw error;
  }
}

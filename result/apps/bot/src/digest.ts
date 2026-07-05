import type { APIEmbed } from 'discord-api-types/v10';
import { DateTime } from 'luxon';
import type { GuildSubscription } from './subscriptions';

export interface DigestContent {
  readonly embeds: APIEmbed[];
  readonly content?: string;
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

export interface RankEntry {
  readonly name: string;
  readonly votes: number;
  readonly rank: number;
  readonly delta: number;
}

export interface RisingEntry {
  readonly name: string;
  readonly rank: number;
  readonly delta: number;
}

export function createDigestContent(
  summary: DigestSummary,
  options: {
    timezone: string;
    nextDigestAt: string;
    title?: string;
    roleRewardId?: string;
  }
): DigestContent {
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

  const embed: APIEmbed = {
    title: options.title ?? 'MineWiki Servers Daily Digest',
    description,
    color: 0x4338ca,
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
        value: formatDelta(summary.metrics.rankDelta),
        inline: true
      }
    ]
  };

  const content = options.roleRewardId
    ? `<@&${options.roleRewardId}> Daily MineWiki Servers digest is ready.`
    : undefined;

  return { embeds: [embed], content };
}

export function createPreviewContent(summary: DigestSummary): DigestContent {
  const nextDigestAt = DateTime.utc().plus({ days: 1 }).toISO();
  return createDigestContent(summary, {
    timezone: 'Asia/Seoul',
    nextDigestAt,
    title: 'MineWiki Servers Daily Digest (Preview)'
  });
}

export function createRankContent(entries: RankEntry[]): DigestContent {
  const description = entries.length
    ? entries
        .map((entry) =>
          `#${entry.rank} **${entry.name}** — ${entry.votes.toLocaleString('en-US')} votes (${formatDelta(entry.delta)})`
        )
        .join('\n')
    : 'No ranking data available yet.';

  const embed: APIEmbed = {
    title: 'Current Leaderboard',
    color: 0x16a34a,
    description
  };
  return { embeds: [embed] };
}

export function createRisingContent(entries: RisingEntry[]): DigestContent {
  const description = entries.length
    ? entries
        .map((entry) => `▲ **${entry.name}** #${entry.rank} (${formatDelta(entry.delta)})`)
        .join('\n')
    : 'No rising servers yet.';

  const embed: APIEmbed = {
    title: 'Top Risers',
    color: 0xf59e0b,
    description
  };
  return { embeds: [embed] };
}

export function createRewardsContent(subscription?: GuildSubscription): DigestContent {
  if (!subscription?.roleRewardId) {
    return {
      embeds: [
        {
          title: 'Role rewards',
          description: 'No reward role configured yet. Use /minewiki subscribe to set one.',
          color: 0x64748b
        }
      ]
    };
  }
  return {
    embeds: [
      {
        title: 'Role rewards',
        description: `Daily digest will mention <@&${subscription.roleRewardId}>.`,
        color: 0x22c55e
      }
    ]
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

function formatNextDigest(nextDigestAt: string, timezone: string): string {
  const parsed = DateTime.fromISO(nextDigestAt, { zone: 'utc' }).setZone(timezone);
  return parsed.isValid ? parsed.toFormat('LLL dd HH:mm (ZZ)') : nextDigestAt;
}

import type { ServerDetail, ServerReviewAggregate, ServerStats } from '@minewiki/schemas';

interface ServerJsonLdProps {
  readonly detail: ServerDetail;
  readonly stats?: ServerStats | null;
  readonly reviewAggregate?: ServerReviewAggregate;
  readonly path: string;
  readonly siteUrl?: string;
}

function toGameServerStatus(stats?: ServerStats | null): 'Online' | 'OnlineFull' | 'OfflineTemporarily' {
  if (!stats) {
    return 'OfflineTemporarily';
  }
  if (stats.players.online >= stats.players.max) {
    return 'OnlineFull';
  }
  return 'Online';
}

export function ServerJsonLd({ detail, stats, reviewAggregate, path, siteUrl }: ServerJsonLdProps) {
  const fullUrl = siteUrl ? new URL(path, siteUrl).toString() : undefined;
  const sameAs = [detail.websiteUrl, detail.discordUrl].filter(Boolean);

  const payload: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'GameServer',
    '@id': fullUrl,
    name: detail.name,
    description: detail.shortDescription,
    identifier: detail.id,
    url: fullUrl,
    game: {
      '@type': 'VideoGame',
      name: 'Minecraft'
    },
    gameServerType: detail.edition === 'java' ? 'Java Edition' : 'Bedrock Edition',
    gameServerStatus: toGameServerStatus(stats),
    address: detail.joinHost,
    additionalProperty: [
      {
        '@type': 'PropertyValue',
        name: 'joinPort',
        value: detail.joinPort
      },
      {
        '@type': 'PropertyValue',
        name: 'supportedVersions',
        value: detail.supportedVersions.join(', ')
      }
    ],
    playersOnline: stats?.players.online,
    playersCapacity: stats?.players.max,
    uptime: stats?.uptimePercent,
    sameAs: sameAs.length > 0 ? sameAs : undefined,
    image: detail.bannerUrl
  };

  if (reviewAggregate && reviewAggregate.average !== null && reviewAggregate.total > 0) {
    payload.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: Number(reviewAggregate.average.toFixed(1)),
      reviewCount: reviewAggregate.total,
      bestRating: 5,
      worstRating: 1
    };
  }

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(payload) }}
    />
  );
}

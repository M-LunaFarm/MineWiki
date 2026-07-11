import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  fetchServerDetail,
  fetchServerUpdates,
  fetchServerReviews,
  fetchServerStats,
  fetchServerReferrals,
  fetchServerSummaries,
} from '../../../lib/api';
import { ServerJsonLd } from '../../../components/servers/server-json-ld';
import { getApiBaseUrl } from '../../../lib/runtime-config';
import { ServerDetailShowcase } from '../../../components/servers/server-detail-showcase';
import { buildServerPath, resolveServerRouteId } from '../../../lib/server-routes';
import { createPageMetadata } from '../../../lib/metadata';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{
    sort?: string | string[];
    rating?: string | string[];
    tag?: string | string[];
    vote?: string | string[];
  }>;
}

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const dynamicParams = true;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const resolvedParams = await params;
  const serverId = resolveServerRouteId(resolvedParams.id);
  const detail = await fetchServerDetail(serverId);
  if (!detail) {
    return createPageMetadata({
      title: '서버를 찾을 수 없습니다',
      description: '요청한 마인크래프트 서버 페이지를 찾을 수 없습니다.',
      path: `/servers/${resolvedParams.id}`,
      noIndex: true,
    });
  }

  const canonicalPath = buildServerPath(detail);

  return createPageMetadata({
    title: detail.name,
    description: detail.shortDescription,
    path: canonicalPath,
    imageTitle: detail.name,
    imageDescription: `${detail.joinHost} 서버 정보, 투표, 리뷰를 MineWiki에서 확인하세요.`,
    images: detail.bannerUrl
      ? [
          {
            url: detail.bannerUrl,
            width: 1200,
            height: 630,
            alt: `${detail.name} 배너`,
          },
        ]
      : undefined,
  });
}

export default async function ServerDetailPage({ params, searchParams }: PageProps) {
  const resolvedParams = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const toSingle = (value?: string | string[]) => (Array.isArray(value) ? value[0] : value);
  const sortParam = toSingle(resolvedSearchParams?.sort);
  const ratingParam = toSingle(resolvedSearchParams?.rating);
  const tagParam = toSingle(resolvedSearchParams?.tag);
  const voteParam = toSingle(resolvedSearchParams?.vote);
  const currentReviewSort: 'wilson' | 'newest' = sortParam === 'newest' ? 'newest' : 'wilson';
  const parsedRating = ratingParam ? Number.parseInt(ratingParam, 10) : Number.NaN;
  const currentReviewRating =
    Number.isInteger(parsedRating) && parsedRating >= 1 && parsedRating <= 5
      ? parsedRating
      : undefined;
  const currentReviewTag = tagParam?.trim() ? tagParam.trim() : undefined;
  const initialVoteOpen = voteParam === '1' || voteParam === 'true';
  const routeId = resolveServerRouteId(resolvedParams.id);

  const detail = await fetchServerDetail(routeId);
  if (!detail) {
    notFound();
  }

  const serverId = detail.id;
  const statsPromise = fetchServerStats(serverId);
  const updatesPromise = fetchServerUpdates(serverId, { limit: 12 }).catch((error) => {
    console.error('Failed to load server updates', error);
    return [];
  });
  const reviewsPromise = fetchServerReviews(serverId, {
    limit: 12,
    sort: currentReviewSort,
    rating: currentReviewRating,
    tag: currentReviewTag,
  });
  const referralsPromise = fetchServerReferrals(serverId);
  const recommendationsPromise = fetchServerSummaries({ sort: 'votes24h_desc' });

  const [stats, updates, reviews, referrals, recommendations] = await Promise.all([
    statsPromise,
    updatesPromise,
    reviewsPromise,
    referralsPromise,
    recommendationsPromise,
  ]);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;

  const averageRating =
    reviews.length > 0
      ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length
      : null;

  const recommendedServers = recommendations.filter((server) => server.id !== serverId).slice(0, 4);
  const canonicalPath = buildServerPath(detail);

  return (
    <>
      <ServerJsonLd
        detail={detail}
        stats={stats}
        averageRating={averageRating}
        path={canonicalPath}
        siteUrl={siteUrl}
      />
      <ServerDetailShowcase
        serverId={serverId}
        serverPath={canonicalPath}
        detail={detail}
        stats={stats}
        updates={updates}
        reviews={reviews}
        referrals={referrals}
        recommendations={recommendedServers}
        currentReviewSort={currentReviewSort}
        currentReviewRating={currentReviewRating}
        currentReviewTag={currentReviewTag}
        initialVoteOpen={initialVoteOpen}
      />
    </>
  );
}

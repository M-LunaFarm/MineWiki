'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReviewGateStatus as ApiReviewGateStatus, ServerReview } from '@minewiki/schemas';
import { ReviewList } from '../reviews/review-list';
import { ReviewGateHint } from '../reviews/review-gate-hint';
import { ServerReviewsHeader } from './server-reviews-header';
import { ServerReviewFilters } from './server-review-filters';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import { ReviewComposerModal } from '../reviews/review-composer-modal';

type ReviewGateStatus = ApiReviewGateStatus;

const EMPTY_STATUS: ReviewGateStatus = {
  isLoggedIn: false,
  isMinecraftOwned: false,
  hasRecentVote: false,
  lastVoteAt: null,
  nextEligibleVoteAt: null,
  displayName: null,
  minecraftUuid: null
};

interface ServerReviewSectionProps {
  readonly serverId: string;
  readonly serverPath?: string;
  readonly initialReviews: ServerReview[];
  readonly apiBaseUrl?: string;
  readonly trustLabelCopy: Record<string, string>;
  readonly initialReviewCount: number;
  readonly initialAverageRating: number | null;
  readonly availableTags: string[];
  readonly currentSort: 'wilson' | 'newest';
  readonly currentRating?: number;
  readonly currentTag?: string;
  readonly ratingOptions: Array<{ value: string; label: string }>;
  readonly sortOptions: Array<{ value: 'wilson' | 'newest'; label: string }>;
}

export function ServerReviewSection({
  serverId,
  serverPath,
  initialReviews,
  apiBaseUrl,
  trustLabelCopy,
  initialReviewCount,
  initialAverageRating,
  availableTags,
  currentSort,
  currentRating,
  currentTag,
  ratingOptions,
  sortOptions
}: ServerReviewSectionProps) {
  const [reviewCount, setReviewCount] = useState(initialReviewCount);
  const [averageRating, setAverageRating] = useState<number | null>(initialAverageRating);
  const [latestReview, setLatestReview] = useState<ServerReview | null>(null);
  const [tags, setTags] = useState(availableTags);
  const [gateStatus, setGateStatus] = useState<ReviewGateStatus>(EMPTY_STATUS);
  const [reviews, setReviews] = useState(initialReviews);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMoreReviews, setLoadingMoreReviews] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [isComposerOpen, setIsComposerOpen] = useState(false);

  const baseUrl = useMemo(() => normalizeApiBaseUrl(apiBaseUrl), [apiBaseUrl]);

  const refreshGateStatus = useCallback(async () => {
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${serverId}/reviews/gate`, {
        credentials: 'include'
      });
      if (!response.ok) {
        throw new Error('failed to fetch');
      }
      const payload = (await response.json()) as ApiReviewGateStatus;
      setGateStatus(payload);
    } catch {
      setGateStatus(EMPTY_STATUS);
    }
  }, [baseUrl, serverId]);

  useEffect(() => {
    void refreshGateStatus();
  }, [refreshGateStatus]);

  useEffect(() => {
    setReviews(initialReviews);
  }, [initialReviews]);

  useEffect(() => {
    setReviewCount(initialReviewCount);
    setAverageRating(initialAverageRating);
    setTags(availableTags);
  }, [initialReviewCount, initialAverageRating, availableTags]);

  const refreshOwnership = useCallback(async () => {
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${serverId}/ownership`, {
        credentials: 'include'
      });
      if (!response.ok) {
        setIsOwner(false);
        return;
      }
      const payload = (await response.json()) as { isOwner: boolean };
      setIsOwner(Boolean(payload?.isOwner));
    } catch (error) {
      console.warn('서버 소유자 확인 실패', error);
      setIsOwner(false);
    }
  }, [baseUrl, serverId]);

  useEffect(() => {
    void refreshOwnership();
  }, [refreshOwnership]);

  useEffect(() => {
    if (!isOwner) {
      return;
    }
    const loadStaffReviews = async () => {
      try {
        const response = await fetch(`${baseUrl}/v1/servers/${serverId}/reviews/staff`, {
          credentials: 'include'
        });
        if (!response.ok) {
          throw new Error('failed to load staff reviews');
        }
        const payload = (await response.json()) as ServerReview[];
        setReviews(payload);
        setNextCursor(null);
        setReviewCount(payload.length);
        if (payload.length > 0) {
          const average =
            payload.reduce((sum, review) => sum + review.rating, 0) / payload.length;
          setAverageRating(parseFloat(average.toFixed(2)));
          setTags((current) => {
            const next = new Set(current);
            payload.forEach((review) => review.tags.forEach((tag) => next.add(tag)));
            return Array.from(next).sort((a, b) => a.localeCompare(b));
          });
        }
      } catch (error) {
        console.warn('운영자 리뷰 로드 실패', error);
      }
    };
    void loadStaffReviews();
  }, [baseUrl, isOwner, serverId]);

  useEffect(() => {
    if (isOwner) {
      return;
    }
    const loadViewerReviews = async () => {
      try {
        const params = new URLSearchParams();
        params.set('sort', currentSort);
        if (currentRating && currentRating >= 1 && currentRating <= 5) {
          params.set('rating', String(currentRating));
        }
        if (currentTag?.trim()) {
          params.set('tag', currentTag.trim());
        }
        params.set('limit', String(Math.max(initialReviews.length, 12)));
        const response = await fetch(
          `${baseUrl}/v1/servers/${serverId}/reviews/page?${params.toString()}`,
          { credentials: 'include' }
        );
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as { items: ServerReview[]; nextCursor: string | null };
        setReviews(payload.items);
        setNextCursor(payload.nextCursor);
      } catch (error) {
        console.warn('뷰어 리뷰 로드 실패', error);
      }
    };
    void loadViewerReviews();
  }, [
    baseUrl,
    currentRating,
    currentSort,
    currentTag,
    initialReviews.length,
    isOwner,
    serverId
  ]);

  const tagOptions = useMemo(() => tags, [tags]);
  const ratingDistribution = useMemo(
    () =>
      reviews.reduce<Record<number, number>>((accumulator, review) => {
        accumulator[review.rating] = (accumulator[review.rating] ?? 0) + 1;
        return accumulator;
      }, {}),
    [reviews]
  );
  const canCompose =
    gateStatus.isLoggedIn && gateStatus.isMinecraftOwned && gateStatus.hasRecentVote;
  const composeLabel = gateStatus.isLoggedIn
    ? canCompose
      ? '리뷰 작성하기'
      : '조건 충족 필요'
    : '로그인 필요';
  const composerDisabled = !gateStatus.isLoggedIn || !canCompose;

  const handleOpenComposer = () => {
    if (!composerDisabled) {
      setIsComposerOpen(true);
    }
  };

  const handleCloseComposer = () => {
    setIsComposerOpen(false);
  };

  const handleReviewCreated = (review: ServerReview) => {
    setLatestReview(review);
    setReviews((current) => {
      if (current.some((item) => item.id === review.id)) {
        return current;
      }
      return [review, ...current];
    });
    setReviewCount((previousCount) => {
      const nextCount = previousCount + 1;
      setAverageRating((previousAverage) => {
        if (previousAverage === null) {
          return review.rating;
        }
        const updatedAverage = (previousAverage * previousCount + review.rating) / nextCount;
        return Number.isFinite(updatedAverage) ? parseFloat(updatedAverage.toFixed(2)) : review.rating;
      });
      return nextCount;
    });
    setTags((current) => {
      const next = new Set(current);
      review.tags.forEach((tag) => next.add(tag));
      return Array.from(next).sort((a, b) => a.localeCompare(b));
    });
  };

  const handleReviewUpdated = (nextReview: ServerReview) => {
    setReviews((current) => {
      const next = current.map((item) => (item.id === nextReview.id ? nextReview : item));
      const visibleAverage =
        next.length > 0
          ? next.reduce((sum, review) => sum + review.rating, 0) / next.length
          : null;
      setAverageRating(
        visibleAverage === null ? null : parseFloat(visibleAverage.toFixed(2))
      );
      setTags(() => {
        const unique = new Set<string>();
        next.forEach((review) => review.tags.forEach((tag) => unique.add(tag)));
        return Array.from(unique).sort((a, b) => a.localeCompare(b));
      });
      return next;
    });
  };

  const handleReviewDeleted = (deletedReview: ServerReview) => {
    setReviews((current) => {
      const next = current.filter((item) => item.id !== deletedReview.id);
      const visibleAverage =
        next.length > 0
          ? next.reduce((sum, review) => sum + review.rating, 0) / next.length
          : null;
      setAverageRating(
        visibleAverage === null ? null : parseFloat(visibleAverage.toFixed(2))
      );
      setReviewCount((previousCount) => Math.max(0, previousCount - 1));
      setTags(() => {
        const unique = new Set<string>();
        next.forEach((review) => review.tags.forEach((tag) => unique.add(tag)));
        return Array.from(unique).sort((a, b) => a.localeCompare(b));
      });
      return next;
    });
  };

  const loadMoreReviews = async () => {
    if (!nextCursor || loadingMoreReviews || isOwner) return;
    setLoadingMoreReviews(true);
    try {
      const params = new URLSearchParams({
        sort: currentSort,
        limit: String(Math.max(initialReviews.length, 12)),
        cursor: nextCursor
      });
      if (currentRating && currentRating >= 1 && currentRating <= 5) {
        params.set('rating', String(currentRating));
      }
      if (currentTag?.trim()) params.set('tag', currentTag.trim());
      const response = await fetch(
        `${baseUrl}/v1/servers/${serverId}/reviews/page?${params.toString()}`,
        { credentials: 'include' }
      );
      if (!response.ok) throw new Error('failed to load more reviews');
      const payload = (await response.json()) as { items: ServerReview[]; nextCursor: string | null };
      setReviews((current) => [
        ...current,
        ...payload.items.filter((review) => !current.some((item) => item.id === review.id))
      ]);
      setNextCursor(payload.nextCursor);
    } catch (error) {
      console.warn('추가 리뷰 로드 실패', error);
    } finally {
      setLoadingMoreReviews(false);
    }
  };

  return (
    <section className="rounded-xl border border-[#30343b] bg-[#151922] p-6 md:p-8">
      <ServerReviewsHeader
        reviewCount={reviewCount}
        averageRating={averageRating}
        ratingDistribution={ratingDistribution}
        composeLabel={composeLabel}
        composeDisabled={composerDisabled}
        onCompose={handleOpenComposer}
      />
      <ReviewGateHint
        status={gateStatus}
        onRefresh={refreshGateStatus}
        returnTo={serverPath ?? `/servers/${serverId}`}
      />
      <ServerReviewFilters
        serverId={serverId}
        serverPath={serverPath}
        sortOptions={sortOptions}
        ratingOptions={ratingOptions}
        availableTags={tagOptions}
        currentSort={currentSort}
        currentRating={currentRating}
        currentTag={currentTag}
      />
      <ReviewList
        serverId={serverId}
        initialReviews={reviews}
        apiBaseUrl={baseUrl}
        trustLabelCopy={trustLabelCopy}
        newReview={latestReview}
        isOwner={isOwner}
        onReviewUpdated={handleReviewUpdated}
        onReviewDeleted={handleReviewDeleted}
      />
      {nextCursor && !isOwner ? (
        <button
          type="button"
          disabled={loadingMoreReviews}
          onClick={() => void loadMoreReviews()}
          className="btn-secondary mt-6 min-h-11 w-full"
        >
          {loadingMoreReviews ? '리뷰 불러오는 중…' : '리뷰 더 보기'}
        </button>
      ) : null}
      <ReviewComposerModal
        open={isComposerOpen}
        serverId={serverId}
        apiBaseUrl={baseUrl}
        gateStatus={gateStatus}
        onSubmitted={handleReviewCreated}
        onGateStatusRefresh={refreshGateStatus}
        onClose={handleCloseComposer}
      />
    </section>
  );
}

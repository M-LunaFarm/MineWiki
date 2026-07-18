'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ReviewGateStatus as ApiReviewGateStatus,
  ServerReview,
  ServerReviewAggregate,
  ServerReviewPage,
} from '@minewiki/schemas';
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
  readonly initialAggregate: ServerReviewAggregate;
  readonly initialNextCursor: string | null;
  readonly apiBaseUrl?: string;
  readonly trustLabelCopy: Record<string, string>;
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
  initialAggregate,
  initialNextCursor,
  apiBaseUrl,
  trustLabelCopy,
  availableTags,
  currentSort,
  currentRating,
  currentTag,
  ratingOptions,
  sortOptions
}: ServerReviewSectionProps) {
  const [aggregate, setAggregate] = useState(initialAggregate);
  const [latestReview, setLatestReview] = useState<ServerReview | null>(null);
  const [tags, setTags] = useState(availableTags);
  const [gateStatus, setGateStatus] = useState<ReviewGateStatus>(EMPTY_STATUS);
  const [reviews, setReviews] = useState(initialReviews);
  const [viewerReceipts, setViewerReceipts] = useState<ServerReview[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
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
    setAggregate(initialAggregate);
    setNextCursor(initialNextCursor);
    setTags(availableTags);
  }, [initialAggregate, initialNextCursor, availableTags]);

  const refreshPublicAggregate = useCallback(async () => {
    try {
      const response = await fetch(
        `${baseUrl}/v1/servers/${serverId}/reviews/page?limit=1`,
        { credentials: 'include' }
      );
      if (!response.ok) return;
      const payload = (await response.json()) as ServerReviewPage;
      setAggregate(payload.aggregate);
    } catch (error) {
      console.warn('공개 리뷰 집계 새로고침 실패', error);
    }
  }, [baseUrl, serverId]);

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
        if (payload.length > 0) {
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
    if (!gateStatus.isLoggedIn || isOwner) {
      setViewerReceipts([]);
      return;
    }
    let cancelled = false;
    const loadViewerReceipts = async () => {
      try {
        const response = await fetch(`${baseUrl}/v1/servers/${serverId}/reviews/mine`, {
          credentials: 'include',
        });
        if (!response.ok) return;
        const payload = (await response.json()) as ServerReview[];
        if (!cancelled) setViewerReceipts(payload);
      } catch (error) {
        console.warn('내 리뷰 영수증 로드 실패', error);
      }
    };
    void loadViewerReceipts();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, gateStatus.isLoggedIn, isOwner, serverId]);

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
        const payload = (await response.json()) as ServerReviewPage;
        setReviews(payload.items);
        setNextCursor(payload.nextCursor);
        setAggregate(payload.aggregate);
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
  const ratingDistribution = useMemo<Record<number, number>>(() => ({
    1: aggregate.histogram['1'],
    2: aggregate.histogram['2'],
    3: aggregate.histogram['3'],
    4: aggregate.histogram['4'],
    5: aggregate.histogram['5'],
  }), [aggregate.histogram]);
  const displayedReviews = useMemo(() => {
    const privateReceipts = viewerReceipts.filter((review) => review.visibility === 'staff');
    const byId = new Map(privateReceipts.map((review) => [review.id, review]));
    for (const review of reviews) {
      byId.set(review.id, review);
    }
    return [...byId.values()];
  }, [reviews, viewerReceipts]);
  const privateReceiptCount = viewerReceipts.filter(
    (review) => review.visibility === 'staff',
  ).length;
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
    setViewerReceipts((current) => [review, ...current.filter((item) => item.id !== review.id)]);
    void refreshPublicAggregate();
    setTags((current) => {
      const next = new Set(current);
      review.tags.forEach((tag) => next.add(tag));
      return Array.from(next).sort((a, b) => a.localeCompare(b));
    });
  };

  const handleReviewUpdated = (nextReview: ServerReview) => {
    setReviews((current) => {
      const next = current.map((item) => (item.id === nextReview.id ? nextReview : item));
      setTags(() => {
        const unique = new Set<string>();
        next.forEach((review) => review.tags.forEach((tag) => unique.add(tag)));
        return Array.from(unique).sort((a, b) => a.localeCompare(b));
      });
      return next;
    });
    setViewerReceipts((current) =>
      current.map((item) => (item.id === nextReview.id ? nextReview : item)),
    );
    void refreshPublicAggregate();
  };

  const handleReviewDeleted = (deletedReview: ServerReview) => {
    setReviews((current) => {
      const next = current.filter((item) => item.id !== deletedReview.id);
      setTags(() => {
        const unique = new Set<string>();
        next.forEach((review) => review.tags.forEach((tag) => unique.add(tag)));
        return Array.from(unique).sort((a, b) => a.localeCompare(b));
      });
      return next;
    });
    setViewerReceipts((current) => current.filter((item) => item.id !== deletedReview.id));
    void refreshPublicAggregate();
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
      const payload = (await response.json()) as ServerReviewPage;
      setReviews((current) => [
        ...current,
        ...payload.items.filter((review) => !current.some((item) => item.id === review.id))
      ]);
      setNextCursor(payload.nextCursor);
      setAggregate(payload.aggregate);
    } catch (error) {
      console.warn('추가 리뷰 로드 실패', error);
    } finally {
      setLoadingMoreReviews(false);
    }
  };

  return (
    <section className="rounded-xl border border-[#30343b] bg-[#151922] p-6 md:p-8">
      <ServerReviewsHeader
        reviewCount={aggregate.total}
        averageRating={aggregate.average}
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
      {privateReceiptCount > 0 ? (
        <p className="mb-4 rounded-lg border border-sky-300/20 bg-sky-300/5 px-4 py-3 text-sm text-sky-100">
          운영진에게만 보낸 내 리뷰 {privateReceiptCount.toLocaleString('ko-KR')}개도 함께 표시합니다.
        </p>
      ) : null}
      <ReviewList
        serverId={serverId}
        initialReviews={displayedReviews}
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

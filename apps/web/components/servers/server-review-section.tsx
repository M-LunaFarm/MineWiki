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
import { fetchReviewFeedPage } from '../../lib/review-feed-client';

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
  const [viewerReceiptsTotal, setViewerReceiptsTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [staffNextCursor, setStaffNextCursor] = useState<string | null>(null);
  const [viewerReceiptsNextCursor, setViewerReceiptsNextCursor] = useState<string | null>(null);
  const [loadingMoreReviews, setLoadingMoreReviews] = useState(false);
  const [loadingMoreReceipts, setLoadingMoreReceipts] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [feedRevision, setFeedRevision] = useState(0);

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
      const owner = Boolean(payload?.isOwner);
      setIsOwner(owner);
      if (!owner) setStaffNextCursor(null);
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
    let cancelled = false;
    const loadStaffReviews = async () => {
      try {
        const payload = await fetchReviewFeedPage({
          baseUrl,
          serverId,
          scope: 'staff',
          sort: currentSort,
          rating: currentRating,
          tag: currentTag,
          visibility: 'all',
        });
        if (cancelled) return;
        setReviews(payload.items);
        setStaffNextCursor(payload.nextCursor);
        setAggregate(payload.aggregate);
        if (payload.items.length > 0) {
          setTags((current) => {
            const next = new Set(current);
            payload.items.forEach((review) => review.tags.forEach((tag) => next.add(tag)));
            return Array.from(next).sort((a, b) => a.localeCompare(b));
          });
        }
      } catch (error) {
        console.warn('운영자 리뷰 로드 실패', error);
      }
    };
    void loadStaffReviews();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, currentRating, currentSort, currentTag, feedRevision, isOwner, serverId]);

  useEffect(() => {
    if (!gateStatus.isLoggedIn || isOwner) {
      setViewerReceipts([]);
      setViewerReceiptsTotal(0);
      setViewerReceiptsNextCursor(null);
      return;
    }
    let cancelled = false;
    const loadViewerReceipts = async () => {
      try {
        const payload = await fetchReviewFeedPage({
          baseUrl,
          serverId,
          scope: 'mine',
          visibility: 'staff',
          sort: 'newest',
        });
        if (!cancelled) {
          setViewerReceipts(payload.items);
          setViewerReceiptsNextCursor(payload.nextCursor);
          setViewerReceiptsTotal(payload.aggregate.total);
        }
      } catch (error) {
        console.warn('내 리뷰 영수증 로드 실패', error);
      }
    };
    void loadViewerReceipts();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, feedRevision, gateStatus.isLoggedIn, isOwner, serverId]);

  useEffect(() => {
    if (isOwner) {
      return;
    }
    let cancelled = false;
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
        if (cancelled) return;
        setReviews(payload.items);
        setNextCursor(payload.nextCursor);
        setAggregate(payload.aggregate);
      } catch (error) {
        console.warn('뷰어 리뷰 로드 실패', error);
      }
    };
    void loadViewerReviews();
    return () => {
      cancelled = true;
    };
  }, [
    baseUrl,
    currentRating,
    currentSort,
    currentTag,
    initialReviews.length,
    feedRevision,
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
  const privateReceiptCount = viewerReceiptsTotal;
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
    if (review.visibility === 'staff') {
      setViewerReceipts((current) => [review, ...current.filter((item) => item.id !== review.id)]);
      setViewerReceiptsTotal((current) => current + 1);
    }
    setFeedRevision((current) => current + 1);
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
    setFeedRevision((current) => current + 1);
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
    if (deletedReview.visibility === 'staff') {
      setViewerReceiptsTotal((current) => Math.max(0, current - 1));
    }
    void refreshPublicAggregate();
    setFeedRevision((current) => current + 1);
  };

  const loadMoreReviews = async () => {
    const cursor = isOwner ? staffNextCursor : nextCursor;
    if (!cursor || loadingMoreReviews) return;
    setLoadingMoreReviews(true);
    try {
      if (isOwner) {
        const payload = await fetchReviewFeedPage({
          baseUrl,
          serverId,
          scope: 'staff',
          limit: 20,
          cursor,
          sort: currentSort,
          visibility: 'all',
          rating: currentRating,
          tag: currentTag,
        });
        setReviews((current) => appendUniqueReviews(current, payload.items));
        setStaffNextCursor(payload.nextCursor);
        return;
      }
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
      setReviews((current) => appendUniqueReviews(current, payload.items));
      setNextCursor(payload.nextCursor);
      setAggregate(payload.aggregate);
    } catch (error) {
      console.warn('추가 리뷰 로드 실패', error);
    } finally {
      setLoadingMoreReviews(false);
    }
  };

  const loadMoreViewerReceipts = async () => {
    if (!viewerReceiptsNextCursor || loadingMoreReceipts || isOwner) return;
    setLoadingMoreReceipts(true);
    try {
      const payload = await fetchReviewFeedPage({
        baseUrl,
        serverId,
        scope: 'mine',
        limit: 20,
        cursor: viewerReceiptsNextCursor,
        visibility: 'staff',
        sort: 'newest',
      });
      setViewerReceipts((current) => appendUniqueReviews(current, payload.items));
      setViewerReceiptsNextCursor(payload.nextCursor);
    } catch (error) {
      console.warn('내 리뷰 영수증 추가 로드 실패', error);
    } finally {
      setLoadingMoreReceipts(false);
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
      {isOwner ? (
        <p className="mb-4 rounded-lg border border-amber-300/20 bg-amber-300/5 px-4 py-3 text-sm text-amber-100">
          운영자 보기: 공개 리뷰와 운영진 전용 리뷰를 함께 집계합니다.
        </p>
      ) : null}
      {privateReceiptCount > 0 ? (
        <div className="mb-6 rounded-lg border border-sky-300/20 bg-sky-300/5 px-4 py-4 text-sm text-sky-100">
          <p>운영진에게만 보낸 내 리뷰 {privateReceiptCount.toLocaleString('ko-KR')}개도 함께 표시합니다.</p>
          <div className="mt-3">
            <ReviewList
              serverId={serverId}
              initialReviews={viewerReceipts}
              apiBaseUrl={baseUrl}
              trustLabelCopy={trustLabelCopy}
              isOwner={false}
              isLoggedIn={gateStatus.isLoggedIn}
              loginHref={`/login?returnTo=${encodeURIComponent(`${serverPath ?? `/servers/${serverId}`}#reviews`)}`}
              onReviewUpdated={handleReviewUpdated}
              onReviewDeleted={handleReviewDeleted}
            />
          </div>
          {viewerReceiptsNextCursor ? (
            <button type="button" disabled={loadingMoreReceipts} onClick={() => void loadMoreViewerReceipts()} className="mt-2 text-xs font-semibold text-sky-200 underline underline-offset-4 disabled:opacity-50">
              {loadingMoreReceipts ? '내 리뷰 불러오는 중…' : '이전 내 리뷰 더 보기'}
            </button>
          ) : null}
        </div>
      ) : null}
      <ReviewList
        serverId={serverId}
        initialReviews={reviews}
        apiBaseUrl={baseUrl}
        trustLabelCopy={trustLabelCopy}
        newReview={latestReview}
        isOwner={isOwner}
        isLoggedIn={gateStatus.isLoggedIn}
        loginHref={`/login?returnTo=${encodeURIComponent(`${serverPath ?? `/servers/${serverId}`}#reviews`)}`}
        onReviewUpdated={handleReviewUpdated}
        onReviewDeleted={handleReviewDeleted}
      />
      {(isOwner ? staffNextCursor : nextCursor) ? (
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

function appendUniqueReviews(current: ServerReview[], incoming: ServerReview[]): ServerReview[] {
  const known = new Set(current.map((review) => review.id));
  return [...current, ...incoming.filter((review) => !known.has(review.id))];
}

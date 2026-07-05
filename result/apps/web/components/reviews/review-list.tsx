'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ServerReview } from '@minewiki/schemas';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';

interface ReviewListProps {
  readonly serverId: string;
  readonly initialReviews: ServerReview[];
  readonly apiBaseUrl?: string;
  readonly trustLabelCopy?: Record<string, string>;
  readonly newReview?: ServerReview | null;
  readonly isOwner?: boolean;
  readonly onReviewUpdated?: (nextReview: ServerReview, previousReview: ServerReview) => void;
  readonly onReviewDeleted?: (deletedReview: ServerReview) => void;
}

type HelpfulState = Record<string, boolean>;
type ReviewTag = ServerReview['tags'][number];

interface ReviewEditDraft {
  readonly rating: number;
  readonly body: string;
  readonly tags: ReviewTag[];
}

const HELPFUL_VOTES_KEY = 'minewiki_helpful_votes';
const MAX_BODY_LENGTH = 80;
const MAX_TAGS = 3;

const TAG_LABELS: Record<ReviewTag, string> = {
  performance: '성능',
  community: '커뮤니티',
  staff: '운영진',
  stability: '안정성',
  content: '콘텐츠',
  economy: '경제',
};

function loadHelpfulState(): HelpfulState {
  if (typeof window === 'undefined') {
    return {};
  }
  const raw = window.localStorage.getItem(HELPFUL_VOTES_KEY);
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as HelpfulState;
  } catch (error) {
    console.warn('Failed to parse helpful votes cache', error);
    return {};
  }
}

function persistHelpfulState(state: HelpfulState): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(HELPFUL_VOTES_KEY, JSON.stringify(state));
}

function createEditDraft(review: ServerReview): ReviewEditDraft {
  return {
    rating: review.rating,
    body: review.body,
    tags: [...review.tags],
  };
}

export function ReviewList({
  serverId,
  initialReviews,
  apiBaseUrl,
  trustLabelCopy,
  newReview,
  isOwner = false,
  onReviewUpdated,
  onReviewDeleted,
}: ReviewListProps) {
  const [reviews, setReviews] = useState(initialReviews);
  const [userHelpful, setUserHelpful] = useState<HelpfulState>({});
  const [pending, setPending] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [replyEditing, setReplyEditing] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replySubmitting, setReplySubmitting] = useState<string | null>(null);
  const [editingReviewId, setEditingReviewId] = useState<string | null>(null);
  const [editDrafts, setEditDrafts] = useState<Record<string, ReviewEditDraft>>({});
  const [editSubmitting, setEditSubmitting] = useState<string | null>(null);
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});
  const [deletePending, setDeletePending] = useState<string | null>(null);
  const initialLength = initialReviews.length || 10;

  useEffect(() => {
    setReviews(initialReviews);
  }, [initialReviews]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const cached = loadHelpfulState();
    setUserHelpful(cached);
  }, []);

  useEffect(() => {
    if (!newReview) {
      return;
    }
    setReviews((current) => {
      if (current.some((review) => review.id === newReview.id)) {
        return current;
      }
      const next = [newReview, ...current];
      if (next.length > initialLength) {
        return next.slice(0, initialLength);
      }
      return next;
    });
  }, [initialLength, newReview]);

  const baseUrl = useMemo(() => normalizeApiBaseUrl(apiBaseUrl), [apiBaseUrl]);

  const helpfulCountByReview = useMemo(() => {
    const map = new Map<string, number>();
    reviews.forEach((review) => {
      map.set(review.id, review.helpfulCount);
    });
    return map;
  }, [reviews]);

  const handleReport = async (reviewId: string) => {
    if (reporting === reviewId) {
      return;
    }
    setReporting(reviewId);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${serverId}/reviews/${reviewId}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(`API responded with ${response.status}`);
      }
      const data = (await response.json()) as ServerReview;
      setReviews((current) => current.map((item) => (item.id === reviewId ? data : item)));
    } catch (error) {
      console.warn('리뷰 신고에 실패했습니다.', error);
    } finally {
      setReporting(null);
    }
  };

  const handleReplySubmit = async (reviewId: string) => {
    if (replySubmitting === reviewId) {
      return;
    }
    const draft = replyDrafts[reviewId]?.trim() ?? '';
    setReplySubmitting(reviewId);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${serverId}/reviews/${reviewId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ body: draft }),
      });
      if (!response.ok) {
        throw new Error(`API responded with ${response.status}`);
      }
      const data = (await response.json()) as ServerReview;
      setReviews((current) => current.map((item) => (item.id === reviewId ? data : item)));
      setReplyEditing(null);
      setReplyDrafts((current) => ({ ...current, [reviewId]: '' }));
    } catch (error) {
      console.warn('관리자 답글 등록에 실패했습니다.', error);
    } finally {
      setReplySubmitting(null);
    }
  };

  const handleToggleHelpful = async (reviewId: string) => {
    if (pending === reviewId) {
      return;
    }
    const alreadyHelpful = userHelpful[reviewId] ?? false;
    const nextHelpful = !alreadyHelpful;
    const previousReview = reviews.find((review) => review.id === reviewId);
    const hadHelpfulEntry = Object.prototype.hasOwnProperty.call(userHelpful, reviewId);

    setPending(reviewId);

    const applyLocalUpdate = (helpful: boolean) => {
      setReviews((current) =>
        current.map((review) => {
          if (review.id !== reviewId) {
            return review;
          }
          const delta = helpful ? (alreadyHelpful ? 0 : 1) : alreadyHelpful ? -1 : 0;
          return {
            ...review,
            helpfulCount: Math.max(0, review.helpfulCount + delta),
          };
        }),
      );
      setUserHelpful((current) => {
        const next = { ...current, [reviewId]: helpful };
        persistHelpfulState(next);
        return next;
      });
    };

    const revertLocalUpdate = () => {
      if (previousReview) {
        setReviews((current) =>
          current.map((review) => (review.id === reviewId ? previousReview : review)),
        );
      }
      setUserHelpful((current) => {
        const next = { ...current };
        if (hadHelpfulEntry) {
          next[reviewId] = alreadyHelpful;
        } else {
          delete next[reviewId];
        }
        persistHelpfulState(next);
        return next;
      });
    };

    applyLocalUpdate(nextHelpful);

    try {
      const response = await fetch(
        `${baseUrl}/v1/servers/${serverId}/reviews/${reviewId}/helpful`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({ isHelpful: nextHelpful }),
        },
      );
      if (!response.ok) {
        throw new Error(`API responded with ${response.status}`);
      }
      const data = (await response.json()) as ServerReview;
      setReviews((current) => current.map((review) => (review.id === reviewId ? data : review)));
    } catch (error) {
      console.warn('도움돼요 업데이트 실패', error);
      revertLocalUpdate();
    } finally {
      setPending(null);
    }
  };

  const handleStartEditing = (review: ServerReview) => {
    setEditErrors((current) => {
      const next = { ...current };
      delete next[review.id];
      return next;
    });
    setEditingReviewId(review.id);
    setEditDrafts((current) => ({
      ...current,
      [review.id]: current[review.id] ?? createEditDraft(review),
    }));
  };

  const handleToggleEditTag = (reviewId: string, tag: ReviewTag) => {
    setEditDrafts((current) => {
      const draft = current[reviewId];
      if (!draft) {
        return current;
      }
      const exists = draft.tags.includes(tag);
      const nextTags = exists
        ? draft.tags.filter((item) => item !== tag)
        : draft.tags.length >= MAX_TAGS
          ? draft.tags
          : [...draft.tags, tag];
      return {
        ...current,
        [reviewId]: {
          ...draft,
          tags: nextTags,
        },
      };
    });
  };

  const handleEditSubmit = async (review: ServerReview) => {
    if (editSubmitting === review.id) {
      return;
    }
    const draft = editDrafts[review.id] ?? createEditDraft(review);
    const trimmedBody = draft.body.trim();
    if (!trimmedBody) {
      setEditErrors((current) => ({
        ...current,
        [review.id]: '리뷰 내용을 입력해주세요.',
      }));
      return;
    }

    setEditSubmitting(review.id);
    setEditErrors((current) => {
      const next = { ...current };
      delete next[review.id];
      return next;
    });

    try {
      const response = await fetch(`${baseUrl}/v1/servers/${serverId}/reviews/${review.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          rating: draft.rating,
          body: trimmedBody.slice(0, MAX_BODY_LENGTH),
          tags: draft.tags,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const message = (payload?.message as string) ?? '리뷰 수정 중 오류가 발생했습니다.';
        throw new Error(message);
      }
      const updated = (await response.json()) as ServerReview;
      setReviews((current) => current.map((item) => (item.id === review.id ? updated : item)));
      onReviewUpdated?.(updated, review);
      setEditingReviewId(null);
    } catch (error) {
      setEditErrors((current) => ({
        ...current,
        [review.id]: error instanceof Error ? error.message : '리뷰 수정에 실패했습니다.',
      }));
    } finally {
      setEditSubmitting(null);
    }
  };

  const handleDelete = async (review: ServerReview) => {
    if (deletePending === review.id) {
      return;
    }
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm('이 리뷰를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.');
      if (!confirmed) {
        return;
      }
    }

    setDeletePending(review.id);
    setEditErrors((current) => {
      const next = { ...current };
      delete next[review.id];
      return next;
    });

    try {
      const response = await fetch(`${baseUrl}/v1/servers/${serverId}/reviews/${review.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const message = (payload?.message as string) ?? '리뷰 삭제에 실패했습니다.';
        throw new Error(message);
      }
      setReviews((current) => current.filter((item) => item.id !== review.id));
      onReviewDeleted?.(review);
      if (editingReviewId === review.id) {
        setEditingReviewId(null);
      }
    } catch (error) {
      setEditErrors((current) => ({
        ...current,
        [review.id]: error instanceof Error ? error.message : '리뷰 삭제에 실패했습니다.',
      }));
    } finally {
      setDeletePending(null);
    }
  };

  return (
    <div className="mt-6 space-y-4">
      {reviews.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[#30343b] bg-[#101216] p-5 text-sm text-[#9ca3af]">
          조건에 맞는 리뷰가 없습니다. 필터를 변경하거나 잠시 후 다시 시도해주세요.
        </p>
      ) : (
        reviews.map((review) => {
          const helpfulCount = helpfulCountByReview.get(review.id) ?? review.helpfulCount;
          const isHelpful = userHelpful[review.id] ?? false;
          const buttonLabel = isHelpful ? '도움돼요 취소' : '도움돼요';
          const showStaffBadge = review.visibility === 'staff';
          const canManage = review.canManage === true;
          const isEditing = editingReviewId === review.id;
          const draft = editDrafts[review.id] ?? createEditDraft(review);

          return (
            <article
              key={review.id}
              className="rounded-xl border border-[#30343b] bg-[#101216] p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-white">{review.authorDisplayName}</p>
                    {showStaffBadge ? (
                      <span className="rounded-full border border-blue-400/40 bg-blue-500/10 px-2 py-[2px] text-[10px] font-semibold text-blue-100">
                        운영진 전용
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs text-[#9ca3af]">
                    {new Date(review.createdAt).toLocaleDateString('ko-KR')}
                  </p>
                </div>
                <p className="rounded-md border border-amber-300/20 bg-amber-300/10 px-2.5 py-1 text-sm font-semibold text-amber-100">
                  {'★'.repeat(review.rating)}
                  {'☆'.repeat(Math.max(0, 5 - review.rating))}
                </p>
              </div>

              {isEditing ? (
                <div className="mt-4 space-y-3 rounded-xl border border-[#30343b] bg-[#151922] p-3">
                  <div className="flex flex-wrap gap-2">
                    {[1, 2, 3, 4, 5].map((value) => (
                      <button
                        key={`${review.id}-rating-${value}`}
                        type="button"
                        className={`rounded-lg border px-3 py-1 text-xs font-semibold ${
                          draft.rating === value
                            ? 'border-amber-300 bg-amber-300/10 text-amber-100'
                            : 'border-[#30343b] text-slate-200 hover:bg-[#202632]'
                        }`}
                        onClick={() =>
                          setEditDrafts((current) => ({
                            ...current,
                            [review.id]: {
                              ...draft,
                              rating: value,
                            },
                          }))
                        }
                      >
                        {value}점
                      </button>
                    ))}
                  </div>

                  <textarea
                    className="w-full rounded-lg border border-[#30343b] bg-[#0d0f13] px-3 py-2 text-sm text-white"
                    rows={3}
                    value={draft.body}
                    maxLength={MAX_BODY_LENGTH}
                    onChange={(event) =>
                      setEditDrafts((current) => ({
                        ...current,
                        [review.id]: {
                          ...draft,
                          body: event.target.value.slice(0, MAX_BODY_LENGTH),
                        },
                      }))
                    }
                    placeholder="리뷰 내용을 입력하세요."
                  />

                  <div className="flex flex-wrap gap-2">
                    {(Object.keys(TAG_LABELS) as ReviewTag[]).map((tag) => {
                      const selected = draft.tags.includes(tag);
                      return (
                        <button
                          key={`${review.id}-tag-${tag}`}
                          type="button"
                          className={`rounded-lg border px-3 py-1 text-xs ${
                            selected
                              ? 'border-blue-400 bg-blue-500/10 text-blue-100'
                              : 'border-[#30343b] text-slate-300 hover:bg-[#202632]'
                          }`}
                          onClick={() => handleToggleEditTag(review.id, tag)}
                        >
                          #{TAG_LABELS[tag]}
                        </button>
                      );
                    })}
                  </div>

                  {editErrors[review.id] ? (
                    <p className="text-xs text-rose-300">{editErrors[review.id]}</p>
                  ) : null}

                  <div className="flex justify-end gap-2 text-xs">
                    <button
                      type="button"
                      className="rounded-md border border-[#30343b] px-3 py-1 text-slate-200 hover:bg-[#202632]"
                      onClick={() => setEditingReviewId(null)}
                    >
                      취소
                    </button>
                    <button
                      type="button"
                      className="rounded-md bg-[#f5f7fb] px-3 py-1 font-semibold text-[#111827] hover:bg-white disabled:opacity-60"
                      onClick={() => void handleEditSubmit(review)}
                      disabled={editSubmitting === review.id}
                    >
                      {editSubmitting === review.id ? '저장 중…' : '수정 저장'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="mt-3 text-sm text-[#d1d5db]">{review.body}</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-[#9ca3af]">
                    {review.tags.map((tag) => (
                      <span
                        key={`${review.id}-tag-${tag}`}
                        className="rounded-full border border-[#30343b] bg-[#151922] px-3 py-1"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                </>
              )}

              <div className="mt-4 flex flex-wrap gap-2 text-xs text-blue-100">
                {review.trustLabels.map((label) => (
                  <span
                    key={`${review.id}-trust-${label}`}
                    className="rounded-full border border-blue-400/30 bg-blue-500/10 px-3 py-1"
                  >
                    {trustLabelCopy?.[label] ?? label}
                  </span>
                ))}
              </div>

              {review.adminReply ? (
                <div className="mt-4 space-y-2 rounded-xl border border-blue-400/30 bg-blue-500/10 p-3 text-xs text-[#d1d5db]">
                  <div className="flex items-center justify-between text-[11px] text-blue-100">
                    <span>{review.adminReply.authorDisplayName}</span>
                    <span>{new Date(review.adminReply.createdAt).toLocaleString('ko-KR')}</span>
                  </div>
                  <p className="whitespace-pre-line text-sm text-white">{review.adminReply.body}</p>
                </div>
              ) : null}

              {editErrors[review.id] && !isEditing ? (
                <p className="mt-3 text-xs text-rose-300">{editErrors[review.id]}</p>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[#9ca3af]">
                <span className="flex items-center gap-2">
                  <span>도움돼요 {helpfulCount.toLocaleString('ko-KR')}회</span>
                  {review.reports > 0 ? (
                    <span className="rounded-full border border-rose-400/40 bg-rose-500/10 px-2 py-[2px] text-[10px] font-semibold text-rose-200">
                      신고 {review.reports}
                    </span>
                  ) : null}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded-full border border-[#30343b] px-3 py-1 text-xs font-semibold text-white hover:bg-[#202632] disabled:opacity-60"
                    onClick={() => void handleToggleHelpful(review.id)}
                    disabled={pending === review.id}
                  >
                    {buttonLabel}
                  </button>
                  <button
                    type="button"
                    className="rounded-full border border-rose-500/40 px-3 py-1 text-xs font-semibold text-rose-200 hover:bg-rose-500/10 disabled:opacity-60"
                    onClick={() => void handleReport(review.id)}
                    disabled={reporting === review.id}
                  >
                    신고
                  </button>
                  {canManage ? (
                    <>
                      <button
                        type="button"
                        className="rounded-full border border-blue-400/40 px-3 py-1 text-xs font-semibold text-blue-100 hover:bg-blue-500/10 disabled:opacity-60"
                        onClick={() => handleStartEditing(review)}
                        disabled={isEditing}
                      >
                        수정
                      </button>
                      <button
                        type="button"
                        className="rounded-full border border-rose-500/50 px-3 py-1 text-xs font-semibold text-rose-200 hover:bg-rose-500/10 disabled:opacity-60"
                        onClick={() => void handleDelete(review)}
                        disabled={deletePending === review.id}
                      >
                        {deletePending === review.id ? '삭제 중…' : '삭제'}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>

              {isOwner ? (
                <div className="mt-3 space-y-2">
                  <button
                    type="button"
                    className="rounded-md border border-blue-400/40 px-3 py-1 text-xs font-semibold text-blue-100 hover:bg-blue-500/10"
                    onClick={() =>
                      setReplyEditing((current) => (current === review.id ? null : review.id))
                    }
                  >
                    {replyEditing === review.id ? '답글 취소' : '운영진 답글 작성'}
                  </button>
                  {replyEditing === review.id ? (
                    <div className="space-y-2">
                      <textarea
                        className="w-full rounded-lg border border-[#30343b] bg-[#151922] px-3 py-2 text-sm text-white"
                        rows={3}
                        value={replyDrafts[review.id] ?? review.adminReply?.body ?? ''}
                        onChange={(event) =>
                          setReplyDrafts((current) => ({
                            ...current,
                            [review.id]: event.target.value,
                          }))
                        }
                        placeholder="운영진 답글을 입력하세요 (비워두면 삭제됩니다)."
                      />
                      <div className="flex justify-end gap-2 text-xs">
                        <button
                          type="button"
                          className="rounded-md border border-[#30343b] px-3 py-1 text-[#d1d5db] hover:bg-[#202632]"
                          onClick={() => setReplyEditing(null)}
                        >
                          취소
                        </button>
                        <button
                          type="button"
                          className="rounded-md bg-[#f5f7fb] px-3 py-1 font-semibold text-[#111827] hover:bg-white disabled:opacity-60"
                          onClick={() => void handleReplySubmit(review.id)}
                          disabled={replySubmitting === review.id}
                        >
                          {replySubmitting === review.id ? '저장 중…' : '저장'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })
      )}
    </div>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@minewiki/ui';
import type { ServerReview, ReviewGateStatus } from '@minewiki/schemas';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import { csrfHeaders } from '../../lib/csrf';

type ReviewTag = 'performance' | 'community' | 'staff' | 'stability' | 'content' | 'economy';

interface ReviewComposerProps {
  readonly serverId: string;
  readonly apiBaseUrl?: string;
  readonly gateStatus: ReviewGateStatus;
  readonly onSubmitted?: (review: ServerReview) => void;
  readonly onGateStatusRefresh?: () => void;
  readonly onClose?: () => void;
}

const TAG_LABELS: Record<ReviewTag, string> = {
  performance: '성능',
  community: '커뮤니티',
  staff: '운영진',
  stability: '안정성',
  content: '콘텐츠',
  economy: '경제'
};

const MAX_BODY_LENGTH = 80;
const MAX_TAGS = 3;

export function ReviewComposer({
  serverId,
  apiBaseUrl,
  gateStatus,
  onSubmitted,
  onGateStatusRefresh,
  onClose
}: ReviewComposerProps) {
  const router = useRouter();
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState('');
  const [selectedTags, setSelectedTags] = useState<ReviewTag[]>([]);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [visibility, setVisibility] = useState<'public' | 'staff'>('public');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const baseUrl = useMemo(() => normalizeApiBaseUrl(apiBaseUrl), [apiBaseUrl]);

  const canSubmit =
    gateStatus.isLoggedIn && gateStatus.isMinecraftOwned && gateStatus.hasRecentVote;

  const toggleTag = (tag: ReviewTag) => {
    setSelectedTags((current) => {
      if (current.includes(tag)) {
        return current.filter((item) => item !== tag);
      }
      if (current.length >= MAX_TAGS) {
        return current;
      }
      return [...current, tag];
    });
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (!canSubmit) {
      setError('리뷰 작성 조건이 충족되지 않았습니다.');
      return;
    }
    if (!body.trim()) {
      setError('리뷰 내용을 입력해주세요.');
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${serverId}/reviews`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(await csrfHeaders())
        },
        credentials: 'include',
        body: JSON.stringify({
          rating,
          body: body.trim().slice(0, MAX_BODY_LENGTH),
          tags: selectedTags,
          anonymous: isAnonymous,
          visibility
        })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const message = (payload?.message as string) ?? '리뷰 작성 중 오류가 발생했습니다.';
        throw new Error(message);
      }

      const createdReview = (await response.json()) as ServerReview;
      setSuccess('리뷰가 등록되었습니다. 감사합니다!');
      setBody('');
      setSelectedTags([]);
      setIsAnonymous(false);
      setVisibility('public');
      onSubmitted?.(createdReview);
      onGateStatusRefresh?.();
      onClose?.();
      if (!onSubmitted) {
        router.refresh();
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '리뷰 제출에 실패했습니다.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form className="space-y-6 rounded-xl border border-[#30343b] bg-[#151922] p-6" onSubmit={handleSubmit}>
      <header className="space-y-2">
        <h4 className="text-lg font-semibold text-white">리뷰 작성</h4>
        <p className="text-sm text-slate-300">
          리뷰는 80자 이내로 작성되며 최대 3개의 태그를 선택할 수 있습니다. 투표 및 소유권 조건을 충족해야 제출이 가능합니다.
        </p>
        <p className="text-xs text-slate-400">
          표시 이름: <span className="text-slate-200">{gateStatus.displayName ?? '로그인 필요'}</span>
        </p>
      </header>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">별점</span>
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              className={`rounded-xl border px-3 py-2 text-sm font-semibold ${
                rating === value
                  ? 'border-amber-300 bg-amber-300/10 text-amber-100'
                  : 'border-[#30343b] text-slate-200 hover:bg-[#202632]'
              }`}
              onClick={() => setRating(value)}
            >
              {value}점
            </button>
          ))}
        </div>
      </div>

      <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        내용 (최대 {MAX_BODY_LENGTH}자)
        <textarea
          className="min-h-[90px] rounded-lg border border-[#30343b] bg-[#101216] px-3 py-2 text-sm text-slate-100"
          value={body}
          onChange={(event) => setBody(event.target.value.slice(0, MAX_BODY_LENGTH))}
          placeholder="서버에 대한 실제 경험을 간단히 적어주세요."
          maxLength={MAX_BODY_LENGTH}
          disabled={!canSubmit}
          required
        />
        <span className="text-right text-[11px] text-slate-500">
          {body.length}/{MAX_BODY_LENGTH}
        </span>
      </label>

      <fieldset>
        <legend className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          태그 (최대 {MAX_TAGS}개)
        </legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {(Object.keys(TAG_LABELS) as ReviewTag[]).map((tag) => {
            const selected = selectedTags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                className={`rounded-xl border px-3 py-2 text-sm ${
                  selected
                    ? 'border-blue-400 bg-blue-500/10 text-blue-100'
                    : 'border-[#30343b] text-slate-200 hover:bg-[#202632]'
                }`}
                onClick={() => toggleTag(tag)}
                disabled={!canSubmit && !selected}
              >
                #{TAG_LABELS[tag]}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-3 text-sm text-slate-300 md:grid-cols-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isAnonymous}
            onChange={(event) => setIsAnonymous(event.target.checked)}
            className="h-4 w-4 rounded border border-slate-700 bg-slate-900"
            disabled={!canSubmit}
          />
          익명으로 작성하기
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={visibility === 'staff'}
            onChange={(event) => setVisibility(event.target.checked ? 'staff' : 'public')}
            className="h-4 w-4 rounded border border-slate-700 bg-slate-900"
            disabled={!canSubmit}
          />
          운영진에게만 보이기
        </label>
        {visibility === 'staff' ? (
          <p className="col-span-full text-xs text-slate-400">
            운영진 전용 피드백은 일반 이용자에게 공개되지 않으며, 서버 관리자가 확인하고 대응합니다.
          </p>
        ) : null}
      </div>

      {error && (
        <p className="rounded-xl border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      )}
      {success && (
        <p className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
          {success}
        </p>
      )}

      <Button
        type="submit"
        disabled={!canSubmit || isSubmitting}
        className="w-full justify-center rounded-lg bg-[#f5f7fb] px-4 py-3 text-sm font-semibold text-[#111827] transition hover:bg-white disabled:opacity-60"
      >
        {isSubmitting ? '제출 중...' : canSubmit ? '리뷰 제출하기' : '조건을 충족해주세요'}
      </Button>
    </form>
  );
}

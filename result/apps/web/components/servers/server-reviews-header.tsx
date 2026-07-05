interface ServerReviewsHeaderProps {
  readonly reviewCount: number;
  readonly averageRating: number | null;
  readonly ratingDistribution?: Record<number, number>;
  readonly composeLabel?: string;
  readonly composeDisabled?: boolean;
  readonly onCompose?: () => void;
}

export function ServerReviewsHeader({
  reviewCount,
  averageRating,
  ratingDistribution,
  composeLabel,
  composeDisabled,
  onCompose
}: ServerReviewsHeaderProps) {
  const distribution = [5, 4, 3, 2, 1].map((rating) => ({
    rating,
    count: ratingDistribution?.[rating] ?? 0
  }));
  const maxCount = Math.max(...distribution.map((item) => item.count), 1);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-start">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9ca3af]">리뷰</p>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <h3 className="text-2xl font-semibold text-white">유저 리뷰</h3>
          {averageRating !== null ? (
            <span className="rounded-md border border-amber-300/30 bg-amber-300/10 px-2.5 py-1 text-sm font-semibold text-amber-100">
              평균 {averageRating.toFixed(1)}점
            </span>
          ) : null}
        </div>
        <p className="mt-2 text-sm leading-6 text-[#9ca3af]">
          최근 투표와 계정 인증을 완료한 플레이어의 경험 리뷰입니다.
        </p>
        <p className="mt-2 text-xs text-[#9ca3af]">
          총 리뷰 {reviewCount.toLocaleString('ko-KR')}건
        </p>
      </div>
      <div className="space-y-3">
        <div className="rounded-xl border border-[#30343b] bg-[#101216] p-3">
          {distribution.map((item) => (
            <div key={item.rating} className="grid grid-cols-[26px_minmax(0,1fr)_32px] items-center gap-2 text-[11px] text-[#9ca3af]">
              <span>{item.rating}점</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-[#30343b]">
                <span
                  className="block h-full rounded-full bg-amber-300"
                  style={{ width: `${Math.round((item.count / maxCount) * 100)}%` }}
                />
              </span>
              <span className="text-right">{item.count.toLocaleString('ko-KR')}</span>
            </div>
          ))}
        </div>
        {onCompose ? (
          <button
            type="button"
            onClick={onCompose}
            disabled={composeDisabled}
            className={`w-full rounded-lg px-5 py-2.5 text-sm font-semibold transition ${
              composeDisabled
                ? 'cursor-not-allowed border border-[#30343b] bg-[#101216] text-[#6b7280]'
                : 'bg-[#f5f7fb] text-[#111827] hover:bg-white'
            }`}
          >
            {composeLabel ?? '리뷰 작성하기'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

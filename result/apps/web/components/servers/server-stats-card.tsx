import type { ServerStats } from '@minewiki/schemas';

interface ServerStatsCardProps {
  readonly stats?: ServerStats | null;
}

export function ServerStatsCard({ stats }: ServerStatsCardProps) {
  if (!stats) {
    return (
      <div className="surface-card p-5 text-sm text-slate-500">
        통계 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.
      </div>
    );
  }

  const trendValues = stats.sparkline.filter((value) => Number.isFinite(value) && value >= 0);
  const hasRecentVoteActivity =
    stats.votes.last24h > 0 ||
    stats.votes.last7d > 0 ||
    (stats.votes.monthToDate ?? 0) > 0 ||
    trendValues.some((value) => value > 0);
  const trendMax = Math.max(...trendValues, 1);
  const trendLatest = trendValues[trendValues.length - 1] ?? null;
  const trendFirst = trendValues[0] ?? null;
  const trendDelta =
    trendLatest !== null && trendFirst !== null ? Math.round(trendLatest - trendFirst) : null;
  const trendDeltaLabel =
    trendDelta === null
      ? '수집 중'
      : trendDelta === 0
        ? '변화 없음'
        : `${trendDelta > 0 ? '+' : ''}${trendDelta.toLocaleString('ko-KR')}표`;
  const trendLatestLabel =
    hasRecentVoteActivity && trendLatest !== null
      ? `${trendLatest.toLocaleString('ko-KR')}표`
      : hasRecentVoteActivity
        ? '집계 중'
        : '투표 없음';
  const monthlyVotes = stats.votes.monthToDate ?? null;
  const latestSample =
    stats.pingSamples && stats.pingSamples.length > 0
      ? stats.pingSamples[stats.pingSamples.length - 1]
      : null;
  const hasPingData = Boolean(stats.lastPingAt || latestSample);
  const isLatestOnline = Boolean(latestSample?.online);
  const hasPlayerCapacity = stats.players.max > 0;
  const playersDisplay = isLatestOnline
    ? hasPlayerCapacity
      ? `${stats.players.online.toLocaleString('ko-KR')} / ${stats.players.max.toLocaleString('ko-KR')}`
      : `${stats.players.online.toLocaleString('ko-KR')}명`
    : hasPingData
      ? '오프라인'
      : '수집 중';
  const latencyDisplay =
    isLatestOnline && stats.latencyMs > 0
      ? `${stats.latencyMs.toLocaleString('ko-KR')}ms`
      : hasPingData
        ? '측정 불가'
        : '수집 중';
  const rankDisplay =
    hasRecentVoteActivity && stats.rank.current > 0 ? `#${stats.rank.current}` : '집계 전';
  const rankDeltaLabel = !hasRecentVoteActivity
    ? '투표 없음'
    : stats.rank.delta24h === 0
      ? '변화 없음'
      : `${stats.rank.delta24h > 0 ? '상승' : '하락'} ${Math.abs(
          stats.rank.delta24h,
        ).toLocaleString('ko-KR')}`;
  const uptimeDisplay = hasPingData ? `${stats.uptimePercent}%` : '수집 중';
  const metrics = [
    {
      label: '24시간',
      value: stats.votes.last24h.toLocaleString('ko-KR'),
      tone: 'text-[#14c794]',
    },
    { label: '7일', value: stats.votes.last7d.toLocaleString('ko-KR'), tone: 'text-cyan-200' },
    { label: '누적', value: stats.votes.total.toLocaleString('ko-KR'), tone: 'text-white' },
    { label: '가동률', value: uptimeDisplay, tone: 'text-amber-200' },
  ];

  return (
    <div className="surface-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            서버 지표
          </p>
          <h4 className="mt-2 text-lg font-bold text-white">랭킹 &amp; 투표 현황</h4>
        </div>
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-right">
          <p className="text-[11px] text-slate-500">현재 랭크</p>
          <p className="text-xl font-bold text-white">{rankDisplay}</p>
          <p className="text-[11px] text-slate-500">{rankDeltaLabel}</p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2">
        {metrics.map((metric) => (
          <div key={metric.label} className="surface-flat p-3">
            <p className="text-[11px] text-slate-500">{metric.label}</p>
            <p className={`mt-1 text-lg font-bold ${metric.tone}`}>{metric.value}</p>
          </div>
        ))}
      </div>

      <dl className="mt-4 space-y-3 border-t border-white/[0.06] pt-4 text-sm text-slate-300">
        {monthlyVotes !== null ? (
          <div className="flex justify-between gap-4">
            <dt className="text-slate-400">이번 달 투표</dt>
            <dd className="font-semibold text-white">{monthlyVotes.toLocaleString('ko-KR')}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-4">
          <dt className="text-slate-400">현재 접속자</dt>
          <dd className="font-semibold text-white">{playersDisplay}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-slate-400">평균 지연시간</dt>
          <dd className="font-semibold text-white">{latencyDisplay}</dd>
        </div>
      </dl>
      <div className="mt-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              최근 투표 활동
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              왼쪽이 과거, 오른쪽이 최근 집계입니다.
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold text-white">{trendLatestLabel}</p>
            <p
              className={`text-[11px] ${
                trendDelta !== null && trendDelta > 0
                  ? 'text-[#14c794]'
                  : trendDelta !== null && trendDelta < 0
                    ? 'text-rose-300'
                    : 'text-slate-500'
              }`}
            >
              {trendDeltaLabel}
            </p>
          </div>
        </div>
        {trendValues.length > 0 && hasRecentVoteActivity ? (
          <>
            <div className="mt-3 flex h-20 items-end gap-1 rounded-lg border border-white/[0.06] bg-[#0d1219] px-2 py-2">
              {trendValues.map((value, index) => {
                const normalizedHeight = Math.max(10, Math.round((value / trendMax) * 64));
                const isLatest = index === trendValues.length - 1;
                return (
                  <div
                    key={`${stats.serverId}-spark-${index}`}
                    className={`w-full rounded-t ${isLatest ? 'bg-[#14c794]' : 'bg-cyan-300/45'}`}
                    style={{ height: `${normalizedHeight}px` }}
                    title={`${value.toLocaleString('ko-KR')}표`}
                  />
                );
              })}
            </div>
            <div className="mt-2 flex justify-between text-[11px] text-slate-500">
              <span>과거</span>
              <span>최고 {trendMax.toLocaleString('ko-KR')}표</span>
              <span>최근</span>
            </div>
          </>
        ) : (
          <div className="mt-3 rounded-lg border border-dashed border-white/[0.08] bg-white/[0.02] px-3 py-6 text-center text-xs text-slate-500">
            투표 추이 데이터를 수집하는 중입니다.
          </div>
        )}
        <p className="mt-2 text-[11px] text-slate-500">
          * 이번 달 투표 수치는 매월 1일 00시에 초기화됩니다.
        </p>
      </div>
    </div>
  );
}

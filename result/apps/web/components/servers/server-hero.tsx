import type { ServerDetail, ServerStats } from '@minewiki/schemas';
import { VoteModal } from '../voting/vote-modal';
import { VoteEligibilityHint } from '../voting/vote-eligibility-hint';
import { CopyAddressButton } from './copy-address-button';
import { ServerMetricsChart } from './server-metrics-chart';

interface ServerHeroProps {
  readonly detail: ServerDetail;
  readonly serverId: string;
  readonly apiBaseUrl?: string;
  readonly stats?: ServerStats | null;
}

export function ServerHero({ detail, serverId, apiBaseUrl, stats }: ServerHeroProps) {
  const editionLabel = detail.edition === 'java' ? 'Java Edition' : 'Bedrock Edition';
  const versionLabel = detail.supportedVersions.join(', ');
  const monthVotes = detail.votesMonthly ?? stats?.votes.monthToDate ?? 0;
  const totalVotes = stats?.votes.total;
  const playersOnline =
    typeof detail.playersOnline === 'number'
      ? detail.playersOnline
      : stats?.players.online ?? null;
  const playersMax =
    typeof detail.playersMax === 'number'
      ? detail.playersMax
      : stats?.players.max ?? null;
  const playersUpdatedIso =
    detail.playersLastUpdatedAt ?? stats?.players.lastUpdatedAt ?? null;
  const playersUpdated =
    playersUpdatedIso && !Number.isNaN(Date.parse(playersUpdatedIso))
      ? new Date(playersUpdatedIso)
      : null;
  const isOnline =
    detail.isOnline ??
    (playersUpdated ? Date.now() - playersUpdated.getTime() <= 1000 * 60 * 10 : undefined);
  const statusTone = isOnline === undefined ? 'unknown' : isOnline ? 'online' : 'offline';
  const statusLabel =
    statusTone === 'online' ? '온라인' : statusTone === 'offline' ? '오프라인' : '상태 정보 없음';
  const statusClass =
    statusTone === 'online'
      ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-100'
      : statusTone === 'offline'
        ? 'border-rose-400/40 bg-rose-500/15 text-rose-100'
        : 'border-slate-600 bg-slate-800 text-slate-300';
  const playersSummary =
    playersOnline !== null && playersMax !== null
      ? `${playersOnline.toLocaleString('ko-KR')} / ${playersMax.toLocaleString('ko-KR')}`
      : '정보 없음';
  const playersFooter = playersUpdated
    ? `기준 ${playersUpdated.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`
    : '최근 접속 정보를 불러오는 중입니다.';
  const joinPort = detail.joinPort ?? 25565;
  const joinAddress = joinPort === 25565 ? detail.joinHost : `${detail.joinHost}:${joinPort}`;
  const summaryStats = [
    {
      label: '24시간 투표',
      value: `${detail.votes24h.toLocaleString('ko-KR')}표`,
      caption: '최근 하루 누적 투표'
    },
    {
      label: '이번 달 투표',
      value: `${monthVotes.toLocaleString('ko-KR')}표`,
      caption: '매월 1일 00시 기준 누적'
    },
    {
      label: '누적 투표',
      value:
        totalVotes !== undefined ? `${totalVotes.toLocaleString('ko-KR')}표` : '집계 중',
      caption: '서버 등록 이후 누적 투표'
    },
    {
      label: '누적 리뷰',
      value: `${detail.reviewsCount.toLocaleString('ko-KR')}건`,
      caption: detail.verifiedAt
        ? `마지막 검증 ${new Date(detail.verifiedAt).toLocaleDateString('ko-KR')}`
        : '검증 이력 준비 중'
    }
  ];
  const metricsHistory = stats ? buildMetricsHistory(stats) : null;

  return (
    <section className="flex flex-col gap-6 rounded-xl border border-[#30343b] bg-[#151922] p-6 shadow-xl shadow-black/20 md:p-8">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-4">
          <span className="inline-flex items-center rounded-md border border-[#30343b] bg-[#101216] px-3 py-1 text-[11px] font-semibold text-[#b7c1d1]">
            {editionLabel}
          </span>
          <div>
            <h2 className="text-3xl font-semibold text-slate-50 md:text-4xl">{detail.name}</h2>
            <p className="mt-3 text-sm text-slate-300 md:text-base">{detail.shortDescription}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <VoteModal
              serverId={serverId}
              apiBaseUrl={apiBaseUrl}
              requiresOwnership={detail.voteRequiresOwnership ?? false}
            />
            <span className="rounded-xl border border-outline-soft px-3 py-1 text-xs text-slate-300">
              하루 1회 (한국시간 00:00 초기화)
            </span>
            {detail.voteRequiresOwnership ? (
              <span className="rounded-xl border border-brand-400/40 bg-brand-500/15 px-3 py-1 text-xs font-semibold text-brand-100">
                유저 인증 투표 전용
              </span>
            ) : null}
          </div>
        </div>
        <div className="grid w-full gap-4 text-xs text-slate-300 lg:w-80 xl:w-[360px]">
          <div className="rounded-xl border border-[#30343b] bg-[#101216] p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#9ca3af]">현재 접속 상태</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-2xl font-semibold text-slate-50">{playersSummary}</p>
              <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${statusClass}`}>
                {statusLabel}
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-400">{playersFooter}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {summaryStats.map((stat) => (
              <div
                key={stat.label}
                className="rounded-xl border border-[#30343b] bg-[#101216] p-4"
              >
                <p className="text-[11px] uppercase tracking-[0.18em] text-[#9ca3af]">
                  {stat.label}
                </p>
                <p className="mt-2 text-lg font-semibold text-slate-50">{stat.value}</p>
                <p className="text-xs text-slate-400">{stat.caption}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <dl className="grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-[#30343b] bg-[#101216] p-4">
          <dt className="text-xs uppercase tracking-[0.3em] text-slate-400">접속 주소</dt>
          <dd className="mt-2 flex flex-wrap items-center gap-3 text-sm font-semibold text-slate-100">
            <code className="rounded-lg bg-slate-900/60 px-3 py-1 text-sm font-mono text-slate-100">
              {joinAddress}
            </code>
            <CopyAddressButton address={joinAddress} />
            {joinPort !== 25565 ? (
              <span className="text-[11px] text-slate-400">포트 {joinPort}</span>
            ) : null}
          </dd>
        </div>
        <div className="rounded-xl border border-[#30343b] bg-[#101216] p-4">
          <dt className="text-xs uppercase tracking-[0.3em] text-slate-400">지원 버전</dt>
          <dd className="mt-2 text-sm font-semibold text-slate-100">{versionLabel}</dd>
        </div>
        {detail.websiteUrl || detail.discordUrl ? (
          <div className="rounded-xl border border-[#30343b] bg-[#101216] p-4">
            <dt className="text-xs uppercase tracking-[0.3em] text-slate-400">외부 링크</dt>
            <dd className="mt-2 flex flex-wrap gap-3 text-sm text-emerald-100">
              {detail.websiteUrl ? (
                <a className="underline" href={detail.websiteUrl} target="_blank" rel="noopener noreferrer">
                  공식 홈페이지
                </a>
              ) : null}
              {detail.discordUrl ? (
                <a className="underline" href={detail.discordUrl} target="_blank" rel="noopener noreferrer">
                  Discord 커뮤니티
                </a>
              ) : null}
            </dd>
          </div>
        ) : null}
      </dl>

      {metricsHistory ? <ServerMetricsChart history={metricsHistory} /> : null}

      <VoteEligibilityHint />
    </section>
  );
}

function buildMetricsHistory(stats: ServerStats) {
  const points = stats.sparkline.length ? stats.sparkline : Array(7).fill(stats.players.online);
  const maxSpark = Math.max(...points, 1);
  const baselinePlayers = stats.players.online;
  const historyLength = points.length;
  const now = new Date();

  return points.map((value, index) => {
    const daysAgo = historyLength - 1 - index;
    const labelDate = new Date(now);
    labelDate.setDate(now.getDate() - daysAgo);
    const label = `${labelDate.getMonth() + 1}/${labelDate.getDate()}`;
    const players = Math.max(
      0,
      Math.round(baselinePlayers * 0.6 + (value / maxSpark) * baselinePlayers * 0.8)
    );
    const latency = Math.max(
      45,
      Math.round(160 - (value / maxSpark) * 70 + Math.sin(index) * 8)
    );
    return {
      label,
      players,
      latency
    };
  });
}

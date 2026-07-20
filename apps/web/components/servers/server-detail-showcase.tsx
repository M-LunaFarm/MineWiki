/* eslint-disable @next/next/no-img-element */
import Link from 'next/link';
import type {
  ServerDetail,
  ServerReferral,
  ServerReview,
  ServerReviewAggregate,
  ServerStats,
  ServerSummary,
  ServerUpdate,
} from '@minewiki/schemas';
import {
  BadgeCheck,
  BookOpen,
  Clock3,
  ExternalLink,
  Flag,
  PencilLine,
  ShieldCheck,
  Star,
  Users,
  Vote,
} from 'lucide-react';
import { SiteHeader } from '../layout/site-header';
import { ServerHeroLive } from './server-hero-live';
import { ServerOverviewCard } from './server-overview-card';
import { ServerStatsCard } from './server-stats-card';
import { ServerReviewSection } from './server-review-section';
import { ServerOwnerControls } from './server-owner-controls';
import { ServerWikiOwnerProgress } from './server-wiki-owner-progress';
import { ServerReferralList } from './server-referral-list';
import {
  getServerPreviewFallbackClass,
  getServerPreviewInitial,
  getServerPreviewSeed,
} from '../../lib/server-preview';
import { buildServerPath } from '../../lib/server-routes';

interface ServerDetailShowcaseProps {
  readonly serverId: string;
  readonly serverPath: string;
  readonly detail: ServerDetail;
  readonly stats: ServerStats | null;
  readonly updates: ServerUpdate[];
  readonly reviews: ServerReview[];
  readonly reviewAggregate: ServerReviewAggregate;
  readonly reviewNextCursor: string | null;
  readonly referrals: ServerReferral[];
  readonly recommendations: ServerSummary[];
  readonly apiBaseUrl?: string;
  readonly currentReviewSort: 'wilson' | 'newest';
  readonly currentReviewRating?: number;
  readonly currentReviewTag?: string;
  readonly initialVoteOpen?: boolean;
}

const TRUST_LABEL_COPY: Record<string, string> = {
  ms_owned: 'Microsoft 계정 소유권 검증 완료',
  vote_ack: '최근 투표 기록 검증 완료',
  plugin_in_game: '서버 플러그인 연동 검증 완료',
  discord_linked: 'Discord 계정 연동 확인',
};

const REVIEW_SORT_OPTIONS: Array<{ value: 'wilson' | 'newest'; label: string }> = [
  { value: 'wilson', label: '평점 순' },
  { value: 'newest', label: '최신 순' },
];

const REVIEW_RATING_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '전체' },
  { value: '5', label: '5점' },
  { value: '4', label: '4점' },
  { value: '3', label: '3점' },
  { value: '2', label: '2점' },
  { value: '1', label: '1점' },
];

export function ServerDetailShowcase({
  serverId,
  serverPath,
  detail,
  stats,
  updates,
  reviews,
  reviewAggregate,
  reviewNextCursor,
  referrals,
  recommendations,
  apiBaseUrl,
  currentReviewSort,
  currentReviewRating,
  currentReviewTag,
  initialVoteOpen = false,
}: ServerDetailShowcaseProps) {
  const availableTags = Array.from(
    new Set([
      ...reviews.flatMap((review) => review.tags),
      ...(currentReviewTag ? [currentReviewTag] : []),
    ]),
  ).sort((left, right) => left.localeCompare(right));
  const timelineEntries = buildTimelineEntries(detail, stats, updates);
  const compactTimelineEntries = timelineEntries.slice(0, 4);
  const reportUrl = buildVoteReportSupportUrl(detail, serverId);
  const correctionUrl = buildServerCorrectionSupportUrl(detail, serverId);
  const wikiHref = detail.wikiUrl;
  const hasExternalLinks = Boolean(detail.discordUrl || detail.websiteUrl);

  const onlinePlayers = stats?.players.online ?? detail.playersOnline ?? 0;
  const playerCap = stats?.players.max ?? detail.playersMax ?? 0;
  const showVerification = detail.verificationGrade === 'Verified';
  const isServerOnline =
    stats?.pingSamples?.at(-1)?.online ?? detail.isOnline ?? Boolean(detail.playersLastUpdatedAt);
  const playersLabel = isServerOnline
    ? playerCap > 0
      ? `${onlinePlayers.toLocaleString('ko-KR')} / ${playerCap.toLocaleString('ko-KR')}`
      : `${onlinePlayers.toLocaleString('ko-KR')}명`
    : stats?.lastPingAt || detail.isOnline === false
      ? '오프라인'
      : '수집 중';

  return (
    <div className="server-detail-surface min-h-screen text-white">
      <SiteHeader />

      <main className="relative z-10 pb-20 pt-24">
        <div className="mx-auto mb-6 w-full max-w-[1440px] px-4 sm:px-6 lg:px-8">
          <nav className="flex items-center text-sm text-slate-400">
            <Link href="/" className="transition-colors hover:text-white">
              홈
            </Link>
            <span className="mx-2 text-slate-600">/</span>
            <Link href="/servers" className="transition-colors hover:text-white">
              서버 목록
            </Link>
            <span className="mx-2 text-slate-600">/</span>
            <span className="font-semibold text-white">{detail.name}</span>
          </nav>
        </div>

        <div className="mx-auto mb-8 w-full max-w-[1440px] px-4 sm:px-6 lg:px-8">
          <ServerHeroLive
            detail={detail}
            serverId={serverId}
            serverPath={serverPath}
            apiBaseUrl={apiBaseUrl}
            initialStats={stats}
            initialVoteOpen={initialVoteOpen}
          />
        </div>

        <div className="mx-auto w-full max-w-[1440px] px-4 sm:px-6 lg:px-8">
          <ServerWikiOwnerProgress
            serverId={serverId}
            apiBaseUrl={apiBaseUrl}
            publicWikiUrl={wikiHref}
          />
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section id="server-overview" className="min-w-0 xl:col-start-1 xl:row-start-1">
              <ServerOverviewCard detail={detail} />
              {wikiHref ? (
                <section className="server-documentation-card mt-6 overflow-hidden rounded-2xl border border-emerald-400/25 bg-gradient-to-br from-emerald-400/[0.09] via-[#111821] to-[#10161e] p-5 sm:p-6" aria-labelledby="server-documentation-title">
                  <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-start gap-4">
                      <span className="grid size-12 shrink-0 place-items-center rounded-xl border border-emerald-400/25 bg-emerald-400/10 text-emerald-200">
                        <BookOpen className="size-5" aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-300">Server Documentation</p>
                        <h2 id="server-documentation-title" className="mt-1 text-xl font-bold text-white">{detail.name} 서버 위키</h2>
                        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">랭킹·투표 정보에서 이어지는 독립 문서 공간입니다. 접속 방법, 서버 규칙, 시작 가이드와 운영 공지를 GitBook처럼 문서별로 확인할 수 있습니다.</p>
                      </div>
                    </div>
                    <Link href={wikiHref} className="btn-primary min-h-11 shrink-0 px-5">
                      서버 위키 열기
                      <ExternalLink className="size-4" aria-hidden="true" />
                    </Link>
                  </div>
                </section>
              ) : null}
            </section>

            <aside className="space-y-4 xl:sticky xl:top-24 xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:self-start xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto xl:pr-1">
              <ServerStatsCard stats={stats} />

              <section className="surface-card p-5">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-cyan-500/10 p-1.5 text-cyan-200">
                    <BadgeCheck className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">참여 정보</h3>
                    <p className="mt-1 text-xs leading-5 text-slate-400">
                      투표 가능 횟수는 매일 00:00 (KST)에 초기화됩니다.
                    </p>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                  <div className="surface-flat p-3">
                    <p className="text-[11px] text-slate-500">접속자</p>
                    <p className="mt-1 font-semibold text-emerald-200">{playersLabel}</p>
                  </div>
                  <div className="surface-flat p-3">
                    <p className="text-[11px] text-slate-500">검증</p>
                    <p
                      className={`mt-1 font-semibold ${
                        showVerification ? 'text-cyan-200' : 'text-slate-300'
                      }`}
                    >
                      {showVerification ? '완료' : '대기'}
                    </p>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-1">
                  <a
                    href={reportUrl}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-amber-400/40 hover:text-amber-100"
                  >
                    <Flag className="h-4 w-4" />
                    투표 이상 문의
                  </a>
                  <a
                    href={correctionUrl}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-100"
                  >
                    <PencilLine className="h-4 w-4" />
                    정보 정정
                  </a>
                </div>
              </section>

              <section className="surface-card p-5">
                <h3 className="text-sm font-semibold text-white">서버 링크</h3>
                <div className="mt-3 grid gap-2">
                  {wikiHref ? (
                    <a
                      className="flex items-center justify-between rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2.5 text-sm font-semibold text-emerald-100 transition hover:border-emerald-300/70 hover:bg-emerald-400/15"
                      href={wikiHref}
                    >
                      서버 위키 열기
                      <BookOpen className="h-4 w-4 text-emerald-200" />
                    </a>
                  ) : null}
                  {detail.discordUrl ? (
                    <a
                      className="flex items-center justify-between rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm font-medium text-slate-300 transition hover:border-[#5865F2] hover:text-white"
                      href={detail.discordUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Discord
                      <ExternalLink className="h-4 w-4 text-slate-500" />
                    </a>
                  ) : null}
                  {detail.websiteUrl ? (
                    <a
                      className="flex items-center justify-between rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm font-medium text-slate-300 transition hover:border-[#3b82f6] hover:text-white"
                      href={detail.websiteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Website
                      <ExternalLink className="h-4 w-4 text-slate-500" />
                    </a>
                  ) : null}
                  {!hasExternalLinks ? (
                    <p className="rounded-lg border border-dashed border-white/[0.08] bg-white/[0.02] p-3 text-xs text-slate-500">
                      등록된 외부 링크가 없습니다.
                    </p>
                  ) : null}
                </div>
                {detail.tags.length > 0 ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {detail.tags.map((tag) => (
                      <span key={tag} className="chip chip-muted">
                        #{tag}
                      </span>
                    ))}
                  </div>
                ) : null}
              </section>

              <section
                id="recent-updates"
                className="surface-card p-5"
              >
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
                    <Clock3 className="h-4 w-4 text-cyan-200" />
                    최근 업데이트
                  </h3>
                  <span className="text-xs text-slate-500">최근 {timelineEntries.length}건</span>
                </div>
                <div className="space-y-3">
                  {compactTimelineEntries.map((entry, index) => (
                    <article
                      key={entry.id}
                      className="surface-flat p-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <h4 className="truncate text-sm font-semibold text-white">{entry.title}</h4>
                        <span className="shrink-0 text-[11px] text-slate-500">{entry.date}</span>
                      </div>
                      <p
                        className={`mt-1 text-xs leading-5 text-slate-400 ${
                          index > 1 ? 'line-clamp-2' : ''
                        }`}
                      >
                        {entry.description}
                      </p>
                    </article>
                  ))}
                </div>
              </section>

              <ServerReferralList
                serverId={serverId}
                initialReferrals={referrals}
                apiBaseUrl={apiBaseUrl}
              />
            </aside>

            <section id="server-reviews" className="min-w-0 xl:col-start-1 xl:row-start-2">
              <ServerReviewSection
                serverId={serverId}
                serverPath={serverPath}
                initialReviews={reviews}
                initialAggregate={reviewAggregate}
                initialNextCursor={reviewNextCursor}
                apiBaseUrl={apiBaseUrl}
                trustLabelCopy={TRUST_LABEL_COPY}
                availableTags={availableTags}
                currentSort={currentReviewSort}
                currentRating={currentReviewRating}
                currentTag={currentReviewTag}
                ratingOptions={REVIEW_RATING_OPTIONS}
                sortOptions={REVIEW_SORT_OPTIONS}
              />
            </section>
          </div>

          <ServerOwnerControls
            serverId={serverId}
            apiBaseUrl={apiBaseUrl}
            initialPolicy={detail.voteRequiresOwnership ?? false}
            initialWikiUrl={detail.wikiUrl}
            initialProfile={detail}
            className="mt-8"
          />
        </div>

        {recommendations.length > 0 ? (
          <section className="mx-auto mt-16 w-full max-w-[1440px] px-4 sm:px-6 lg:px-8">
            <div className="mb-7 flex items-end justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#14c794]">
                  More Servers
                </p>
                <h2 className="mt-2 flex items-center gap-2 text-2xl font-bold text-white">
                  <Star className="h-5 w-5 text-amber-300" />
                  추천 서버
                </h2>
              </div>
              <Link
                href="/servers"
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#14c794] transition-colors hover:text-[#1ee6a4]"
              >
                전체 보기
                <ExternalLink className="h-4 w-4" />
              </Link>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
              {recommendations.map((server) => (
                <Link
                  key={server.id}
                  href={buildServerPath(server)}
                  className="surface-card surface-card-hover group block overflow-hidden p-0"
                >
                  <div className="dark-fixed-surface relative h-36 overflow-hidden bg-[#0d1219]">
                    {server.bannerUrl ? (
                      <img
                        src={server.bannerUrl}
                        alt={`${server.name} 배너`}
                        className="h-full w-full object-cover opacity-85 transition-all duration-500 group-hover:scale-105 group-hover:opacity-100"
                      />
                    ) : (
                      <div
                        className={`flex h-full w-full items-center justify-center text-4xl font-black text-white/45 ${getServerPreviewFallbackClass(
                          getServerPreviewSeed(server),
                        )}`}
                      >
                        {getServerPreviewInitial(server.name)}
                      </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-[#11161e] via-transparent to-transparent" />
                    <div className="absolute left-3 top-3">
                      <span className={`rank-pill ${server.rank?.current === 1 ? 'rank-1' : 'rank-default'}`}>
                        {server.rank?.current ?? '순위 미집계'}
                      </span>
                    </div>
                  </div>
                  <div className="p-4">
                    <h4 className="mb-1 truncate text-base font-bold text-white transition-colors group-hover:text-[#14c794]">
                      {server.name}
                    </h4>
                    <div className="mb-3 inline-block max-w-full truncate font-mono text-xs text-slate-500">
                      {server.joinHost}
                    </div>
                    <div className="flex items-center justify-between border-t border-white/[0.06] pt-3 text-xs font-medium">
                      <div className="flex items-center gap-1.5 text-slate-400">
                        <Users className="h-3.5 w-3.5" />
                        {(server.playersOnline ?? 0).toLocaleString('ko-KR')}명
                      </div>
                      <div className="flex items-center gap-1.5 text-[#14c794]">
                        <Vote className="h-3.5 w-3.5" />
                        {server.votes24h.toLocaleString('ko-KR')}표
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        <section className="mx-auto mt-16 w-full max-w-[1440px] px-4 pb-8 sm:px-6 lg:px-8">
          <div className="surface-card relative overflow-hidden p-8 text-center md:p-12">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-16 left-1/2 h-40 w-[420px] -translate-x-1/2 rounded-full bg-[#14c794]/15 blur-[80px]"
            />
            <div className="relative">
              <ShieldCheck className="mx-auto h-8 w-8 text-[#14c794]" />
              <p className="mt-4 text-base font-semibold text-white">
                이 서버를 운영 중이신가요?
              </p>
              <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
                소유권을 인증하고 서버 정보를 직접 관리하세요. 투표 링크, 배너, 갤러리까지 한 번에.
              </p>
              <Link
                href={`/claim?serverId=${serverId}`}
                className="btn-primary mx-auto mt-6"
              >
                <ShieldCheck className="h-4 w-4" />
                소유권 검증하기
              </Link>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function buildTimelineEntries(
  detail: ServerDetail,
  stats: ServerStats | null,
  updates: ServerUpdate[],
): Array<{ id: string; title: string; description: string; date: string }> {
  if (updates.length > 0) {
    return updates.map((update) => ({
      id: update.id,
      title: update.title,
      description: update.actorDisplayName
        ? `${update.actorDisplayName}: ${update.description}`
        : update.description,
      date: formatDate(update.occurredAt),
    }));
  }

  const fallback = [
    {
      id: `fallback-system-${detail.id}`,
      title: '서버 정보 업데이트',
      description: `${detail.name}의 서버 정보가 최신 상태로 갱신되었습니다.`,
      date: formatDate(detail.lastUpdatedAt),
    },
    detail.verifiedAt
      ? {
          id: `fallback-verified-${detail.id}`,
          title: `검증 상태 ${detail.verificationGrade}`,
          description: '검증 로그를 기반으로 현재 검증 상태가 갱신되었습니다.',
          date: formatDate(detail.verifiedAt),
        }
      : null,
    stats?.lastPingAt
      ? {
          id: `fallback-ping-${detail.id}`,
          title: '실시간 상태 점검',
          description: '최근 서버 핑/접속 상태를 기반으로 상태 정보가 업데이트되었습니다.',
          date: formatDate(stats.lastPingAt),
        }
      : null,
  ].filter((entry): entry is { id: string; title: string; description: string; date: string } =>
    Boolean(entry),
  );

  if (fallback.length > 0) {
    return fallback;
  }

  return [
    {
      id: `fallback-empty-${detail.id}`,
      title: '업데이트 준비 중',
      description: '아직 표시할 업데이트 이력이 없습니다.',
      date: '-',
    },
  ];
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return '-';
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return '-';
  }
  return new Date(parsed).toLocaleDateString('ko-KR');
}

function buildVoteReportSupportUrl(detail: ServerDetail, serverId: string): string {
  const subject = `[MineWiki] 투표 이상 문의 - ${detail.name}`;
  const body = [
    `서버명: ${detail.name}`,
    `서버 ID: ${serverId}`,
    `접속 주소: ${detail.joinHost}:${detail.joinPort}`,
    '',
    '문의 유형: 반복 투표 의심 / 비정상 계정 의심 / 자동화 의심 / 기타',
    '',
    '의심 시각 또는 기간:',
    '',
    '확인 가능한 근거:',
    '',
    '요청 사항:',
  ].join('\n');

  const params = new URLSearchParams({
    category: 'plugin_sync',
    serverId,
    subject,
    body,
  });
  return `/support?${params.toString()}`;
}

function buildServerCorrectionSupportUrl(detail: ServerDetail, serverId: string): string {
  const subject = `[MineWiki] 서버 정보 정정 요청 - ${detail.name}`;
  const body = [
    `서버명: ${detail.name}`,
    `서버 ID: ${serverId}`,
    `현재 접속 주소: ${detail.joinHost}:${detail.joinPort}`,
    '',
    '정정이 필요한 항목: 서버 주소 / 소개 / 이미지 / 외부 링크 / 기타',
    '',
    '현재 표시된 내용:',
    '',
    '수정되어야 할 내용:',
    '',
    '확인 가능한 근거:',
  ].join('\n');

  const params = new URLSearchParams({
    category: 'server_claim',
    serverId,
    subject,
    body,
  });
  return `/support?${params.toString()}`;
}

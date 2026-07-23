import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  BadgeCheck,
  CircleDot,
  ExternalLink,
  MessageSquareText,
  Server,
  Trophy,
  Users,
  Vote,
} from 'lucide-react';

import type { WikiPageResponse } from '../../lib/wiki-api';
import { CopyAddressButton } from '../servers/copy-address-button';

type DirectoryOverview = NonNullable<NonNullable<WikiPageResponse['serverWiki']>['directoryOverview']>;

interface ServerWikiDirectoryOverviewProps {
  readonly name: string;
  readonly address: string | null;
  readonly overview: DirectoryOverview;
}

export function ServerWikiDirectoryOverview({ name, address, overview }: ServerWikiDirectoryOverviewProps) {
  const rankDelta = overview.rank?.delta24h ?? null;
  const liveLabel = overview.live.isOnline === true
    ? overview.live.playersOnline !== null
      ? `${overview.live.playersOnline.toLocaleString('ko-KR')}명 접속 중`
      : '온라인'
    : overview.live.isOnline === false
      ? '오프라인'
      : '상태 확인 중';
  const liveTone = overview.live.isOnline === true
    ? 'text-emerald-700'
    : overview.live.isOnline === false
      ? 'text-rose-700'
      : 'text-[#777]';

  return (
    <section className="mt-8 overflow-hidden rounded-2xl border border-[#dce3ef] bg-[linear-gradient(145deg,#f8faff_0%,#ffffff_56%,#f4f8ff_100%)] shadow-[0_18px_50px_rgba(52,109,219,0.08)]" aria-labelledby="server-wiki-directory-overview-title">
      <div className="border-b border-[#e2e8f2] px-5 py-6 sm:px-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#346ddb]">Live server overview</p>
            <h2 id="server-wiki-directory-overview-title" className="mt-2 text-2xl font-bold tracking-tight text-[#202938]">
              {name} 현재 서버 개요
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[#667085]">{overview.shortDescription || '서버 소개가 아직 등록되지 않았습니다.'}</p>
          </div>
          <span className={`inline-flex items-center gap-2 rounded-full border border-current/20 bg-white px-3 py-1.5 text-xs font-semibold ${liveTone}`}>
            <CircleDot className="size-3.5" aria-hidden="true" />
            {liveLabel}
            {overview.live.playersMax !== null && overview.live.isOnline === true ? ` / ${overview.live.playersMax.toLocaleString('ko-KR')}명` : ''}
          </span>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#e9f0ff] px-3 py-1 text-xs font-semibold text-[#2458bd]">
            <BadgeCheck className="size-3.5" aria-hidden="true" />
            {overview.verificationGrade === 'Verified' ? '검증된 서버' : '미검증 서버'}
          </span>
          {overview.tags.map((tag, index) => (
            <span key={`${tag}-${index}`} className="rounded-full border border-[#dde3ec] bg-white px-3 py-1 text-xs text-[#667085]">#{tag}</span>
          ))}
        </div>
      </div>

      <div className="grid gap-px bg-[#e2e8f2] sm:grid-cols-2 xl:grid-cols-4">
        <Metric icon={<Trophy className="size-4" />} label="현재 순위" value={overview.rank ? `${overview.rank.current.toLocaleString('ko-KR')}위` : '집계 대기'} detail={overview.rank ? `${formatRankDelta(rankDelta)} · 최고 ${overview.rank.best.toLocaleString('ko-KR')}위` : '유효 투표 후 순위가 집계됩니다.'} />
        <Metric icon={<Vote className="size-4" />} label="최근 투표" value={`${overview.votes24h.toLocaleString('ko-KR')}표`} detail={`24시간 · 월간 ${overview.votesMonthly?.toLocaleString('ko-KR') ?? '집계 대기'}`} />
        <Metric icon={<MessageSquareText className="size-4" />} label="서버 리뷰" value={`${overview.reviewsCount.toLocaleString('ko-KR')}개`} detail="공개 서버 디렉터리 기준" />
        <Metric icon={<Users className="size-4" />} label="실시간 상태" value={liveLabel} detail={formatObservedAt(overview.live.updatedAt)} />
      </div>

      <div className="flex flex-col gap-4 px-5 py-5 sm:px-7 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          {address ? (
            <>
              <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#667085]"><Server className="size-4" />접속 주소</span>
              <code className="max-w-full break-all rounded-lg bg-[#edf2fb] px-3 py-2 text-sm font-semibold text-[#2458bd]">{address}</code>
              <CopyAddressButton address={address} className="rounded-lg border border-[#b9c9e7] bg-white px-3 py-2 text-xs font-semibold text-[#2458bd] transition hover:border-[#346ddb] hover:bg-[#f7f9ff]" />
            </>
          ) : <span className="text-sm text-[#777]">공개 접속 주소가 없습니다.</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={overview.path} className="theme-on-brand inline-flex min-h-10 items-center gap-2 rounded-lg bg-[#346ddb] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#2458bd]">
            서버 상세·리뷰
          </Link>
          <Link href={`${overview.path}?vote=1`} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[#b9c9e7] bg-white px-4 py-2 text-sm font-semibold text-[#2458bd] transition hover:border-[#346ddb] hover:bg-[#f7f9ff]">
            투표하기
          </Link>
          {overview.websiteUrl ? <ExternalLinkAnchor href={overview.websiteUrl} label="공식 웹사이트" /> : null}
          {overview.discordUrl ? <ExternalLinkAnchor href={overview.discordUrl} label="Discord" /> : null}
        </div>
      </div>

      <p className="border-t border-[#e2e8f2] bg-white/70 px-5 py-3 text-xs leading-5 text-[#7b8494] sm:px-7">
        이 영역은 현재 서버 디렉터리 정보를 표시합니다. 아래 위키 본문은 게시된 문서 릴리스에 고정되어 별도로 관리됩니다.
      </p>
    </section>
  );
}

function Metric({ icon, label, value, detail }: { readonly icon: ReactNode; readonly label: string; readonly value: string; readonly detail: string }) {
  return (
    <div className="bg-white px-5 py-5">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-[#667085]">{icon}{label}</p>
      <p className="mt-3 text-xl font-bold text-[#202938]">{value}</p>
      <p className="mt-1 text-xs leading-5 text-[#7b8494]">{detail}</p>
    </div>
  );
}

function ExternalLinkAnchor({ href, label }: { readonly href: string; readonly label: string }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 py-2 text-sm font-semibold text-[#526075] hover:text-[#2458bd]">{label}<ExternalLink className="size-3.5" /></a>;
}

function formatRankDelta(delta: number | null): string {
  if (delta === null || delta === 0) return '24시간 변동 없음';
  return `24시간 ${delta > 0 ? '상승' : '하락'} ${Math.abs(delta).toLocaleString('ko-KR')}위`;
}

function formatObservedAt(value: string | null): string {
  if (!value) return '측정 시각 없음';
  return `${new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value))} 측정`;
}

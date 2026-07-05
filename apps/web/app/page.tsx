/* eslint-disable @next/next/no-img-element */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, ChevronRight, Search, ShieldCheck, Sparkles, Star, Users, Vote, Wifi } from 'lucide-react';
import type { ServerSummary } from '@minewiki/schemas';
import { fetchServerSummaries } from '../lib/api';
import { SiteFooter } from '../components/layout/site-footer';
import { SiteHeader } from '../components/layout/site-header';
import { buildServerPath } from '../lib/server-routes';
import { createPageMetadata } from '../lib/metadata';
import {
  getServerPreviewFallbackClass,
  getServerPreviewInitial,
  getServerPreviewSeed,
} from '../lib/server-preview';

export const metadata = createPageMetadata({
  title: '마인크래프트 서버 목록',
  description: '검증 상태, 투표, 리뷰를 기준으로 한국 마인크래프트 서버를 비교하세요.',
  path: '/',
});

export const revalidate = 60;

export default async function HomePage() {
  let servers: ServerSummary[] = [];

  try {
    servers = await fetchServerSummaries({ sort: 'votes24h_desc' });
  } catch (error) {
    console.error('Failed to load home page server data', error);
  }

  const featured = servers.slice(0, 6);
  const totalVotes = servers.reduce((sum, server) => sum + server.votes24h, 0);
  const verified = servers.filter((server) => server.verificationGrade === 'Verified').length;
  const onlineCount = servers.filter((server) => server.isOnline !== false && (server.playersOnline ?? 0) > 0).length;

  return (
    <div className="min-h-screen text-white">
      <SiteHeader />
      <main className="pt-16">
        {/* HERO */}
        <section className="relative overflow-hidden border-b border-white/[0.06]">
          <div className="pointer-events-none absolute inset-0 grid-noise opacity-60" aria-hidden="true" />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-24 left-1/2 h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-[#14c794]/15 blur-[120px]"
          />
          <div className="relative mx-auto w-full max-w-[1280px] px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
            <div className="mx-auto max-w-3xl text-center">
              <span className="chip chip-accent mx-auto">
                <Sparkles className="h-3.5 w-3.5" />
                한국 마인크래프트 서버 디렉토리
              </span>
              <h1 className="mt-6 text-4xl font-extrabold leading-[1.1] tracking-tight sm:text-6xl">
                <span className="text-gradient">검증된 서버</span>를 찾고,
                <br className="hidden sm:block" /> 투표와 리뷰로 비교하세요.
              </h1>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-slate-400">
                단순한 투표 수 순위가 아닙니다. 운영 정보, 검증 상태, 리뷰 신뢰도까지 한 화면에서
                비교하고, 가장 믿을 수 있는 서버를 만나보세요.
              </p>

              <form action="/servers" className="mx-auto mt-8 flex max-w-2xl flex-col gap-2 sm:flex-row">
                <label className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500" />
                  <input
                    name="search"
                    type="search"
                    aria-label="서버 검색"
                    placeholder="서버명, 주소, 장르 검색"
                    className="h-14 w-full rounded-xl border border-white/[0.08] bg-white/[0.04] pl-12 pr-4 text-sm text-white placeholder:text-slate-500 backdrop-blur-sm transition-colors focus:border-[#14c794]/60 focus:bg-white/[0.06] focus:outline-none focus:ring-4 focus:ring-[#14c794]/15"
                  />
                </label>
                <button type="submit" className="btn-primary h-14 px-6 text-base">
                  서버 찾기
                  <ArrowRight className="h-4 w-4" />
                </button>
              </form>

              <div className="mt-7 flex flex-wrap justify-center gap-2">
                <QuickFilter href="/servers?edition=java" label="Java" />
                <QuickFilter href="/servers?edition=bedrock" label="Bedrock" />
                <QuickFilter href="/servers?tag=survival" label="야생" />
                <QuickFilter href="/servers?tag=rpg" label="RPG" />
                <QuickFilter href="/servers?sort=latest" label="신규 등록" />
              </div>
            </div>

            {/* Stat row */}
            <div className="mx-auto mt-14 grid max-w-4xl grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat icon={<Vote className="h-4 w-4" />} label="등록 서버" value={servers.length} />
              <Stat icon={<Wifi className="h-4 w-4" />} label="온라인" value={onlineCount} tone="cyan" />
              <Stat icon={<ShieldCheck className="h-4 w-4" />} label="검증 서버" value={verified} tone="emerald" />
              <Stat icon={<Star className="h-4 w-4" />} label="24시간 투표" value={totalVotes} tone="amber" />
            </div>
          </div>
        </section>

        {/* FEATURED SERVERS */}
        <section className="mx-auto w-full max-w-[1280px] px-4 py-14 sm:px-6 lg:px-8">
          <div className="mb-7 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#14c794]">
                Top Rated
              </p>
              <h2 className="mt-2 text-2xl font-bold text-white sm:text-3xl">현재 상위 서버</h2>
              <p className="mt-1.5 text-sm text-slate-400">최근 24시간 투표 기준으로 정렬했습니다.</p>
            </div>
            <Link
              href="/servers"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#14c794] transition-colors hover:text-[#1ee6a4]"
            >
              전체 보기
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>

          {featured.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {featured.map((server, index) => (
                <ServerPreviewCard key={server.id} server={server} rank={index + 1} />
              ))}
            </div>
          ) : (
            <div className="surface-card flex flex-col items-center justify-center p-12 text-center">
              <p className="text-sm text-slate-400">
                표시할 서버 데이터를 불러오지 못했습니다. 서버 목록에서 다시 확인해 주세요.
              </p>
              <Link href="/servers" className="btn-ghost mt-4">
                서버 목록으로
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          )}
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

function QuickFilter({ href, label }: { readonly href: string; readonly label: string }) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 text-sm text-slate-300 transition-all hover:border-[#14c794]/40 hover:bg-[#14c794]/[0.06] hover:text-white"
    >
      {label}
    </Link>
  );
}

function Stat({
  icon,
  label,
  value,
  tone = 'slate',
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: number;
  readonly tone?: 'slate' | 'cyan' | 'emerald' | 'amber';
}) {
  const toneClass =
    tone === 'cyan'
      ? 'text-cyan-300'
      : tone === 'emerald'
        ? 'text-[#14c794]'
        : tone === 'amber'
          ? 'text-amber-300'
          : 'text-white';
  const iconTone =
    tone === 'cyan'
      ? 'text-cyan-300'
      : tone === 'emerald'
        ? 'text-[#14c794]'
        : tone === 'amber'
          ? 'text-amber-300'
          : 'text-slate-400';
  return (
    <div className="surface-card p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
        <span className={iconTone}>{icon}</span>
        {label}
      </div>
      <div className={`mt-2 text-2xl font-extrabold tabular-nums ${toneClass}`}>
        {value.toLocaleString('ko-KR')}
      </div>
    </div>
  );
}

function ServerPreviewCard({ server, rank }: { readonly server: ServerSummary; readonly rank: number }) {
  const online = server.isOnline !== false && (server.playersOnline ?? 0) > 0;
  const fallback = getServerPreviewFallbackClass(getServerPreviewSeed(server));
  const fallbackInitial = getServerPreviewInitial(server.name);
  const rankClass = rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : rank === 3 ? 'rank-3' : 'rank-default';

  return (
    <Link
      href={buildServerPath(server)}
      className="surface-card surface-card-hover group flex flex-col overflow-hidden p-0"
    >
      <div className="relative banner-frame aspect-[16/6]">
        {server.bannerUrl ? (
          <img className="h-full w-full object-cover" src={server.bannerUrl} alt="" />
        ) : (
          <div className={`flex h-full w-full items-center justify-center ${fallback}`}>
            <span className="text-4xl font-black text-white/50">{fallbackInitial}</span>
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[#11161e] via-transparent to-transparent" />
        <div className="absolute left-3 top-3 flex items-center gap-2">
          <span className={`rank-pill ${rankClass}`}>{rank}</span>
          <span className={`chip ${online ? 'chip-accent' : 'chip-red'}`}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${online ? 'bg-[#14c794]' : 'bg-rose-400'}`} />
            {online ? 'ONLINE' : 'OFFLINE'}
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 truncate text-base font-bold text-white">{server.name}</h3>
          <span className="chip chip-muted shrink-0">{server.edition}</span>
        </div>
        <p className="mt-2 line-clamp-2 min-h-[40px] text-sm leading-5 text-slate-400">
          {server.shortDescription}
        </p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {server.tags.slice(0, 3).map((tag) => (
            <span key={`${server.id}-${tag}`} className="chip chip-muted">
              {tag}
            </span>
          ))}
        </div>

        <div className="mt-auto flex items-center justify-between border-t border-white/[0.06] pt-3 text-xs">
          <span className="inline-flex items-center gap-1.5 font-mono text-slate-400">
            <Users className="h-3.5 w-3.5 text-slate-500" />
            {server.joinHost}
          </span>
          <span className="inline-flex items-center gap-1 font-semibold text-[#14c794]">
            <Vote className="h-3.5 w-3.5" />
            {server.votes24h.toLocaleString('ko-KR')}
          </span>
        </div>
      </div>
    </Link>
  );
}

import Image from 'next/image';
import Link from 'next/link';
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Compass,
  MessageSquareText,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  Vote,
} from 'lucide-react';
import type { ServerRankingResponse, ServerSummary } from '@minewiki/schemas';
import { fetchServerRankings } from '../lib/api';
import { SiteFooter } from '../components/layout/site-footer';
import { SiteHeader } from '../components/layout/site-header';
import { buildServerPath } from '../lib/server-routes';
import { createPageMetadata } from '../lib/metadata';

export const metadata = createPageMetadata({
  title: '서버와 지식을 잇는 마인크래프트 커뮤니티',
  description: '검증된 서버 랭킹과 위키 지식을 한곳에서 탐색하는 MineWiki 공식 서비스입니다.',
  path: '/',
});

export const dynamic = 'force-dynamic';

const EMPTY_RANKING: ServerRankingResponse = {
  items: [], total: 0, summary: { online: 0, verified: 0, votes24h: 0 },
  page: 1, pageSize: 4, totalPages: 0, rankUpdatedAt: null,
};

export default async function HomePage() {
  let ranking = EMPTY_RANKING;
  try {
    ranking = await fetchServerRankings({ sort: 'votes24h_desc', page: 1, pageSize: 4 });
  } catch (error) {
    console.error('Failed to load home ranking data', error);
  }
  const featured = ranking.items[0];

  return (
    <div className="min-h-screen bg-[#070a0c] text-white">
      <SiteHeader />
      <main className="pt-16">
        <section className="relative isolate overflow-hidden border-b border-white/[0.07]">
          <Image src="/images/minewiki-discovery-world.png" alt="블록으로 지어진 호숫가 성과 서버 월드" fill priority sizes="100vw" className="z-0 object-cover object-[62%_center] opacity-70" />
          <div className="absolute inset-0 z-10 bg-[linear-gradient(90deg,#070a0c_0%,rgba(7,10,12,.96)_31%,rgba(7,10,12,.48)_62%,rgba(7,10,12,.78)_100%)]" />
          <div className="absolute inset-0 z-10 bg-[linear-gradient(0deg,#070a0c_0%,transparent_44%,rgba(7,10,12,.5)_100%)]" />

          <div className="relative z-20 mx-auto grid min-h-[610px] w-full max-w-[1440px] grid-cols-1 items-center gap-8 px-4 py-12 sm:px-6 lg:grid-cols-[1.08fr_.92fr_.72fr] lg:px-10 lg:py-16">
            <div className="max-w-xl">
              <div className="mb-5 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[.18em] text-[#34e1b3]">
                <Sparkles className="h-4 w-4" /> MineWiki Discovery
              </div>
              <h1 className="text-4xl font-black leading-[1.08] tracking-[-.04em] sm:text-5xl xl:text-[3.65rem]">
                어디서 플레이할지,<br /><span className="text-[#35e5b7]">무엇을 배울지</span> 한눈에.
              </h1>
              <p className="mt-5 max-w-lg text-[15px] leading-7 text-slate-300">
                서버 랭킹과 위키 지식을 따로 찾지 마세요. 검증된 운영 정보부터 플레이에 필요한 가이드까지 하나의 탐색 흐름으로 연결합니다.
              </p>
              <form action="/search" className="mt-8 flex max-w-lg overflow-hidden rounded-xl border border-white/15 bg-black/45 p-1.5 shadow-2xl backdrop-blur-md focus-within:border-[#35e5b7]/60">
                <Search className="ml-3 h-5 w-5 shrink-0 self-center text-slate-400" />
                <input name="search" type="search" aria-label="서버와 위키 검색" placeholder="서버명, 주소, 플레이 스타일 검색" className="min-w-0 flex-1 bg-transparent px-3 text-sm text-white outline-none placeholder:text-slate-500" />
                <button className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[#31d9aa] text-[#06110d] transition hover:bg-[#4cebbb]" aria-label="검색"><ArrowRight className="h-5 w-5" /></button>
              </form>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span>인기 탐색</span>
                <QuickLink href="/servers?tag=survival">야생</QuickLink><QuickLink href="/servers?tag=rpg">RPG</QuickLink><QuickLink href="/servers?edition=bedrock">Bedrock</QuickLink>
              </div>
            </div>

            <FeaturedServer server={featured} rank={ranking.items.length ? 1 : undefined} />

            <aside className="rounded-2xl border border-white/10 bg-[#09110f]/80 p-5 shadow-2xl backdrop-blur-xl lg:self-center">
              <p className="text-xs font-semibold uppercase tracking-[.16em] text-[#35e5b7]">연결된 위키 지식</p>
              <h2 className="mt-2 text-xl font-bold">플레이 전에 준비하세요</h2>
              <div className="mt-5 divide-y divide-white/[0.08]">
                <KnowledgeLink href="/wiki/대문" icon={<BookOpen />} title="위키 대문" body="핵심 문서와 최신 지식 탐색" />
                <KnowledgeLink href="/recent" icon={<Compass />} title="최근 변경" body="커뮤니티가 갱신한 새 정보" />
                <KnowledgeLink href="/help/대문" icon={<ShieldCheck />} title="편집 도움말" body="신뢰할 수 있는 지식에 기여" />
              </div>
              <div className="mt-5 rounded-xl border border-[#35e5b7]/20 bg-[#35e5b7]/[.07] p-3.5 text-xs leading-5 text-slate-300">
                <CheckCircle2 className="mr-2 inline h-4 w-4 text-[#35e5b7]" />
                서버 검증 상태·투표·리뷰를 함께 확인해 더 믿을 수 있게 비교합니다.
              </div>
            </aside>
          </div>
        </section>

        <section className="border-b border-white/[0.07] bg-[#090d10]">
          <div className="mx-auto max-w-[1280px] px-4 py-12 sm:px-6 lg:px-8">
            <div className="flex items-end justify-between gap-5">
              <div><p className="text-xs font-semibold uppercase tracking-[.18em] text-[#35e5b7]">Discovery Journey</p><h2 className="mt-2 text-2xl font-bold">발견에서 플레이까지 이어지는 여정</h2></div>
              <Link href="/servers" className="hidden items-center gap-1 text-sm font-semibold text-[#35e5b7] sm:flex">전체 서버 랭킹 <ChevronRight className="h-4 w-4" /></Link>
            </div>
            <div className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.08] sm:grid-cols-2 lg:grid-cols-4">
              <Journey href="/servers" number="01" icon={<Compass />} title="주제 탐색" body="장르와 에디션으로 후보를 찾습니다." />
              <Journey href="/servers?grade=Verified" number="02" icon={<ShieldCheck />} title="검증 서버" body={`${ranking.summary.verified.toLocaleString('ko-KR')}개의 검증 서버를 비교합니다.`} />
              <Journey href="/wiki/대문" number="03" icon={<BookOpen />} title="지식 준비" body="접속 전 필요한 정보를 확인합니다." />
              <Journey href="/support" number="04" icon={<MessageSquareText />} title="커뮤니티 지원" body="문제가 생기면 공식 지원과 연결됩니다." />
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

function FeaturedServer({ server, rank }: { readonly server?: ServerSummary; readonly rank?: number }) {
  const href = server ? buildServerPath(server) : '/servers';
  return <article className="rounded-2xl border border-white/15 bg-[#080d0c]/75 p-5 shadow-2xl backdrop-blur-xl lg:translate-y-16">
    <div className="flex items-center justify-between"><span className="rounded-full border border-[#35e5b7]/30 bg-[#35e5b7]/10 px-3 py-1 text-[11px] font-bold text-[#4cebbb]">{rank ? `RANK ${rank}` : 'SERVER DIRECTORY'}</span><span className="flex items-center gap-1.5 text-xs text-slate-300"><span className="h-2 w-2 rounded-full bg-[#35e5b7]" /> {server?.isOnline === false ? 'OFFLINE' : 'LIVE'}</span></div>
    <p className="mt-8 text-xs font-semibold uppercase tracking-[.15em] text-slate-400">이번 주 추천 탐색</p>
    <h2 className="mt-2 text-2xl font-extrabold">{server?.name ?? '검증된 서버를 만나보세요'}</h2>
    <p className="mt-3 line-clamp-3 text-sm leading-6 text-slate-300">{server?.shortDescription ?? '투표 수만 보지 않고 운영 정보, 검증 상태와 리뷰 신뢰도를 함께 비교할 수 있습니다.'}</p>
    {server ? <div className="mt-4 flex flex-wrap gap-2">{server.tags.slice(0, 3).map(tag => <span key={tag} className="rounded-md bg-white/[.07] px-2.5 py-1 text-[11px] text-slate-300">{tag}</span>)}</div> : null}
    <div className="mt-6 grid grid-cols-2 gap-2 border-y border-white/[.08] py-4 text-xs text-slate-400"><span className="flex items-center gap-2"><Vote className="h-4 w-4 text-[#35e5b7]" /> 24시간 {server?.votes24h.toLocaleString('ko-KR') ?? '랭킹'}</span><span className="flex items-center gap-2"><Users className="h-4 w-4 text-[#35e5b7]" /> {server ? `${server.playersOnline ?? 0}명 접속` : '실시간 상태'}</span></div>
    <Link href={href} className="mt-5 flex h-12 items-center justify-center gap-2 rounded-xl bg-[#35e5b7] text-sm font-bold text-[#06110d] transition hover:bg-[#55edc1]">{server ? '서버 정보 보기' : '서버 랭킹 둘러보기'} <ArrowRight className="h-4 w-4" /></Link>
  </article>;
}

function QuickLink({ href, children }: { readonly href: string; readonly children: React.ReactNode }) { return <Link href={href} className="rounded-md border border-white/10 bg-black/25 px-2.5 py-1 text-slate-300 hover:border-[#35e5b7]/40 hover:text-white">{children}</Link>; }
function KnowledgeLink({ href, icon, title, body }: { readonly href: string; readonly icon: React.ReactElement; readonly title: string; readonly body: string }) { return <Link href={href} className="group flex items-center gap-3 py-4"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/[.06] text-[#35e5b7] [&>svg]:h-4 [&>svg]:w-4">{icon}</span><span className="min-w-0 flex-1"><span className="block text-sm font-semibold group-hover:text-[#35e5b7]">{title}</span><span className="block truncate text-xs text-slate-500">{body}</span></span><ChevronRight className="h-4 w-4 text-slate-600" /></Link>; }
function Journey({ href, number, icon, title, body }: { readonly href: string; readonly number: string; readonly icon: React.ReactElement; readonly title: string; readonly body: string }) { return <Link href={href} className="group relative bg-[#0b1013] p-6 transition hover:bg-[#0e1716]"><span className="absolute right-5 top-4 font-mono text-xs text-slate-600">{number}</span><span className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#35e5b7]/20 bg-[#35e5b7]/[.07] text-[#35e5b7] [&>svg]:h-5 [&>svg]:w-5">{icon}</span><h3 className="mt-5 font-bold group-hover:text-[#35e5b7]">{title}</h3><p className="mt-2 text-sm leading-6 text-slate-400">{body}</p></Link>; }

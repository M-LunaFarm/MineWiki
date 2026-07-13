import Link from 'next/link';
import {
  ArrowLeft,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileText,
  List,
  PencilLine,
  History,
  ShieldCheck,
  Trophy,
} from 'lucide-react';

import type { WikiPageResponse } from '../../lib/wiki-api';
import { ServerWikiCreateLink } from './server-wiki-create-link';

interface ServerWikiArticleViewProps {
  readonly page: WikiPageResponse;
  readonly routePath: string;
}

export function ServerWikiArticleView({ page, routePath }: ServerWikiArticleViewProps) {
  const wiki = page.serverWiki;
  if (!wiki) return null;

  const updatedAt = new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(new Date(page.updatedAt));
  const currentIndex = wiki.navigation.findIndex((item) => item.current);
  const previous = currentIndex > 0 ? wiki.navigation[currentIndex - 1] : null;
  const next = currentIndex >= 0 ? wiki.navigation[currentIndex + 1] ?? null : null;
  const address = wiki.host ? `${wiki.host}${wiki.port && wiki.port !== 25565 ? `:${wiki.port}` : ''}` : null;
  const isHandbook = wiki.layout === 'handbook';
  const isBrand = wiki.layout === 'brand';
  const gridClass = isBrand
    ? 'lg:grid-cols-[252px_minmax(0,1fr)] 2xl:grid-cols-[252px_minmax(0,1fr)_278px]'
    : isHandbook
      ? 'lg:grid-cols-[292px_minmax(0,1fr)] 2xl:grid-cols-[292px_minmax(0,1fr)_292px]'
      : 'lg:grid-cols-[330px_minmax(0,1fr)] 2xl:grid-cols-[330px_minmax(0,1fr)_292px]';

  return (
    <main className="server-wiki-layout min-h-[calc(100vh-4rem)] bg-[#0b0e12] text-slate-200">
      <div className={`mx-auto grid w-full max-w-[1600px] grid-cols-[minmax(0,1fr)] ${gridClass}`}>
        <aside className="min-w-0 border-white/10 lg:sticky lg:top-16 lg:h-[calc(100vh-4rem)] lg:border-r">
          <div className="border-b border-white/10 px-6 py-7">
            <div className="flex items-center gap-3">
              {isHandbook ? <span className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-2 text-emerald-300"><BookOpen className="size-5" /></span> : null}
              <p className="font-display text-lg font-bold text-white">{wiki.name}{isHandbook ? ` ${page.displayTitle.endsWith('대문') ? '대문' : ''}` : ''}</p>
            </div>
            <p className="mt-1 text-sm text-slate-500">서버 핸드북</p>
            <div className="mt-4 flex items-center justify-between gap-3 text-xs">
              <span className={wiki.isOnline ? 'text-emerald-300' : 'text-slate-500'}>
                <span className={`mr-2 inline-block size-2 rounded-full ${wiki.isOnline ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                {wiki.isOnline ? '온라인' : wiki.isOnline === false ? '오프라인' : '확인 중'}
              </span>
              <span className="text-slate-400">
                {wiki.playersOnline !== null && wiki.playersMax !== null
                  ? `${wiki.playersOnline} / ${wiki.playersMax}`
                  : wiki.supportedVersions ?? wiki.edition}
              </span>
            </div>
          </div>

          <nav className="px-4 py-3 lg:py-5" aria-label={`${wiki.name} 위키 문서`}>
            <div className="hidden items-center gap-2 px-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 lg:flex">
              <BookOpen className="size-4" />
              서버 핸드북
            </div>
            <div className="flex gap-2 overflow-x-auto lg:mt-3 lg:block lg:space-y-1">
              {wiki.navigation.map((item) => (
                <Link
                  key={item.id}
                  href={item.path}
                  aria-current={item.current ? 'page' : undefined}
                  className={`flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition lg:w-full ${
                    item.current
                      ? 'bg-emerald-400/10 font-semibold text-emerald-300'
                      : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-100'
                  }`}
                >
                  <FileText className="size-4 shrink-0" />
                  <span className="truncate">{item.title}</span>
                </Link>
              ))}
            </div>
            <div className="mt-3">
              <ServerWikiCreateLink serverSlug={wiki.slug} />
            </div>
            {isBrand ? <div className="mt-5 hidden space-y-4 border-l border-white/10 pl-5 text-sm text-slate-500 lg:block"><div><p className="font-semibold text-slate-300">서버 정보</p><ul className="mt-2 space-y-2 text-xs"><li>주소 · {address ?? '정보 없음'}</li><li>에디션 · {wiki.edition}</li><li>지원 버전 · {wiki.supportedVersions ?? '정보 없음'}</li></ul></div><div><p className="font-semibold text-slate-300">참여 안내</p></div></div> : null}
          </nav>

          <div className="hidden px-6 pb-6 lg:absolute lg:inset-x-0 lg:bottom-0 lg:block">
            <Link
              href={page.serverDirectoryPath ?? '/servers'}
              className="flex items-center justify-center gap-2 rounded-lg border border-white/10 px-4 py-3 text-sm text-slate-400 transition hover:border-white/20 hover:text-white"
            >
              <ArrowLeft className="size-4" />
              서버 목록으로 돌아가기
            </Link>
          </div>
        </aside>

        <article className="min-w-0 px-5 py-8 sm:px-9 lg:px-12 lg:py-12 xl:px-16">
          <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
            <Link href="/" className="hover:text-emerald-300">MineWiki</Link>
            <span>/</span>
            <span>server</span>
            <span>/</span>
            <span className="text-slate-300">{page.displayTitle}</span>
          </nav>

          <header className="mt-7 border-b border-white/10 pb-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <h1 className="font-display text-3xl font-extrabold tracking-tight text-white sm:text-5xl">
                {page.displayTitle}
              </h1>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`${routePath}/history`}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-400 transition hover:border-emerald-300/40 hover:text-emerald-200"
                >
                  <History className="size-4" />
                  역사
                </Link>
                <Link
                  href={`${routePath}/edit`}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-400 transition hover:border-emerald-300/40 hover:text-emerald-200"
                >
                  <PencilLine className="size-4" />
                  편집
                </Link>
              </div>
            </div>
            <p className="mt-5 text-sm text-slate-500">{routePath} · 최근 수정 {updatedAt}</p>
            {isHandbook ? <Link href={page.serverDirectoryPath ?? '/servers'} className="mt-8 inline-flex items-center gap-2 text-sm font-semibold text-emerald-300 hover:text-emerald-200"><ArrowLeft className="size-4" />서버 목록으로 돌아가기</Link> : null}
          </header>

          {address && !isHandbook ? (
            isBrand ? (
              <section className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-white/10 border-l-4 border-l-emerald-400 bg-white/[0.025] px-6 py-5 text-sm">
                <span className="font-mono font-semibold text-emerald-300">{address}</span><span className="text-slate-600">•</span><span>에디션: {wiki.edition}</span><span className="text-slate-600">•</span><span>지원 버전: {wiki.supportedVersions ?? '정보 없음'}</span>
              </section>
            ) : (
            <section className="mt-8 grid gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-5 sm:grid-cols-3">
              <Info label="접속 주소" value={address} />
              <Info label="에디션" value={wiki.edition} />
              <Info label="지원 버전" value={wiki.supportedVersions ?? '정보 없음'} />
            </section>
            )
          ) : null}

          <div className="server-wiki-rendered wiki-rendered mt-8 border-0 bg-transparent px-0 py-0" dangerouslySetInnerHTML={{ __html: page.html }} />

          <div className="mt-12 grid overflow-hidden rounded-xl border border-white/10 sm:grid-cols-2">
            <WikiPager item={previous} direction="previous" />
            <WikiPager item={next} direction="next" />
          </div>
        </article>

        <aside className="hidden border-l border-white/10 px-8 py-12 2xl:block">
          <div className="sticky top-28 space-y-8">
            <section>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-300"><List className="size-4" />이 페이지</h2>
              <nav className="mt-4 space-y-2 border-l border-white/10 pl-4 text-sm" aria-label="문서 목차">
                {(page.headings?.length ?? 0) > 0 ? page.headings.map((heading) => (
                  <a
                    key={`${heading.anchor}-${heading.level}`}
                    href={`#${encodeURIComponent(heading.anchor)}`}
                    className={`block text-slate-400 transition hover:text-emerald-300 ${heading.level > 2 ? 'pl-3 text-xs' : ''}`}
                  >
                    {heading.title}
                  </a>
                )) : <span className="text-slate-600">목차가 없습니다.</span>}
              </nav>
            </section>
            <div className="border-t border-white/10" />
            {!isHandbook ? <section className="rounded-xl border border-white/10 p-5">
              <div className="flex items-start gap-3">
                <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 p-2.5 text-emerald-300"><Trophy className="size-5" /></span>
                <div>
                  <h2 className="font-semibold text-white">{wiki.name}를 응원해 주세요</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-500">서버 순위와 리뷰는 더 많은 유저가 서버를 발견하도록 돕습니다.</p>
                </div>
              </div>
              <Link href={page.serverDirectoryPath ?? '/servers'} className="mt-5 flex items-center justify-center gap-2 rounded-lg border border-emerald-400/60 px-4 py-2.5 text-sm font-semibold text-emerald-300 transition hover:bg-emerald-400/10">
                <ShieldCheck className="size-4" />{isBrand ? '서버 디렉터리에서 보기' : '서버 순위 / 투표하기'}
              </Link>
            </section> : null}
            <p className="text-xs text-slate-600">업데이트: {updatedAt}</p>
          </div>
        </aside>
      </div>
    </main>
  );
}

function Info({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p><p className="mt-2 break-all text-sm font-medium text-slate-200">{value}</p></div>;
}

function WikiPager({ item, direction }: { readonly item: { title: string; path: string } | null; readonly direction: 'previous' | 'next' }) {
  const next = direction === 'next';
  if (!item) return <div className={`min-h-24 p-5 ${next ? 'border-t border-white/10 sm:border-l sm:border-t-0' : ''}`}><p className="text-xs text-slate-600">{next ? '다음 문서' : '이전 문서'}</p><p className="mt-2 text-sm text-slate-600">없음</p></div>;
  return <Link href={item.path} className={`flex min-h-24 items-center gap-3 p-5 transition hover:bg-white/[0.03] ${next ? 'justify-between border-t border-white/10 text-right sm:border-l sm:border-t-0' : ''}`}>{!next ? <ChevronLeft className="size-5 text-slate-500" /> : null}<div><p className="text-xs text-slate-500">{next ? '다음 문서' : '이전 문서'}</p><p className="mt-2 font-semibold text-emerald-300">{item.title}</p></div>{next ? <ChevronRight className="size-5 text-slate-500" /> : null}</Link>;
}

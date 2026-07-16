import Link from 'next/link';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  List,
  PencilLine,
  History,
  ShieldCheck,
  Trophy,
} from 'lucide-react';

import type { WikiPageResponse } from '../../lib/wiki-api';
import { fetchServerWikiPresentation } from '../../lib/wiki-server-api';
import { ServerWikiSidebar } from './server-wiki-sidebar';
import { WikiPageTools } from './wiki-page-tools';
import { buildServerWikiToolPath } from '../../lib/wiki-routes.mjs';
import { WikiDynamicTimeHydrator } from './wiki-dynamic-time-hydrator';

interface ServerWikiArticleViewProps {
  readonly page: WikiPageResponse;
  readonly routePath: string;
}

export async function ServerWikiArticleView({ page, routePath }: ServerWikiArticleViewProps) {
  const wiki = page.serverWiki;
  if (!wiki) return null;
  const presentation = await fetchServerWikiPresentation(wiki.slug);
  const contentId = `wiki-content-${page.id}`;

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
  const editPath = buildServerWikiToolPath(routePath, 'edit');

  return (
    <main className="server-wiki-layout min-h-[calc(100vh-4rem)] bg-[#0b0e12] text-slate-200">
      <div className={`mx-auto grid w-full max-w-[1600px] grid-cols-[minmax(0,1fr)] ${gridClass}`}>
        <ServerWikiSidebar page={page} />

        <article className="min-w-0 px-5 py-8 sm:px-9 lg:px-12 lg:py-12 xl:px-16">
          <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
            <Link href="/wiki/%EB%8C%80%EB%AC%B8" className="hover:text-emerald-300">MineWiki</Link>
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
                  href={buildServerWikiToolPath(routePath, 'history')}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-400 transition hover:border-emerald-300/40 hover:text-emerald-200"
                >
                  <History className="size-4" />
                  역사
                </Link>
                <Link
                  href={editPath}
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

          {presentation?.topNoticeHtml ? (
            <aside
              className="server-wiki-notice wiki-rendered mt-8 rounded-xl border border-emerald-400/25 border-l-4 border-l-emerald-400 bg-emerald-400/[0.06] px-5 py-4 text-sm text-slate-300"
              role="note"
              aria-label="서버 위키 상단 안내"
              dangerouslySetInnerHTML={{ __html: presentation.topNoticeHtml }}
            />
          ) : null}

          {page.headings.length > 0 ? (
            <details className="mt-8 rounded-xl border border-white/10 p-4 2xl:hidden">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-slate-300">섹션 목차·편집</summary>
              <ul className="mt-3 space-y-1">
                {page.headings.map((heading, index) => (
                  <li key={`${heading.anchor}-mobile-${index}`} className="flex items-center gap-2 text-sm">
                    <a href={`#${encodeURIComponent(heading.anchor)}`} className="min-h-11 min-w-0 flex-1 py-3 text-slate-400 hover:text-emerald-300">{heading.title}</a>
                    <Link href={`${editPath}?section=${encodeURIComponent(heading.anchor)}`} className="grid size-11 shrink-0 place-items-center rounded text-slate-500 hover:bg-white/[0.05] hover:text-emerald-200" aria-label={`${heading.title} 섹션 편집`}><PencilLine className="size-3.5" /></Link>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <div id={contentId} className="server-wiki-rendered wiki-rendered mt-8 border-0 bg-transparent px-0 py-0" dangerouslySetInnerHTML={{ __html: page.html }} />
          <WikiDynamicTimeHydrator targetId={contentId} revisionId={page.revision.id} />

          {presentation?.bottomNoticeHtml ? (
            <aside
              className="server-wiki-notice wiki-rendered mt-8 rounded-xl border border-white/10 bg-white/[0.025] px-5 py-4 text-sm text-slate-400"
              role="note"
              aria-label="서버 위키 하단 안내"
              dangerouslySetInnerHTML={{ __html: presentation.bottomNoticeHtml }}
            />
          ) : null}

          <div className="mt-12 grid overflow-hidden rounded-xl border border-white/10 sm:grid-cols-2">
            <WikiPager item={previous} direction="previous" />
            <WikiPager item={next} direction="next" />
          </div>
          <div className="mt-8">
            <WikiPageTools
              pageId={page.id}
              namespace={page.namespace}
              spaceId={page.spaceId}
              title={page.title}
              displayTitle={page.displayTitle}
              routePath={routePath}
            />
          </div>
        </article>

        <aside className="hidden border-l border-white/10 px-8 py-12 2xl:block">
          <div className="sticky top-28 space-y-8">
            <section>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-300"><List className="size-4" />이 페이지</h2>
              <nav className="mt-4 space-y-2 border-l border-white/10 pl-4 text-sm" aria-label="문서 목차">
                {(page.headings?.length ?? 0) > 0 ? page.headings.map((heading) => (
                  <span key={`${heading.anchor}-${heading.level}`} className={`flex items-center gap-2 ${heading.level > 2 ? 'pl-3 text-xs' : ''}`}>
                    <a href={`#${encodeURIComponent(heading.anchor)}`} className="min-w-0 flex-1 truncate text-slate-400 transition hover:text-emerald-300">{heading.title}</a>
                    <Link href={`${editPath}?section=${encodeURIComponent(heading.anchor)}`} className="rounded p-1 text-slate-600 hover:bg-white/[0.05] hover:text-emerald-200" aria-label={`${heading.title} 섹션 편집`}><PencilLine className="size-3" /></Link>
                  </span>
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

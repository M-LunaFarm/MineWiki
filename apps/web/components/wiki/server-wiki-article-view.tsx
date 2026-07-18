import Link from 'next/link';
import {
  ArrowRight,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  List,
  PencilLine,
  History,
} from 'lucide-react';

import type { WikiPageResponse } from '../../lib/wiki-api';
import { fetchServerWikiNavigation, fetchServerWikiPresentation } from '../../lib/wiki-server-api';
import { ServerWikiSidebar } from './server-wiki-sidebar';
import { ServerWikiHeader } from './server-wiki-header';
import { WikiPageTools } from './wiki-page-tools';
import { buildServerWikiToolPath } from '../../lib/wiki-routes.mjs';
import { WikiDynamicTimeHydrator } from './wiki-dynamic-time-hydrator';
import { serverWikiDocumentTitle } from '../../lib/server-wiki-navigation.mjs';

interface ServerWikiArticleViewProps {
  readonly page: WikiPageResponse;
  readonly routePath: string;
}

export async function ServerWikiArticleView({ page, routePath }: ServerWikiArticleViewProps) {
  const wiki = page.serverWiki;
  if (!wiki) return null;
  const [presentation, navigationResponse] = await Promise.all([
    fetchServerWikiPresentation(wiki.contentSlug),
    fetchServerWikiNavigation(wiki.contentSlug, wiki.navigationKey).catch(() => null),
  ]);
  const navigation = (navigationResponse?.items ?? wiki.navigation).map((item) => ({
    ...item,
    current: item.kind === 'page' && item.id === page.id,
  }));
  const pageWithNavigation: WikiPageResponse = {
    ...page,
    serverWiki: { ...wiki, navigation },
  };
  const contentId = `wiki-content-${page.id}`;
  const documentTitle = serverWikiDocumentTitle(page.displayTitle, [wiki.slug, wiki.contentSlug], wiki.name);

  const updatedAt = new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(new Date(page.updatedAt));
  const pageNavigation = navigation.filter((item) => item.kind === 'page' && item.path !== null);
  const currentIndex = pageNavigation.findIndex((item) => item.current);
  const previous = wiki.previousDocument ?? (currentIndex > 0 ? pageNavigation[currentIndex - 1] : null);
  const next = wiki.nextDocument ?? (currentIndex >= 0 ? pageNavigation[currentIndex + 1] ?? null : null);
  const address = wiki.host ? `${wiki.host}${wiki.port && wiki.port !== 25565 ? `:${wiki.port}` : ''}` : null;
  const isHandbook = wiki.layout === 'handbook';
  const isBrand = wiki.layout === 'brand';
  const gridClass = isBrand
    ? 'lg:grid-cols-[252px_minmax(0,1fr)] 2xl:grid-cols-[252px_minmax(0,1fr)_278px]'
    : isHandbook
      ? 'lg:grid-cols-[292px_minmax(0,1fr)] 2xl:grid-cols-[292px_minmax(0,1fr)_292px]'
      : 'lg:grid-cols-[330px_minmax(0,1fr)] 2xl:grid-cols-[330px_minmax(0,1fr)_292px]';
  const editPath = buildServerWikiToolPath(routePath, 'edit');
  const isWikiHome = currentIndex === 0;
  const startHereDocuments = isWikiHome
    ? pageNavigation.filter((item) => !item.current).slice(0, 6)
    : [];

  return (
    <div className="server-wiki-layout min-h-screen bg-white text-[#333]">
      <ServerWikiHeader page={pageWithNavigation} />
      {wiki.publicationStatus !== 'published' ? (
        <aside className="border-y border-amber-300/40 bg-amber-50 px-4 py-3 text-center text-sm font-semibold text-amber-950" role="status">
          {wiki.publicationStatus === 'draft' ? '초안 미리보기' : '비공개 미리보기'} · 권한이 있는 협업자에게만 표시됩니다.
        </aside>
      ) : null}
      <main className={`mx-auto grid w-full max-w-[1440px] grid-cols-[minmax(0,1fr)] ${gridClass}`}>
        <ServerWikiSidebar page={pageWithNavigation} />

        <article className="min-w-0 px-5 py-8 sm:px-9 lg:px-12 lg:py-12 xl:px-16">
          <nav className="flex flex-wrap items-center gap-2 text-sm text-[#777]">
            <Link href={`/serverWiki/${encodeURIComponent(wiki.slug)}`} className="hover:text-[#346ddb]">{wiki.name} 위키</Link>
            <span>/</span>
            <span className="text-[#333]">{documentTitle}</span>
          </nav>

          <header className="mt-7 border-b border-[#e8e8e8] pb-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <h1 className="text-3xl font-bold tracking-tight text-[#1f1f1f] sm:text-5xl">
                {documentTitle}
              </h1>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={buildServerWikiToolPath(routePath, 'history')}
                  className="inline-flex items-center gap-2 rounded-lg border border-[#dedede] px-3 py-2 text-sm text-[#666] transition hover:border-[#b8c9ed] hover:bg-[#f7f9ff] hover:text-[#2458bd]"
                >
                  <History className="size-4" />
                  역사
                </Link>
                <Link
                  href={editPath}
                  className="inline-flex items-center gap-2 rounded-lg border border-[#dedede] px-3 py-2 text-sm text-[#666] transition hover:border-[#b8c9ed] hover:bg-[#f7f9ff] hover:text-[#2458bd]"
                >
                  <PencilLine className="size-4" />
                  편집
                </Link>
              </div>
            </div>
            <p className="mt-5 text-sm text-[#888]">{routePath} · 최근 수정 {updatedAt}</p>
          </header>

          {address && !isHandbook ? (
            isBrand ? (
              <section className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-[#dedede] border-l-4 border-l-[#346ddb] bg-[#fafafa] px-6 py-5 text-sm">
                <span className="font-mono font-semibold text-[#2458bd]">{address}</span><span className="text-[#aaa]">•</span><span>에디션: {wiki.edition}</span><span className="text-[#aaa]">•</span><span>지원 버전: {wiki.supportedVersions ?? '정보 없음'}</span>
              </section>
            ) : (
            <section className="mt-8 grid gap-3 rounded-xl border border-[#e2e2e2] bg-[#fafafa] p-5 sm:grid-cols-3">
              <Info label="접속 주소" value={address} />
              <Info label="에디션" value={wiki.edition} />
              <Info label="지원 버전" value={wiki.supportedVersions ?? '정보 없음'} />
            </section>
            )
          ) : null}

          {presentation?.topNoticeHtml ? (
            <aside
              className="server-wiki-notice wiki-rendered mt-8 rounded-xl border border-[#cbd9f6] border-l-4 border-l-[#346ddb] bg-[#f5f8ff] px-5 py-4 text-sm text-[#444]"
              role="note"
              aria-label="서버 위키 상단 안내"
              dangerouslySetInnerHTML={{ __html: presentation.topNoticeHtml }}
            />
          ) : null}

          {page.headings.length > 0 ? (
            <details className="mt-6 border-y border-[#e8e8e8] 2xl:hidden">
              <summary className="flex min-h-12 cursor-pointer items-center gap-2 py-2 text-sm font-semibold text-[#444]">
                <List className="size-4 text-[#777]" aria-hidden="true" />
                <span>이 페이지에서 찾기</span>
                <span className="ml-auto text-xs font-normal text-[#888]">{page.headings.length}개 섹션</span>
              </summary>
              <ul className="space-y-1 border-t border-[#ededed] py-3">
                {page.headings.map((heading, index) => (
                  <li key={`${heading.anchor}-mobile-${index}`} className="flex items-center gap-2 text-sm">
                    <a href={`#${encodeURIComponent(heading.anchor)}`} className="min-h-11 min-w-0 flex-1 py-3 text-[#666] hover:text-[#346ddb]">{heading.title}</a>
                    <Link href={`${editPath}?section=${encodeURIComponent(heading.anchor)}`} className="grid size-11 shrink-0 place-items-center rounded text-[#888] hover:bg-[#f3f3f3] hover:text-[#346ddb]" aria-label={`${heading.title} 섹션 편집`}><PencilLine className="size-3.5" /></Link>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <div id={contentId} className="server-wiki-rendered wiki-rendered mt-8 border-0 bg-transparent px-0 py-0" dangerouslySetInnerHTML={{ __html: page.html }} />
          <WikiDynamicTimeHydrator targetId={contentId} revisionId={page.revision.id} />

          {startHereDocuments.length > 0 ? (
            <section className="mt-10 border-t border-[#e8e8e8] pt-8" aria-labelledby="server-wiki-start-here-title">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[#eef3ff] text-[#346ddb]"><BookOpen className="size-4" aria-hidden="true" /></span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#346ddb]">Start here</p>
                  <h2 id="server-wiki-start-here-title" className="mt-1 text-2xl font-bold text-[#222]">{wiki.name} 문서에서 찾기</h2>
                  <p className="mt-2 text-sm leading-6 text-[#777]">서버에 참여하기 전에 필요한 안내와 작성 상태를 문서별로 확인하세요.</p>
                </div>
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {startHereDocuments.map((item, index) => (
                  <Link key={item.id} href={item.path} className="group flex min-h-24 items-center gap-4 rounded-xl border border-[#e2e2e2] bg-white p-4 transition hover:border-[#b8c9ed] hover:bg-[#f8faff]">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[#f2f2f2] text-xs font-bold text-[#777] group-hover:text-[#346ddb]">{String(index + 1).padStart(2, '0')}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate font-semibold text-[#333] group-hover:text-[#1f1f1f]">{item.title}</span><span className="mt-1 block text-xs text-[#888]">서버 운영 문서</span></span>
                    <ArrowRight className="size-4 shrink-0 text-[#999] group-hover:text-[#346ddb]" aria-hidden="true" />
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          {presentation?.bottomNoticeHtml ? (
            <aside
              className="server-wiki-notice wiki-rendered mt-8 rounded-xl border border-[#e2e2e2] bg-[#fafafa] px-5 py-4 text-sm text-[#666]"
              role="note"
              aria-label="서버 위키 하단 안내"
              dangerouslySetInnerHTML={{ __html: presentation.bottomNoticeHtml }}
            />
          ) : null}

          <div className="mt-12 grid overflow-hidden rounded-xl border border-[#e2e2e2] sm:grid-cols-2">
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
              pageType={page.pageType}
              currentRevisionId={page.revision.id}
              routePath={routePath}
            />
          </div>
        </article>

        <aside className="hidden border-l border-[#ededed] px-8 py-12 2xl:block">
          <div className="sticky top-28 space-y-8">
            <section>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-[#444]"><List className="size-4" />이 페이지</h2>
              <nav className="mt-4 space-y-2 border-l border-[#e2e2e2] pl-4 text-sm" aria-label="문서 목차">
                {(page.headings?.length ?? 0) > 0 ? page.headings.map((heading) => (
                  <span key={`${heading.anchor}-${heading.level}`} className={`flex items-center gap-2 ${heading.level > 2 ? 'pl-3 text-xs' : ''}`}>
                    <a href={`#${encodeURIComponent(heading.anchor)}`} className="min-w-0 flex-1 truncate text-[#666] transition hover:text-[#346ddb]">{heading.title}</a>
                    <Link href={`${editPath}?section=${encodeURIComponent(heading.anchor)}`} className="rounded p-1 text-[#999] hover:bg-[#f3f3f3] hover:text-[#346ddb]" aria-label={`${heading.title} 섹션 편집`}><PencilLine className="size-3" /></Link>
                  </span>
                )) : <span className="text-[#999]">목차가 없습니다.</span>}
              </nav>
            </section>
            <div className="border-t border-[#e8e8e8]" />
            <p className="text-xs text-[#888]">업데이트: {updatedAt}</p>
          </div>
        </aside>
      </main>
    </div>
  );
}

function Info({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><p className="text-xs font-semibold uppercase tracking-wider text-[#777]">{label}</p><p className="mt-2 break-all text-sm font-medium text-[#333]">{value}</p></div>;
}

function WikiPager({ item, direction }: { readonly item: { title: string; path: string } | null; readonly direction: 'previous' | 'next' }) {
  const next = direction === 'next';
  if (!item) return <div className={`min-h-24 p-5 ${next ? 'border-t border-[#e2e2e2] sm:border-l sm:border-t-0' : ''}`}><p className="text-xs text-[#888]">{next ? '다음 문서' : '이전 문서'}</p><p className="mt-2 text-sm text-[#999]">없음</p></div>;
  return <Link href={item.path} className={`flex min-h-24 items-center gap-3 p-5 transition hover:bg-[#fafafa] ${next ? 'justify-between border-t border-[#e2e2e2] text-right sm:border-l sm:border-t-0' : ''}`}>{!next ? <ChevronLeft className="size-5 text-[#888]" /> : null}<div><p className="text-xs text-[#777]">{next ? '다음 문서' : '이전 문서'}</p><p className="mt-2 font-semibold text-[#346ddb]">{item.title}</p></div>{next ? <ChevronRight className="size-5 text-[#888]" /> : null}</Link>;
}

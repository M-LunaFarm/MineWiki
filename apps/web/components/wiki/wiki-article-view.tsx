import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronDown, Clock3, FileText, FolderClosed, History, ListTree, MessageSquareText, Pencil, PencilLine, Star, Wrench } from 'lucide-react';
import type { WikiPageResponse, WikiRecentChangeSummary } from '../../lib/wiki-api';
import { buildCategoryWikiToolPath, buildServerWikiToolPath, buildStandardWikiToolPath, buildWikiHistoryPath, buildWikiRevisionPath } from '../../lib/wiki-routes.mjs';
import { WikiPageTools } from './wiki-page-tools';
import { WikiDynamicTimeHydrator } from './wiki-dynamic-time-hydrator';
import { WikiReaderInteractionHydrator } from './wiki-reader-interaction-hydrator';
import { rewriteWikiRenderedMedia } from '../../lib/wiki-rendered-media.mjs';

interface WikiArticleViewProps {
  readonly page: WikiPageResponse;
  readonly routePath: string;
  readonly beforeContent?: ReactNode;
  readonly afterContent?: ReactNode;
  readonly recentChanges?: readonly WikiRecentChangeSummary[];
}

export function WikiArticleView({ page, routePath, beforeContent, afterContent, recentChanges = [] }: WikiArticleViewProps) {
  const contentId = `wiki-content-${page.id}`;
  const isCategoryDocument = routePath.startsWith('/wiki/category/');
  const editPath = routePath.startsWith('/server/') || routePath.startsWith('/serverWiki/')
    ? buildServerWikiToolPath(routePath, 'edit')
    : isCategoryDocument
      ? buildCategoryWikiToolPath(routePath, 'edit')
      : buildStandardWikiToolPath(routePath, 'edit');
  const historyPath = buildWikiHistoryPath(routePath);
  const discussionPath = routePath.startsWith('/server/') || routePath.startsWith('/serverWiki/')
    ? buildServerWikiToolPath(routePath, 'discuss')
    : `/wiki/discuss/${encodeURIComponent(page.id)}?returnTo=${encodeURIComponent(routePath)}`;
  const updatedAt = new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul'
  }).format(new Date(page.updatedAt));

  return (
    <main className="wiki-reader-shell mx-auto flex w-full max-w-6xl flex-col gap-5 px-3 py-8 sm:px-6 lg:px-8">
      <nav aria-label="문서 경로" className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <Link href="/wiki/%EB%8C%80%EB%AC%B8" className="hover:text-emerald-200">
          MineWiki
        </Link>
        <span aria-hidden="true">/</span>
        <span className="text-slate-300">{page.namespace}</span>
        <span aria-hidden="true">/</span>
        <span aria-current="page" className="text-slate-200">{page.displayTitle}</span>
      </nav>

      {beforeContent}

      <header className="wiki-reader-heading pb-3">
        <div className="mb-3 flex flex-wrap gap-2">
          <span className="chip chip-accent">{page.namespace}</span>
          <span className="chip chip-muted">rev {page.revision.revisionNo}</span>
          <span className="chip chip-muted">{protectionLabel(page.protectionLevel)}</span>
        </div>
        {page.redirectedFrom ? (
          <div className="mb-4 rounded-md border border-sky-300/30 bg-sky-300/10 px-4 py-3 text-sm text-sky-100">
            <Link href={`${page.redirectedFrom.path}?redirect=0`} className="font-semibold text-sky-50 hover:underline">
              {page.redirectedFrom.title}
            </Link>
            에서 넘어왔습니다.
          </div>
        ) : null}
        <h1 className="max-w-4xl text-3xl font-bold tracking-[-0.025em] text-white sm:text-4xl">{page.displayTitle}</h1>
        <p className="mt-2 text-sm text-slate-400">
          최근 수정 {updatedAt}
        </p>
        {page.redirectTarget ? (
          <p className="mt-3 text-sm text-slate-300">
            넘겨주기 대상: <span className="font-semibold text-slate-100">{page.redirectTarget}</span>
          </p>
        ) : null}
      </header>

      <nav aria-label="문서 주요 작업" className="grid grid-cols-3 gap-2 lg:hidden">
        <Link href={editPath} className="chip chip-accent inline-flex min-h-11 items-center justify-center gap-1.5 px-3">
          <PencilLine className="size-3.5" /> 편집
        </Link>
        <Link href={historyPath} className="chip chip-muted inline-flex min-h-11 items-center justify-center gap-1.5 px-3">
          <History className="size-3.5" /> 역사
        </Link>
        <Link href={discussionPath} className="chip chip-muted inline-flex min-h-11 items-center justify-center gap-1.5 px-3">
          <MessageSquareText className="size-3.5" /> 토론
        </Link>
      </nav>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <article
          id={contentId}
          className="wiki-rendered wiki-mobile-full order-2 min-w-0 lg:order-1"
          dangerouslySetInnerHTML={{ __html: rewriteWikiRenderedMedia(page.html) }}
        />
        <WikiDynamicTimeHydrator targetId={contentId} revisionId={page.revision.id} />
        <WikiReaderInteractionHydrator targetId={contentId} revisionId={page.revision.id} />
        <aside className="wiki-reader-rail order-1 rounded-xl border border-white/10 bg-white/[0.025] p-3 lg:sticky lg:top-24 lg:order-2 lg:self-start" aria-label="이 문서">
          <h2 className="px-2 pb-3 pt-1 text-lg font-bold text-white">이 문서</h2>
          {page.namespace === 'server' && page.serverDirectoryPath ? (
            <Link
              href={page.serverDirectoryPath}
              className="flex items-center justify-between rounded-lg border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm font-semibold text-amber-100 transition hover:border-amber-200/70 hover:bg-amber-300/15"
            >
              서버 디렉터리
              <Star className="h-4 w-4 text-amber-100" />
            </Link>
          ) : null}
          {page.headings.length > 0 ? (
            <>
              <details className="wiki-rail-panel lg:hidden">
                <WikiTocSummary />
                <WikiTocContent headings={page.headings} editPath={editPath} keySuffix="mobile" />
              </details>
              <details className="wiki-rail-panel hidden lg:block" open>
                <WikiTocSummary />
                <WikiTocContent headings={page.headings} editPath={editPath} keySuffix="desktop" />
              </details>
            </>
          ) : null}
          <RecentChangesSidebar changes={recentChanges} />
          <details className="wiki-rail-panel">
            <summary>
              <span className="wiki-rail-panel-label"><FileText className="size-4" aria-hidden="true" />문서 정보</span>
              <span className="ml-auto text-xs font-normal text-slate-500">문서 ID {page.id}</span>
              <ChevronDown className="wiki-rail-chevron size-4" aria-hidden="true" />
            </summary>
            <div className="wiki-rail-content">
            <dl className="space-y-2 text-sm text-slate-300">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">문서 ID</dt>
                <dd>{page.id}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">상태</dt>
                <dd>{statusLabel(page.status)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">링크</dt>
                <dd>{page.links.length}</dd>
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href={editPath} className="chip chip-accent inline-flex min-h-11 items-center gap-1.5 px-3">
                <PencilLine className="h-3.5 w-3.5" />
                편집
              </Link>
              <Link href={historyPath} className="chip chip-accent min-h-11 px-3">
                역사
              </Link>
              <Link href={buildWikiRevisionPath(page.revision.id, routePath)} className="chip chip-muted min-h-11 px-3">
                현재 판
              </Link>
            </div>
            </div>
          </details>
          <details className="wiki-rail-panel">
            <summary>
              <span className="wiki-rail-panel-label"><Wrench className="size-4" aria-hidden="true" />도구</span>
              <span className="ml-auto text-xs font-normal text-slate-500">열기</span>
              <ChevronDown className="wiki-rail-chevron size-4" aria-hidden="true" />
            </summary>
            <div className="wiki-rail-content">
              <WikiPageTools
                pageId={page.id}
                namespace={page.namespace}
                spaceId={page.spaceId}
                title={page.title}
                displayTitle={page.displayTitle}
                pageType={page.pageType}
                currentRevisionId={page.revision.id}
                routePath={routePath}
                embedded
              />
            </div>
          </details>
          {page.categoryTags.length > 0 ? (
            <details className="wiki-rail-panel">
              <summary>
                <span className="wiki-rail-panel-label"><FolderClosed className="size-4" aria-hidden="true" />분류</span>
                <span className="ml-auto text-xs font-normal text-slate-500">{page.categoryTags.length}</span>
                <ChevronDown className="wiki-rail-chevron size-4" aria-hidden="true" />
              </summary>
              <div className="wiki-rail-content flex flex-wrap gap-2">
                {page.categoryTags.map((category) => (
                  <Link key={category.title} href={`/wiki/category/${encodeURIComponent(category.title)}`} className={`chip chip-muted hover:border-emerald-300/40 hover:text-emerald-100 ${category.blurred ? 'blur-sm transition-[filter] hover:blur-none focus:blur-none' : ''}`}>
                    {category.title}
                  </Link>
                ))}
              </div>
            </details>
          ) : null}
        </aside>
      </div>
      {afterContent}
    </main>
  );
}

function WikiTocSummary() {
  return (
    <summary>
      <span className="wiki-rail-panel-label"><ListTree className="size-4" aria-hidden="true" />목차</span>
      <ChevronDown className="wiki-rail-chevron size-4" aria-hidden="true" />
    </summary>
  );
}

function WikiTocContent({
  headings,
  editPath,
  keySuffix,
}: {
  readonly headings: WikiPageResponse['headings'];
  readonly editPath: string;
  readonly keySuffix: string;
}) {
  return (
    <nav className="wiki-rail-content" aria-label="문서 목차">
      <ol className="space-y-0.5 text-sm">
        {headings.map((heading, index) => (
          <li
            key={`${heading.anchor}-${keySuffix}-${index}`}
            style={{ paddingInlineStart: `${Math.max(0, heading.level - 2) * 0.75}rem` }}
          >
            <span className="flex min-w-0 items-center gap-2">
              <a href={`#${encodeURIComponent(heading.anchor)}`} className="min-w-0 flex-1 truncate text-slate-400 transition hover:text-emerald-200">
                {heading.title}
              </a>
              <Link
                href={`${editPath}?section=${encodeURIComponent(heading.anchor)}`}
                className="grid size-11 shrink-0 place-items-center rounded text-slate-600 transition hover:bg-white/[0.05] hover:text-emerald-200"
                aria-label={`${heading.title} 섹션 편집`}
                title="섹션 편집"
              >
                <Pencil className="size-3.5" />
              </Link>
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function RecentChangesSidebar({
  changes,
}: {
  readonly changes: readonly WikiRecentChangeSummary[];
}) {
  const uniqueChanges = Array.from(
    changes.reduce((items, change) => {
      if (!items.has(change.routePath)) items.set(change.routePath, change);
      return items;
    }, new Map<string, WikiRecentChangeSummary>()).values(),
  ).slice(0, 8);
  if (uniqueChanges.length === 0) return null;

  return (
    <details className="wiki-rail-panel" aria-labelledby="wiki-recent-sidebar-title">
      <summary>
        <span id="wiki-recent-sidebar-title" className="wiki-rail-panel-label">
          <Clock3 className="size-4" aria-hidden="true" />
          최근 변경
        </span>
        <span className="ml-auto rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-slate-500">{uniqueChanges.length}</span>
        <ChevronDown className="wiki-rail-chevron size-4" aria-hidden="true" />
      </summary>
      <div className="wiki-rail-content">
      <ol className="divide-y divide-white/[0.07]">
        {uniqueChanges.map((change) => (
          <li key={change.id}>
            <Link
              href={change.routePath}
              className="group flex min-h-11 items-center justify-between gap-3 py-2 text-sm"
            >
              <span className="min-w-0 truncate text-slate-300 transition group-hover:text-emerald-200">
                {change.title}
              </span>
              <time
                dateTime={change.createdAt}
                className="shrink-0 text-[11px] tabular-nums text-slate-500"
              >
                {formatRecentTime(change.createdAt)}
              </time>
            </Link>
          </li>
        ))}
      </ol>
      <Link href="/recent" className="mt-3 inline-flex min-h-11 items-center text-xs font-semibold text-emerald-300 hover:text-emerald-200">
        전체 변경 보기
      </Link>
      </div>
    </details>
  );
}

function formatRecentTime(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Seoul',
  }).format(new Date(value));
}

function protectionLabel(value: string): string {
  const labels: Record<string, string> = { open: '누구나 편집', login_required: '로그인 필요', review_required: '검토 후 반영', autoconfirmed_only: '자동 인증 사용자', trusted_only: '신뢰 사용자', official_only: '공식 편집자', owner_only: '소유자만', admin_only: '관리자만', locked: '편집 잠김' };
  return labels[value] ?? '사용자 지정 보호';
}

function statusLabel(value: string): string {
  const labels: Record<string, string> = { normal: '공개', active: '공개', published: '공개', hidden: '숨김', deleted: '삭제됨' };
  return labels[value] ?? '알 수 없음';
}

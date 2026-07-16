import Link from 'next/link';
import type { ReactNode } from 'react';
import { Pencil, PencilLine, Star } from 'lucide-react';
import type { WikiPageResponse } from '../../lib/wiki-api';
import { buildCategoryWikiToolPath, buildServerWikiToolPath, buildStandardWikiToolPath, buildWikiHistoryPath, buildWikiRevisionPath } from '../../lib/wiki-routes.mjs';
import { WikiPageTools } from './wiki-page-tools';
import { WikiDynamicTimeHydrator } from './wiki-dynamic-time-hydrator';

interface WikiArticleViewProps {
  readonly page: WikiPageResponse;
  readonly routePath: string;
  readonly beforeContent?: ReactNode;
  readonly afterContent?: ReactNode;
}

export function WikiArticleView({ page, routePath, beforeContent, afterContent }: WikiArticleViewProps) {
  const contentId = `wiki-content-${page.id}`;
  const isCategoryDocument = routePath.startsWith('/wiki/category/');
  const editPath = routePath.startsWith('/server/')
    ? buildServerWikiToolPath(routePath, 'edit')
    : isCategoryDocument
      ? buildCategoryWikiToolPath(routePath, 'edit')
      : buildStandardWikiToolPath(routePath, 'edit');
  const historyPath = buildWikiHistoryPath(routePath);
  const updatedAt = new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul'
  }).format(new Date(page.updatedAt));

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
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

      <header className="border-b border-white/10 pb-6">
        <div className="mb-4 flex flex-wrap gap-2">
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
        <h1 className="max-w-4xl text-3xl font-bold text-white sm:text-4xl">{page.displayTitle}</h1>
        <p className="mt-3 text-sm text-slate-400">
          최근 수정 {updatedAt}
        </p>
        {page.redirectTarget ? (
          <p className="mt-3 text-sm text-slate-300">
            넘겨주기 대상: <span className="font-semibold text-slate-100">{page.redirectTarget}</span>
          </p>
        ) : null}
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        {page.headings.length > 0 ? (
          <details className="surface-flat p-4 lg:hidden">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-white">목차·섹션 편집</summary>
            <ol className="mt-3 space-y-1 text-sm">
              {page.headings.map((heading, index) => <li key={`${heading.anchor}-mobile-${index}`} style={{ paddingInlineStart: `${Math.max(0, heading.level - 2) * 0.75}rem` }} className="flex min-w-0 items-center gap-2"><a href={`#${encodeURIComponent(heading.anchor)}`} className="min-h-11 min-w-0 flex-1 py-3 text-slate-400 hover:text-emerald-200">{heading.title}</a><Link href={`${editPath}?section=${encodeURIComponent(heading.anchor)}`} className="grid size-11 shrink-0 place-items-center rounded text-slate-500 hover:bg-white/[0.05] hover:text-emerald-200" aria-label={`${heading.title} 섹션 편집`}><Pencil className="size-4" /></Link></li>)}
            </ol>
          </details>
        ) : null}
        <article
          id={contentId}
          className="wiki-rendered min-w-0"
          dangerouslySetInnerHTML={{ __html: page.html }}
        />
        <WikiDynamicTimeHydrator targetId={contentId} revisionId={page.revision.id} />
        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
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
            <nav className="surface-flat hidden p-4 lg:block" aria-label="문서 목차">
              <h2 className="text-sm font-semibold text-white">목차</h2>
              <ol className="mt-3 space-y-1.5 text-sm">
                {page.headings.map((heading, index) => (
                  <li
                    key={`${heading.anchor}-${index}`}
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
          ) : null}
          <section className="surface-flat p-4">
            <h2 className="text-sm font-semibold text-white">문서 정보</h2>
            <dl className="mt-3 space-y-2 text-sm text-slate-300">
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
          </section>
          <WikiPageTools
            pageId={page.id}
            title={page.title}
            displayTitle={page.displayTitle}
            routePath={routePath}
          />
          {page.categories.length > 0 ? (
            <section className="surface-flat p-4">
              <h2 className="text-sm font-semibold text-white">분류</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {page.categories.map((category) => (
                  <Link key={category} href={`/wiki/category/${encodeURIComponent(category)}`} className="chip chip-muted hover:border-emerald-300/40 hover:text-emerald-100">
                    {category}
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
      </div>
      {afterContent}
    </main>
  );
}

function protectionLabel(value: string): string {
  const labels: Record<string, string> = { open: '누구나 편집', login_required: '로그인 필요', review_required: '검토 후 반영', autoconfirmed_only: '자동 인증 사용자', trusted_only: '신뢰 사용자', official_only: '공식 편집자', owner_only: '소유자만', admin_only: '관리자만', locked: '편집 잠김' };
  return labels[value] ?? '사용자 지정 보호';
}

function statusLabel(value: string): string {
  const labels: Record<string, string> = { normal: '공개', active: '공개', published: '공개', hidden: '숨김', deleted: '삭제됨' };
  return labels[value] ?? '알 수 없음';
}

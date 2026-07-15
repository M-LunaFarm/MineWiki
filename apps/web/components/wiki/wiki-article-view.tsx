import Link from 'next/link';
import type { ReactNode } from 'react';
import { Pencil, PencilLine, Star } from 'lucide-react';
import type { WikiPageResponse } from '../../lib/wiki-api';
import { buildCategoryWikiToolPath, buildServerWikiToolPath, buildStandardWikiToolPath } from '../../lib/wiki-routes.mjs';
import { WikiPageTools } from './wiki-page-tools';

interface WikiArticleViewProps {
  readonly page: WikiPageResponse;
  readonly routePath: string;
  readonly beforeContent?: ReactNode;
  readonly afterContent?: ReactNode;
}

export function WikiArticleView({ page, routePath, beforeContent, afterContent }: WikiArticleViewProps) {
  const isCategoryDocument = routePath.startsWith('/wiki/category/');
  const editPath = routePath.startsWith('/server/')
    ? buildServerWikiToolPath(routePath, 'edit')
    : isCategoryDocument
      ? buildCategoryWikiToolPath(routePath, 'edit')
      : buildStandardWikiToolPath(routePath, 'edit');
  const historyPath = routePath.startsWith('/server/')
    ? buildServerWikiToolPath(routePath, 'history')
    : isCategoryDocument
      ? buildCategoryWikiToolPath(routePath, 'history')
      : buildStandardWikiToolPath(routePath, 'history');
  const updatedAt = new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul'
  }).format(new Date(page.updatedAt));

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <Link href="/wiki/%EB%8C%80%EB%AC%B8" className="hover:text-emerald-200">
          MineWiki
        </Link>
        <span>/</span>
        <span className="text-slate-300">{page.namespace}</span>
        <span>/</span>
        <span className="text-slate-200">{page.displayTitle}</span>
      </nav>

      {beforeContent}

      <header className="border-b border-white/10 pb-6">
        <div className="mb-4 flex flex-wrap gap-2">
          <span className="chip chip-accent">{page.namespace}</span>
          <span className="chip chip-muted">rev {page.revision.revisionNo}</span>
          <span className="chip chip-muted">{page.protectionLevel}</span>
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
          {routePath} · 최근 수정 {updatedAt}
        </p>
        {page.redirectTarget ? (
          <p className="mt-3 text-sm text-slate-300">
            넘겨주기 대상: <span className="font-semibold text-slate-100">{page.redirectTarget}</span>
          </p>
        ) : null}
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <article
          className="wiki-rendered min-w-0"
          dangerouslySetInnerHTML={{ __html: page.html }}
        />
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
            <nav className="surface-flat p-4" aria-label="문서 목차">
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
                        className="rounded p-1 text-slate-600 transition hover:bg-white/[0.05] hover:text-emerald-200"
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
                <dd>{page.status}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">링크</dt>
                <dd>{page.links.length}</dd>
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href={editPath} className="chip chip-accent inline-flex items-center gap-1.5">
                <PencilLine className="h-3.5 w-3.5" />
                편집
              </Link>
              <Link href={historyPath} className="chip chip-accent">
                역사
              </Link>
              <Link href={`/wiki/revision/${page.revision.id}`} className="chip chip-muted">
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

import Link from 'next/link';
import { ServerWikiWorkspace } from '../../../../components/wiki/server-wiki-workspace';
import { WikiDynamicTimeHydrator } from '../../../../components/wiki/wiki-dynamic-time-hydrator';
import { buildWikiHistoryPath, safeWikiReturnTo } from '../../../../lib/wiki-routes.mjs';
import { fetchWikiPageByPath, fetchWikiRenderedRevision } from '../../../../lib/wiki-server-api';
import { WikiEditSummary } from '../../../../components/wiki/wiki-edit-summary';

interface PageProps {
  readonly params: Promise<{ revisionId: string }>;
  readonly searchParams: Promise<{ returnTo?: string }>;
}

export default async function WikiRevisionPage({ params, searchParams }: PageProps) {
  const [{ revisionId }, query] = await Promise.all([params, searchParams]);
  const page = await fetchWikiRenderedRevision(revisionId);
  const revision = page.revision;
  const context = await revisionContext(page.id, page.routePath, query.returnTo);
  const contentId = `wiki-revision-${revision.id}`;
  const content = (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        {context ? (
          <Link href={context.returnTo} className="hover:text-emerald-200">{page.displayTitle}</Link>
        ) : (
          <Link href="/recent" className="hover:text-emerald-200">최근 변경</Link>
        )}
        <span>/</span>
        <span className="text-slate-200">rev {revision.revisionNo}</span>
      </nav>
      <header className="border-b border-white/10 pb-6">
        <div className="mb-4 flex flex-wrap gap-2">
          <span className="chip chip-accent">{revision.isCurrent ? '현재 판' : '과거 판'}</span>
          {revision.isMinor ? <span className="chip chip-muted">minor</span> : null}
          <span className="chip chip-muted">공개</span>
        </div>
        <h1 className="text-3xl font-bold text-white">{page.displayTitle} <span className="text-slate-500">rev {revision.revisionNo}</span></h1>
        <p className="mt-3 text-sm text-slate-400">
          {formatDate(revision.createdAt)} · <WikiEditSummary summary={revision.editSummary} hidden={revision.editSummaryHidden} emptyLabel="편집 요약 없음" /> · {formatBytes(revision.contentSize)}
        </p>
        {context ? (
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <Link href={context.returnTo} className="btn-primary min-h-11 w-full sm:w-auto">현재 문서로 돌아가기</Link>
            {context.historyPath ? <Link href={context.historyPath} className="btn-secondary min-h-11 w-full sm:w-auto">문서 역사</Link> : null}
          </div>
        ) : null}
      </header>
      <aside className="rounded-lg border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
        {revision.isCurrent ? '현재 공개 판을 렌더링한 화면입니다.' : `이 화면은 rev ${revision.revisionNo}의 보존된 원문을 렌더링한 과거 판입니다.`}{' '}
        {page.render.dependencyMode === 'release-snapshot'
          ? 'Include·내부 링크·문서 탐색·레이아웃은 이 판이 공개된 릴리스 스냅샷을 기준으로 표시됩니다. 첨부 파일 접근, 서버 디렉터리의 실시간 상태와 동적 시간 값은 현재 데이터와 권한을 따릅니다.'
          : 'Include·내부 링크·첨부 파일·서버 정보와 동적 시간 값은 현재 데이터와 접근 권한을 기준으로 표시됩니다.'}
      </aside>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <article id={contentId} className="wiki-rendered min-w-0" dangerouslySetInnerHTML={{ __html: page.html }} />
        <WikiDynamicTimeHydrator targetId={contentId} revisionId={revision.id} />
        {page.headings.length > 0 ? (
          <nav className="surface-flat h-fit p-4 lg:sticky lg:top-24" aria-label="이 판의 목차">
            <h2 className="text-sm font-semibold text-white">이 판의 목차</h2>
            <ol className="mt-3 space-y-1.5 text-sm">
              {page.headings.map((heading, index) => (
                <li key={`${heading.anchor}-${index}`} style={{ paddingInlineStart: `${Math.max(0, heading.level - 2) * 0.75}rem` }}>
                  <a href={`#${encodeURIComponent(heading.anchor)}`} className="block min-h-11 py-3 text-slate-400 hover:text-emerald-200">{heading.title}</a>
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
      </div>
    </div>
  );

  if (page.serverWiki) {
    return <ServerWikiWorkspace page={page} section={`rev ${revision.revisionNo}`}>{content}</ServerWikiWorkspace>;
  }
  return <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">{content}</main>;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
}

async function revisionContext(pageId: string, canonicalRoutePath: string, requestedReturnTo?: string) {
  const requested = safeWikiReturnTo(requestedReturnTo);
  const returnTo = requested ?? canonicalRoutePath;
  if (requested) {
    const page = await fetchWikiPageByPath(requested).catch(() => null);
    if (!page || page.id !== pageId) return null;
  }
  return {
    returnTo,
    historyPath: buildWikiHistoryPath(returnTo),
  };
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul'
  }).format(new Date(value));
}

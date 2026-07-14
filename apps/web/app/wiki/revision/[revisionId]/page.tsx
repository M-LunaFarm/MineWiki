import Link from 'next/link';
import { ServerWikiWorkspace } from '../../../../components/wiki/server-wiki-workspace';
import { buildServerWikiToolPath, safeWikiReturnTo } from '../../../../lib/wiki-routes.mjs';
import { fetchWikiPageByPath, fetchWikiRevision } from '../../../../lib/wiki-server-api';

interface PageProps {
  readonly params: Promise<{ revisionId: string }>;
  readonly searchParams: Promise<{ returnTo?: string }>;
}

export default async function WikiRevisionPage({ params, searchParams }: PageProps) {
  const [{ revisionId }, query] = await Promise.all([params, searchParams]);
  const revision = await fetchWikiRevision(revisionId);
  const context = await revisionContext(revision.pageId, query.returnTo);
  const content = (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        {context ? (
          <Link href={context.returnTo} className="hover:text-emerald-200">{context.page.displayTitle}</Link>
        ) : (
          <Link href="/recent" className="hover:text-emerald-200">최근 변경</Link>
        )}
        <span>/</span>
        <span className="text-slate-200">rev {revision.revisionNo}</span>
      </nav>
      <header className="border-b border-white/10 pb-6">
        <div className="mb-4 flex flex-wrap gap-2">
          <span className="chip chip-accent">revision</span>
          {revision.isMinor ? <span className="chip chip-muted">minor</span> : null}
          <span className="chip chip-muted">{revision.visibility}</span>
        </div>
        <h1 className="text-3xl font-bold text-white">Wiki revision {revision.revisionNo}</h1>
        <p className="mt-3 text-sm text-slate-400">
          page {revision.pageId} · {formatDate(revision.createdAt)} · {revision.editSummary ?? '요약 없음'}
        </p>
        {context ? (
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <Link href={context.returnTo} className="btn-primary min-h-11 w-full sm:w-auto">현재 문서로 돌아가기</Link>
            {context.historyPath ? <Link href={context.historyPath} className="btn-secondary min-h-11 w-full sm:w-auto">문서 역사</Link> : null}
          </div>
        ) : null}
      </header>
      <section className="border border-white/10 bg-[#111821] p-4">
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap text-sm leading-6 text-slate-200">
          {revision.contentRaw}
        </pre>
      </section>
    </div>
  );

  if (context?.page.serverWiki) {
    return <ServerWikiWorkspace page={context.page} section={`rev ${revision.revisionNo}`}>{content}</ServerWikiWorkspace>;
  }
  return <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">{content}</main>;
}

async function revisionContext(pageId: string, requestedReturnTo?: string) {
  const returnTo = safeWikiReturnTo(requestedReturnTo);
  if (!returnTo) return null;
  const page = await fetchWikiPageByPath(returnTo).catch(() => null);
  if (!page || page.id !== pageId) return null;
  return {
    page,
    returnTo,
    historyPath: page.serverWiki ? buildServerWikiToolPath(returnTo, 'history') : null,
  };
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul'
  }).format(new Date(value));
}

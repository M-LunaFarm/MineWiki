import Link from 'next/link';
import { ServerWikiWorkspace } from '../../../../../components/wiki/server-wiki-workspace';
import { buildServerWikiToolPath, buildWikiRevisionPath, safeWikiReturnTo } from '../../../../../lib/wiki-routes.mjs';
import { fetchWikiPageByPath, fetchWikiRevisionDiff } from '../../../../../lib/wiki-server-api';

interface PageProps {
  readonly params: Promise<{ leftId: string; rightId: string }>;
  readonly searchParams: Promise<{ returnTo?: string }>;
}

export default async function WikiDiffPage({ params, searchParams }: PageProps) {
  const [{ leftId, rightId }, query] = await Promise.all([params, searchParams]);
  const diff = await fetchWikiRevisionDiff(leftId, rightId);
  const context = await diffContext(diff.right.pageId, query.returnTo);
  const content = (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        {context ? <><Link href={context.returnTo} className="hover:text-emerald-200">{context.page.displayTitle}</Link><span>/</span></> : null}
        <Link href={buildWikiRevisionPath(diff.left.id, context?.returnTo)} className="hover:text-emerald-200">rev {diff.left.revisionNo}</Link>
        <span>-&gt;</span>
        <Link href={buildWikiRevisionPath(diff.right.id, context?.returnTo)} className="hover:text-emerald-200">rev {diff.right.revisionNo}</Link>
      </nav>
      <header className="border-b border-white/10 pb-6">
        <h1 className="text-3xl font-bold text-white">Diff</h1>
        <p className="mt-3 text-sm text-slate-400">page {diff.right.pageId} · {formatDate(diff.right.createdAt)}</p>
        {context ? (
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <Link href={context.returnTo} className="btn-primary min-h-11 w-full sm:w-auto">현재 문서로 돌아가기</Link>
            {context.historyPath ? <Link href={context.historyPath} className="btn-secondary min-h-11 w-full sm:w-auto">문서 역사</Link> : null}
          </div>
        ) : null}
      </header>
      <section className="overflow-x-auto border border-white/10 bg-[#111821]">
        <table className="min-w-full text-left font-mono text-sm">
          <tbody>
            {diff.hunks.map((hunk, index) => (
              <tr key={`${index}-${hunk.type}`} className={rowTone(hunk.type)}>
                <td className="w-20 px-3 py-1 text-right text-slate-500">{hunk.leftLine ?? ''}</td>
                <td className="w-20 px-3 py-1 text-right text-slate-500">{hunk.rightLine ?? ''}</td>
                <td className="w-8 px-3 py-1 text-center text-slate-400">{mark(hunk.type)}</td>
                <td className="px-3 py-1 whitespace-pre-wrap">{hunk.line}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );

  if (context?.page.serverWiki) {
    return <ServerWikiWorkspace page={context.page} section="판 비교">{content}</ServerWikiWorkspace>;
  }
  return <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">{content}</main>;
}

async function diffContext(pageId: string, requestedReturnTo?: string) {
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

function mark(type: 'added' | 'context' | 'removed'): string {
  if (type === 'added') return '+';
  if (type === 'removed') return '-';
  return ' ';
}

function rowTone(type: 'added' | 'context' | 'removed'): string {
  if (type === 'added') return 'bg-emerald-500/10 text-emerald-100';
  if (type === 'removed') return 'bg-red-500/10 text-red-100';
  return 'text-slate-300';
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul'
  }).format(new Date(value));
}

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchWikiPageByPath, fetchWikiRevisions } from '../../lib/wiki-server-api';
import { buildWikiRoutePath } from '../../lib/wiki-routes.mjs';
import { ServerWikiWorkspace } from './server-wiki-workspace';
import { WikiHistoryListClient } from './wiki-history-list-client';

interface WikiHistoryRoutePageProps {
  readonly prefix: 'wiki' | 'mod' | 'modpack' | 'server' | 'dev' | 'guide' | 'data' | 'help' | 'project' | 'template' | 'category' | 'file';
  readonly segments?: string[];
}

export async function WikiHistoryRoutePage({ prefix, segments = [] }: WikiHistoryRoutePageProps) {
  const routePath = buildWikiRoutePath(prefix, segments);
  const page = await fetchWikiPageByPath(routePath);
  if (!page) notFound();
  const revisions = await fetchWikiRevisions(page.id);
  const history = <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
    <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400"><Link href={routePath} className="hover:text-emerald-200">{page.displayTitle}</Link><span>/</span><span className="text-slate-200">역사</span></nav>
    <header className="border-b border-white/10 pb-6"><h1 className="text-3xl font-bold text-white">{page.displayTitle} 역사</h1><p className="mt-3 text-sm text-slate-400">{routePath}</p></header>
    <WikiHistoryListClient pageId={page.id} currentRevisionId={page.revision.id} routePath={routePath} initial={revisions} />
  </div>;
  if (prefix === 'server' && page.serverWiki) return <ServerWikiWorkspace page={page} section="역사">{history}</ServerWikiWorkspace>;
  return <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">{history}</main>;
}

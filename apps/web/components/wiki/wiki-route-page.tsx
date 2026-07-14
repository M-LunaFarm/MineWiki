import { notFound } from 'next/navigation';
import { fetchWikiPageByPath } from '../../lib/wiki-server-api';
import { buildWikiRoutePath } from '../../lib/wiki-routes.mjs';
import { WikiArticleView } from './wiki-article-view';
import { ServerWikiArticleView } from './server-wiki-article-view';

interface WikiRoutePageProps {
  readonly prefix: 'wiki' | 'mod' | 'modpack' | 'server' | 'dev' | 'guide' | 'data' | 'help' | 'project' | 'template' | 'category' | 'file';
  readonly segments?: string[];
}

export async function WikiRoutePage({ prefix, segments = [] }: WikiRoutePageProps) {
  const routePath = buildWikiRoutePath(prefix, segments);
  const page = await fetchWikiPageByPath(routePath);
  if (!page) {
    notFound();
  }
  if (prefix === 'server' && page.serverWiki) {
    return <ServerWikiArticleView page={page} routePath={routePath} />;
  }
  return <WikiArticleView page={page} routePath={routePath} />;
}

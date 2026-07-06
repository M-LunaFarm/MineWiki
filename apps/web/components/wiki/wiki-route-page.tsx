import { notFound } from 'next/navigation';
import { fetchWikiPageByPath } from '../../lib/wiki-api';
import { WikiArticleView } from './wiki-article-view';

interface WikiRoutePageProps {
  readonly prefix: 'wiki' | 'mod' | 'modpack' | 'server' | 'dev' | 'help' | 'project' | 'file';
  readonly segments?: string[];
}

export async function WikiRoutePage({ prefix, segments = [] }: WikiRoutePageProps) {
  const suffix = segments.map((segment) => encodeURIComponent(segment)).join('/');
  const routePath = `/${prefix}${suffix ? `/${suffix}` : '/대문'}`;
  const page = await fetchWikiPageByPath(routePath);
  if (!page) {
    notFound();
  }
  return <WikiArticleView page={page} routePath={routePath} />;
}

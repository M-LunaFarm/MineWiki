import { notFound } from 'next/navigation';
import { fetchWikiPageByPath } from '../../lib/wiki-server-api';
import { normalizeWikiRecentDiscussionFilters } from '../../lib/wiki-discussion-status.mjs';
import { serverWikiPublicPath, type ServerWikiPublicRouteContext } from '../../lib/server-wiki-public-route';
import { ServerWikiWorkspace } from './server-wiki-workspace';
import { WikiRecentDiscussionsClient } from './wiki-recent-discussions-client';

export async function ServerWikiDiscussionsPage({
  slug,
  routeContext,
  searchParams,
}: {
  readonly slug: string;
  readonly routeContext?: ServerWikiPublicRouteContext | null;
  readonly searchParams: Promise<{ readonly status?: string; readonly sort?: string }>;
}) {
  const page = await fetchWikiPageByPath(`/serverWiki/${encodeURIComponent(slug)}`);
  if (!page?.serverWiki) notFound();
  const filters = normalizeWikiRecentDiscussionFilters(await searchParams) as {
    status: 'all' | 'active' | 'open' | 'paused' | 'closed';
    sort: 'newest' | 'oldest';
  };
  const basePath = serverWikiPublicPath(`/serverWiki/${encodeURIComponent(slug)}/_discussions`, routeContext);
  return <ServerWikiWorkspace page={page} section="토론" routeContext={routeContext}>
    <header className="mb-6 border-b border-[#e8e8e8] pb-6">
      <h1 className="text-3xl font-bold text-[#222]">최근 토론</h1>
      <p className="mt-2 text-sm leading-6 text-[#777]">이 서버 위키의 문서에서 진행되는 토론만 모아봅니다.</p>
    </header>
    <WikiRecentDiscussionsClient status={filters.status} sort={filters.sort} serverSlug={slug} basePath={basePath} />
  </ServerWikiWorkspace>;
}

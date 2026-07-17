import { WikiRoutePage } from '../../../components/wiki/wiki-route-page';
import { WikiEditRoutePage } from '../../../components/wiki/wiki-edit-route-page';
import { WikiHistoryRoutePage } from '../../../components/wiki/wiki-history-route-page';
import { ServerWikiToolRoutePage } from '../../../components/wiki/server-wiki-tool-route-page';
import { ServerWikiSearchPage } from '../../../components/wiki/server-wiki-search-page';
import { parseServerWikiToolRoute } from '../../../lib/wiki-routes.mjs';

interface PageProps {
  readonly params: Promise<{ path?: string[] }>;
  readonly searchParams: Promise<{ q?: string; target?: string; cursor?: string }>;
}

export const revalidate = 60;

export default async function ServerWikiSitePage({ params, searchParams }: PageProps) {
  const resolvedParams = await params;
  const path = resolvedParams.path ?? [];
  if (path.length === 2 && path[1] === '_search') {
    return <ServerWikiSearchPage slug={path[0] ?? ''} routePrefix="serverWiki" searchParams={await searchParams} />;
  }
  const toolRoute = parseServerWikiToolRoute(path);
  if (toolRoute?.tool === 'raw' || toolRoute?.tool === 'backlinks' || toolRoute?.tool === 'discuss' || toolRoute?.tool === 'requests' || toolRoute?.tool === 'blame' || toolRoute?.tool === 'acl') {
    return <ServerWikiToolRoutePage segments={toolRoute.documentSegments} routePrefix="serverWiki" tool={toolRoute.tool} />;
  }
  if (toolRoute?.tool === 'edit') {
    return <WikiEditRoutePage prefix="serverWiki" segments={toolRoute.documentSegments} />;
  }
  if (toolRoute?.tool === 'history') {
    return <WikiHistoryRoutePage prefix="serverWiki" segments={toolRoute.documentSegments} />;
  }
  return <WikiRoutePage prefix="serverWiki" segments={resolvedParams.path} />;
}

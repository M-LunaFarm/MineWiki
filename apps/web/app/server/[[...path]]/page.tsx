import { WikiRoutePage } from '../../../components/wiki/wiki-route-page';
import { WikiEditRoutePage } from '../../../components/wiki/wiki-edit-route-page';
import { WikiHistoryRoutePage } from '../../../components/wiki/wiki-history-route-page';
import { ServerWikiToolRoutePage } from '../../../components/wiki/server-wiki-tool-route-page';
import { ServerWikiSearchPage } from '../../../components/wiki/server-wiki-search-page';
import { parseServerWikiToolRoute } from '../../../lib/wiki-routes.mjs';
import { buildWikiRoutePath } from '../../../lib/wiki-routes.mjs';
import { fetchWikiPageByPath } from '../../../lib/wiki-server-api';
import { redirect } from 'next/navigation';

interface PageProps {
  readonly params: Promise<{ path?: string[] }>;
  readonly searchParams: Promise<{ q?: string; target?: string; cursor?: string }>;
}

export const dynamic = 'force-dynamic';

export default async function ServerWikiPage({ params, searchParams }: PageProps) {
  const resolvedParams = await params;
  const path = resolvedParams.path ?? [];
  if (path.length === 2 && path[1] === '_search') {
    return <ServerWikiSearchPage slug={path[0] ?? ''} searchParams={await searchParams} />;
  }
  const toolRoute = parseServerWikiToolRoute(path);
  if (toolRoute?.tool === 'raw' || toolRoute?.tool === 'backlinks' || toolRoute?.tool === 'discuss' || toolRoute?.tool === 'requests' || toolRoute?.tool === 'blame' || toolRoute?.tool === 'acl') {
    return <ServerWikiToolRoutePage segments={toolRoute.documentSegments} tool={toolRoute.tool} />;
  }
  if (toolRoute?.tool === 'edit') {
    return <WikiEditRoutePage prefix="server" segments={toolRoute.documentSegments} />;
  }
  if (toolRoute?.tool === 'history') {
    return <WikiHistoryRoutePage prefix="server" segments={toolRoute.documentSegments} />;
  }
  const page = await fetchWikiPageByPath(buildWikiRoutePath('server', resolvedParams.path));
  const canonicalPath = page?.serverWiki?.navigation.find((item) => item.current)?.path;
  if (canonicalPath) redirect(canonicalPath);
  return <WikiRoutePage prefix="server" segments={resolvedParams.path} />;
}

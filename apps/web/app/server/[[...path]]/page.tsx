import { WikiRoutePage } from '../../../components/wiki/wiki-route-page';
import { WikiEditRoutePage } from '../../../components/wiki/wiki-edit-route-page';
import { WikiHistoryRoutePage } from '../../../components/wiki/wiki-history-route-page';
import { ServerWikiToolRoutePage } from '../../../components/wiki/server-wiki-tool-route-page';
import { parseServerWikiToolRoute } from '../../../lib/wiki-routes.mjs';

interface PageProps {
  readonly params: Promise<{ path?: string[] }>;
}

export const revalidate = 60;

export default async function ServerWikiPage({ params }: PageProps) {
  const resolvedParams = await params;
  const path = resolvedParams.path ?? [];
  const toolRoute = parseServerWikiToolRoute(path);
  if (toolRoute?.tool === 'raw' || toolRoute?.tool === 'backlinks' || toolRoute?.tool === 'discuss' || toolRoute?.tool === 'requests' || toolRoute?.tool === 'blame') {
    return <ServerWikiToolRoutePage segments={toolRoute.documentSegments} tool={toolRoute.tool} />;
  }
  if (toolRoute?.tool === 'edit') {
    return <WikiEditRoutePage prefix="server" segments={toolRoute.documentSegments} />;
  }
  if (toolRoute?.tool === 'history') {
    return <WikiHistoryRoutePage prefix="server" segments={toolRoute.documentSegments} />;
  }
  return <WikiRoutePage prefix="server" segments={resolvedParams.path} />;
}

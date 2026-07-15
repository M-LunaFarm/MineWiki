import { WikiEditRoutePage } from '../../../components/wiki/wiki-edit-route-page';
import { WikiHistoryRoutePage } from '../../../components/wiki/wiki-history-route-page';
import { WikiRoutePage } from '../../../components/wiki/wiki-route-page';
import { parseStandardWikiToolRoute } from '../../../lib/wiki-routes.mjs';

interface PageProps {
  readonly params: Promise<{ path?: string[] }>;
}

export const dynamic = 'force-dynamic';

export default async function UserWikiPage({ params }: PageProps) {
  const resolved = await params;
  const path = resolved.path ?? [];
  const toolRoute = parseStandardWikiToolRoute(path);
  if (toolRoute?.tool === 'edit') return <WikiEditRoutePage prefix="user" segments={toolRoute.documentSegments} />;
  if (toolRoute?.tool === 'history') return <WikiHistoryRoutePage prefix="user" segments={toolRoute.documentSegments} />;
  return <WikiRoutePage prefix="user" segments={path} />;
}

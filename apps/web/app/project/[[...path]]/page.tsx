import { WikiRoutePage } from '../../../components/wiki/wiki-route-page';
import { WikiEditRoutePage } from '../../../components/wiki/wiki-edit-route-page';
import { WikiHistoryRoutePage } from '../../../components/wiki/wiki-history-route-page';
import { parseStandardWikiToolRoute } from '../../../lib/wiki-routes.mjs';

interface PageProps {
  readonly params: Promise<{ path?: string[] }>;
}

export const revalidate = 60;

export default async function ProjectWikiPage({ params }: PageProps) {
  const resolvedParams = await params;
  const path = resolvedParams.path ?? [];
  const toolRoute = parseStandardWikiToolRoute(path);
  if (toolRoute?.tool === 'edit') return <WikiEditRoutePage prefix="project" segments={toolRoute.documentSegments} />;
  if (toolRoute?.tool === 'history') return <WikiHistoryRoutePage prefix="project" segments={toolRoute.documentSegments} />;
  return <WikiRoutePage prefix="project" segments={resolvedParams.path} />;
}

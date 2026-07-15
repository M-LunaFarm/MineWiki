import { WikiRoutePage } from '../../../components/wiki/wiki-route-page';
import { WikiEditRoutePage } from '../../../components/wiki/wiki-edit-route-page';
import { WikiHistoryRoutePage } from '../../../components/wiki/wiki-history-route-page';
import { parseStandardWikiToolRoute } from '../../../lib/wiki-routes.mjs';

interface PageProps { readonly params: Promise<{ path?: string[] }>; }
export const revalidate = 60;

export default async function TemplateWikiPage({ params }: PageProps) {
  const resolved = await params;
  const path = resolved.path ?? [];
  const toolRoute = parseStandardWikiToolRoute(path);
  if (toolRoute?.tool === 'edit') return <WikiEditRoutePage prefix="template" segments={toolRoute.documentSegments} />;
  if (toolRoute?.tool === 'history') return <WikiHistoryRoutePage prefix="template" segments={toolRoute.documentSegments} />;
  return <WikiRoutePage prefix="template" segments={resolved.path} />;
}

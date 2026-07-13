import { WikiRoutePage } from '../../../components/wiki/wiki-route-page';
import { WikiEditRoutePage } from '../../../components/wiki/wiki-edit-route-page';
import { WikiHistoryRoutePage } from '../../../components/wiki/wiki-history-route-page';

interface PageProps { readonly params: Promise<{ path?: string[] }>; }
export const revalidate = 60;

export default async function TemplateWikiPage({ params }: PageProps) {
  const resolved = await params;
  const path = resolved.path ?? [];
  if (path.at(-1) === 'edit') return <WikiEditRoutePage prefix="template" segments={path.slice(0, -1)} />;
  if (path.at(-1) === 'history') return <WikiHistoryRoutePage prefix="template" segments={path.slice(0, -1)} />;
  return <WikiRoutePage prefix="template" segments={resolved.path} />;
}

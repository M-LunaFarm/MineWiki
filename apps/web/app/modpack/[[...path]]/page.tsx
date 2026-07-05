import { WikiRoutePage } from '../../../components/wiki/wiki-route-page';
import { WikiEditRoutePage } from '../../../components/wiki/wiki-edit-route-page';
import { WikiHistoryRoutePage } from '../../../components/wiki/wiki-history-route-page';

interface PageProps {
  readonly params: Promise<{ path?: string[] }>;
}

export const revalidate = 60;

export default async function ModpackWikiPage({ params }: PageProps) {
  const resolvedParams = await params;
  const path = resolvedParams.path ?? [];
  if (path[path.length - 1] === 'edit') {
    return <WikiEditRoutePage prefix="modpack" segments={path.slice(0, -1)} />;
  }
  if (path[path.length - 1] === 'history') {
    return <WikiHistoryRoutePage prefix="modpack" segments={path.slice(0, -1)} />;
  }
  return <WikiRoutePage prefix="modpack" segments={resolvedParams.path} />;
}

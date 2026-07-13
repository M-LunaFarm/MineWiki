import { WikiRoutePage } from '../../../components/wiki/wiki-route-page';
import { WikiEditRoutePage } from '../../../components/wiki/wiki-edit-route-page';
import { WikiHistoryRoutePage } from '../../../components/wiki/wiki-history-route-page';
import { ServerWikiToolRoutePage } from '../../../components/wiki/server-wiki-tool-route-page';

interface PageProps {
  readonly params: Promise<{ path?: string[] }>;
}

export const revalidate = 60;

export default async function ServerWikiPage({ params }: PageProps) {
  const resolvedParams = await params;
  const path = resolvedParams.path ?? [];
  const action = path[path.length - 1];
  if (action === 'raw' || action === 'backlinks' || action === 'discuss' || action === 'requests') {
    return <ServerWikiToolRoutePage segments={path.slice(0, -1)} tool={action} />;
  }
  if (action === 'edit') {
    return <WikiEditRoutePage prefix="server" segments={path.slice(0, -1)} />;
  }
  if (action === 'history') {
    return <WikiHistoryRoutePage prefix="server" segments={path.slice(0, -1)} />;
  }
  return <WikiRoutePage prefix="server" segments={resolvedParams.path} />;
}

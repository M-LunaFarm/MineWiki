import { WikiRoutePage } from '../../../components/wiki/wiki-route-page';
import { WikiEditRoutePage } from '../../../components/wiki/wiki-edit-route-page';

interface PageProps {
  readonly params: Promise<{ path?: string[] }>;
}

export const revalidate = 60;

export default async function WikiPage({ params }: PageProps) {
  const resolvedParams = await params;
  const path = resolvedParams.path ?? [];
  if (path[path.length - 1] === 'edit') {
    return <WikiEditRoutePage prefix="wiki" segments={path.slice(0, -1)} />;
  }
  return <WikiRoutePage prefix="wiki" segments={resolvedParams.path} />;
}

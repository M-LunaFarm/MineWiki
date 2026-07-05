import { WikiRoutePage } from '../../../components/wiki/wiki-route-page';

interface PageProps {
  readonly params: Promise<{ path?: string[] }>;
}

export const revalidate = 60;

export default async function WikiPage({ params }: PageProps) {
  const resolvedParams = await params;
  return <WikiRoutePage prefix="wiki" segments={resolvedParams.path} />;
}

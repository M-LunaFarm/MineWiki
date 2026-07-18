import { WikiDeletedPageRecoveryClient } from '../../../../components/wiki/wiki-deleted-page-recovery-client';

interface PageProps {
  readonly params: Promise<{ pageId: string }>;
}

export default async function WikiDeletedPageRecoveryPage({ params }: PageProps) {
  const { pageId } = await params;
  return <WikiDeletedPageRecoveryClient pageId={pageId} />;
}

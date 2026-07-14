import type { Metadata } from 'next';
import { WikiBatchRollbackClient } from '../../../../components/wiki/wiki-batch-rollback-client';

export const metadata: Metadata = { title: '위키 일괄 훼손 복구', robots: { index: false, follow: false } };

export default async function AdminWikiBatchRollbackPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ targetProfileId?: string; username?: string }>;
}) {
  const query = await searchParams;
  return (
    <WikiBatchRollbackClient
      initialTargetProfileId={query.targetProfileId ?? ''}
      initialQuery={query.username ?? ''}
    />
  );
}

import { WikiEditRequestsClient } from '../../../../../components/wiki/wiki-edit-requests-client';
import { safeWikiReturnTo } from '../../../../../lib/wiki-routes.mjs';

interface PageProps {
  readonly params: Promise<{ requestId: string }>;
  readonly searchParams: Promise<{ returnTo?: string }>;
}

export default async function WikiCreateRequestPage({ params, searchParams }: PageProps) {
  const [{ requestId }, query] = await Promise.all([params, searchParams]);
  return (
    <WikiEditRequestsClient
      requestId={requestId}
      returnTo={safeWikiReturnTo(query.returnTo) ?? '/wiki/edit-requests'}
    />
  );
}

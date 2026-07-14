import { WikiEditRequestsClient } from '../../../../components/wiki/wiki-edit-requests-client';
import { safeWikiReturnTo } from '../../../../lib/wiki-routes.mjs';

interface PageProps { readonly params: Promise<{ pageId: string }>; readonly searchParams: Promise<{ returnTo?: string }>; }

export default async function WikiEditRequestsPage({ params, searchParams }: PageProps) {
  const [{ pageId }, query] = await Promise.all([params, searchParams]);
  return <WikiEditRequestsClient pageId={pageId} returnTo={safeWikiReturnTo(query.returnTo) ?? '/'} />;
}

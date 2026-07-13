import { WikiEditRequestsClient } from '../../../../components/wiki/wiki-edit-requests-client';

interface PageProps { readonly params: Promise<{ pageId: string }>; readonly searchParams: Promise<{ returnTo?: string }>; }

export default async function WikiEditRequestsPage({ params, searchParams }: PageProps) {
  const [{ pageId }, query] = await Promise.all([params, searchParams]);
  return <WikiEditRequestsClient pageId={pageId} returnTo={safeReturnTo(query.returnTo)} />;
}

function safeReturnTo(value?: string) { return value?.startsWith('/') && !value.startsWith('//') ? value : '/'; }

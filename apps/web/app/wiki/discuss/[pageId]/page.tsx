import { WikiDiscussionClient } from '../../../../components/wiki/wiki-discussion-client';

interface PageProps { readonly params: Promise<{ pageId: string }>; readonly searchParams: Promise<{ returnTo?: string }>; }

export default async function WikiDiscussionPage({ params, searchParams }: PageProps) {
  const [{ pageId }, query] = await Promise.all([params, searchParams]);
  return <WikiDiscussionClient pageId={pageId} returnTo={safeReturnTo(query.returnTo)} />;
}

function safeReturnTo(value?: string) { return value?.startsWith('/') && !value.startsWith('//') ? value : '/'; }

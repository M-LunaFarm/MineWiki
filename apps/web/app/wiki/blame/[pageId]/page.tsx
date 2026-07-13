import { WikiBlameClient } from '../../../../components/wiki/wiki-blame-client';

interface PageProps { readonly params: Promise<{ pageId: string }>; readonly searchParams: Promise<{ returnTo?: string }>; }

export default async function WikiBlamePage({ params, searchParams }: PageProps) {
  const [{ pageId }, query] = await Promise.all([params, searchParams]);
  return <WikiBlameClient pageId={pageId} returnTo={safeReturnTo(query.returnTo)} />;
}

function safeReturnTo(value?: string) { return value?.startsWith('/') && !value.startsWith('//') ? value : '/'; }

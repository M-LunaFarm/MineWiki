import { WikiBlameClient } from '../../../../components/wiki/wiki-blame-client';

interface PageProps { readonly params: Promise<{ pageId: string }>; readonly searchParams: Promise<{ returnTo?: string; revisionId?: string }>; }

export default async function WikiBlamePage({ params, searchParams }: PageProps) {
  const [{ pageId }, query] = await Promise.all([params, searchParams]);
  return <WikiBlameClient pageId={pageId} returnTo={safeReturnTo(query.returnTo)} revisionId={safeRevisionId(query.revisionId)} />;
}

function safeReturnTo(value?: string) { return value?.startsWith('/') && !value.startsWith('//') ? value : '/'; }
function safeRevisionId(value?: string) { return value && /^\d+$/u.test(value) ? value : undefined; }

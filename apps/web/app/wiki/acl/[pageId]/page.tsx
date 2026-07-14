import { WikiPageAclClient } from '../../../../components/wiki/wiki-page-acl-client';

interface PageProps {
  readonly params: Promise<{ pageId: string }>;
  readonly searchParams: Promise<{ returnTo?: string }>;
}

export default async function WikiPageAclPage({ params, searchParams }: PageProps) {
  const [{ pageId }, query] = await Promise.all([params, searchParams]);
  return <WikiPageAclClient pageId={pageId} returnTo={safeReturnTo(query.returnTo)} />;
}

function safeReturnTo(value?: string): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/wiki/대문';
}

import { WikiRawClient } from '../../../../components/wiki/wiki-raw-client';

interface PageProps {
  readonly params: Promise<{ pageId: string }>;
  readonly searchParams: Promise<{ returnTo?: string }>;
}

export default async function WikiRawPage({ params, searchParams }: PageProps) {
  const [{ pageId }, query] = await Promise.all([params, searchParams]);
  const returnTo = safeReturnTo(query.returnTo);
  return <WikiRawClient pageId={pageId} returnTo={returnTo} />;
}

function safeReturnTo(value?: string): string {
  if (!value?.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

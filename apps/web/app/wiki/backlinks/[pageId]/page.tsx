import { WikiBacklinksClient } from '../../../../components/wiki/wiki-backlinks-client';

interface PageProps {
  readonly params: Promise<{ pageId: string }>;
  readonly searchParams: Promise<{ returnTo?: string }>;
}

export default async function WikiBacklinksPage({ params, searchParams }: PageProps) {
  const [{ pageId }, query] = await Promise.all([params, searchParams]);
  return <WikiBacklinksClient pageId={pageId} returnTo={safeReturnTo(query.returnTo)} />;
}

function safeReturnTo(value?: string): string {
  if (!value?.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

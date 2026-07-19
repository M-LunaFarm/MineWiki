import { WikiDeletedPagesClient } from '../../../components/wiki/wiki-deleted-pages-client';
import { safeWikiReturnTo } from '../../../lib/wiki-routes.mjs';

interface PageProps {
  readonly searchParams: Promise<{ readonly spaceId?: string; readonly returnTo?: string }>;
}

export default async function WikiDeletedPagesPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const spaceId = query.spaceId && /^\d+$/u.test(query.spaceId) ? query.spaceId : undefined;
  return <WikiDeletedPagesClient spaceId={spaceId} returnTo={safeWikiReturnTo(query.returnTo)} />;
}

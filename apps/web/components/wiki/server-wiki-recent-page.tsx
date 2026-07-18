import { notFound } from 'next/navigation';

import { fetchWikiPageByPath, fetchWikiRecent } from '../../lib/wiki-server-api';
import { WikiRecentChangesClient } from './wiki-recent-changes-client';
import { ServerWikiWorkspace } from './server-wiki-workspace';

export async function ServerWikiRecentPage({
  slug,
  routePrefix = 'serverWiki',
}: {
  readonly slug: string;
  readonly routePrefix?: 'server' | 'serverWiki';
}) {
  const routePath = `/${routePrefix}/${encodeURIComponent(slug)}`;
  const page = await fetchWikiPageByPath(routePath);
  if (!page?.serverWiki) notFound();
  const filters = { namespace: 'server', spaceId: page.serverWiki.spaceId } as const;
  const recent = await fetchWikiRecent(filters);

  return (
    <ServerWikiWorkspace page={page} section="변경 기록">
      <header className="mb-6 border-b border-[#e8e8e8] pb-6">
        <h1 className="text-3xl font-bold text-[#222]">변경 기록</h1>
        <p className="mt-2 text-sm leading-6 text-[#777]">이 서버 문서 공간에서 일어난 편집만 모아 기여자, 변경량과 판 비교를 확인합니다.</p>
      </header>
      <WikiRecentChangesClient initial={recent} filters={filters} />
    </ServerWikiWorkspace>
  );
}

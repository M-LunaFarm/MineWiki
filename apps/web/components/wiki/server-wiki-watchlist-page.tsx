import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchWikiPageByPath } from '../../lib/wiki-server-api';
import { serverWikiPlatformUrl, type ServerWikiPublicRouteContext } from '../../lib/server-wiki-public-route';
import { ServerWikiWorkspace } from './server-wiki-workspace';
import { WikiWatchlistClient } from './wiki-watchlist-client';

export async function ServerWikiWatchlistPage({ slug, routeContext }: {
  readonly slug: string;
  readonly routeContext?: ServerWikiPublicRouteContext | null;
}) {
  const page = await fetchWikiPageByPath(`/serverWiki/${encodeURIComponent(slug)}`);
  if (!page?.serverWiki) notFound();
  const platformPath = `/serverWiki/${encodeURIComponent(slug)}/_watchlist`;
  return <ServerWikiWorkspace page={page} section="관심 문서" routeContext={routeContext}>
    <header className="mb-6 border-b border-[#e8e8e8] pb-6">
      <h1 className="text-3xl font-bold text-[#222]">관심 문서</h1>
      <p className="mt-2 text-sm leading-6 text-[#777]">이 서버 위키에서 지켜보는 문서와 읽지 않은 변경을 확인합니다.</p>
    </header>
    {routeContext
      ? <div className="rounded-xl border border-[#dfe6f5] bg-[#f7f9ff] p-6 text-sm text-[#555]">계정 보안을 위해 관심 문서는 MineWiki에서 관리합니다. <Link href={serverWikiPlatformUrl(platformPath)} className="font-semibold text-[#346ddb] hover:underline">MineWiki에서 열기</Link></div>
      : <WikiWatchlistClient serverSlug={slug} returnTo={platformPath} />}
  </ServerWikiWorkspace>;
}

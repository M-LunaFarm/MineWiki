import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { WikiSpecialDocumentType } from '../../lib/wiki-api';
import { fetchWikiPageByPath, fetchWikiSpecial } from '../../lib/wiki-server-api';
import { serverWikiPublicPath, type ServerWikiPublicRouteContext } from '../../lib/server-wiki-public-route';
import { ServerWikiWorkspace } from './server-wiki-workspace';

const TYPES: ReadonlyArray<{ key: WikiSpecialDocumentType; label: string }> = [
  { key: 'orphaned', label: '고립된 문서' },
  { key: 'wanted', label: '필요한 문서' },
  { key: 'uncategorized', label: '분류 없는 문서' },
  { key: 'old', label: '오래된 문서' },
  { key: 'long', label: '긴 문서' },
  { key: 'short', label: '짧은 문서' },
  { key: 'random', label: '임의 문서' },
];

export async function ServerWikiSpecialPage({ slug, routeContext, searchParams }: {
  readonly slug: string;
  readonly routeContext?: ServerWikiPublicRouteContext | null;
  readonly searchParams: Promise<{ readonly type?: string; readonly cursor?: string }>;
}) {
  const page = await fetchWikiPageByPath(`/serverWiki/${encodeURIComponent(slug)}`);
  if (!page?.serverWiki) notFound();
  const query = await searchParams;
  const type = TYPES.some((item) => item.key === query.type) ? query.type as WikiSpecialDocumentType : 'orphaned';
  const result = await fetchWikiSpecial({ type, namespace: 'server', serverSlug: slug, limit: 100, cursor: query.cursor });
  const basePath = serverWikiPublicPath(`/serverWiki/${encodeURIComponent(slug)}/_special`, routeContext);
  const href = (nextType: WikiSpecialDocumentType, cursor?: string) => {
    const params = new URLSearchParams({ type: nextType });
    if (cursor) params.set('cursor', cursor);
    return `${basePath}?${params.toString()}`;
  };
  return <ServerWikiWorkspace page={page} section="특수 문서" routeContext={routeContext}>
    <header className="mb-6 border-b border-[#e8e8e8] pb-6">
      <h1 className="text-3xl font-bold text-[#222]">특수 문서</h1>
      <p className="mt-2 text-sm leading-6 text-[#777]">이 서버 위키의 구조와 문서 상태를 점검합니다.</p>
    </header>
    <nav className="mb-6 flex flex-wrap gap-2" aria-label="특수 문서 유형">
      {TYPES.map((item) => <Link key={item.key} href={href(item.key)} className={`rounded-lg border px-3 py-2 text-sm ${type === item.key ? 'border-[#346ddb] bg-[#eef3ff] text-[#2457ad]' : 'border-[#dedede] text-[#666] hover:bg-[#f7f7f7]'}`}>{item.label}</Link>)}
    </nav>
    <div className="divide-y divide-[#ececec] rounded-xl border border-[#e2e2e2] bg-white">
      {result.items.map((item) => <Link key={item.id} href={serverWikiPublicPath(item.routePath, routeContext)} className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-[#fafafa]"><span className="min-w-0 truncate font-medium text-[#292929]">{item.displayTitle}</span><span className="shrink-0 text-xs text-[#888]">{item.value === null ? '' : item.value.toLocaleString('ko-KR')}</span></Link>)}
      {result.items.length === 0 ? <p className="p-8 text-center text-sm text-[#888]">조건에 해당하는 문서가 없습니다.</p> : null}
    </div>
    {result.nextCursor ? <div className="mt-5 text-right"><Link href={href(type, result.nextCursor)} className="rounded-lg border border-[#dedede] px-4 py-2 text-sm text-[#555] hover:bg-[#f7f7f7]">다음 페이지</Link></div> : null}
  </ServerWikiWorkspace>;
}

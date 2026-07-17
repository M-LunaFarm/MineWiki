import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Search } from 'lucide-react';
import { fetchWikiPageByPath, searchWiki } from '../../lib/wiki-server-api';
import { ServerWikiWorkspace } from './server-wiki-workspace';

export async function ServerWikiSearchPage({
  slug,
  routePrefix = 'server',
  searchParams,
}: {
  readonly slug: string;
  readonly routePrefix?: 'server' | 'serverWiki';
  readonly searchParams: { q?: string; target?: string; cursor?: string };
}) {
  const rootPath = `/${routePrefix}/${encodeURIComponent(slug)}`;
  const page = await fetchWikiPageByPath(rootPath);
  if (!page?.serverWiki) notFound();
  const query = searchParams.q?.trim().slice(0, 100) ?? '';
  const target = searchParams.target === 'title' || searchParams.target === 'content'
    ? searchParams.target
    : 'all';
  const cursor = searchParams.cursor?.trim() || undefined;
  const result = query
    ? await searchWiki({ q: query, serverSlug: slug, target, cursor, limit: 30 })
    : { items: [], nextCursor: null };

  return (
    <ServerWikiWorkspace page={page} section="문서 검색">
      <header className="border-b border-[#e8e8e8] pb-7">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#346ddb]">Documentation search</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-[#1f1f1f] sm:text-4xl">{page.serverWiki.name} 문서 검색</h1>
        <p className="mt-3 text-sm leading-6 text-[#777]">이 서버 위키의 문서만 검색합니다.</p>
      </header>

      <form action={`${rootPath}/_search`} className="mt-7 grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto]">
        <label className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#888]" aria-hidden="true" />
          <span className="sr-only">검색어</span>
          <input name="q" type="search" maxLength={100} defaultValue={query} autoFocus placeholder="문서 제목 또는 내용" className="h-12 w-full rounded-lg border border-[#dedede] bg-[#fafafa] pl-10 pr-3 text-sm text-[#252525] outline-none placeholder:text-[#999] focus:border-[#9ab5ef] focus:bg-white" />
        </label>
        <select name="target" defaultValue={target} aria-label="검색 대상" className="h-12 rounded-lg border border-[#dedede] bg-white px-3 text-sm text-[#333] outline-none focus:border-[#9ab5ef]">
          <option value="all">제목 + 본문</option>
          <option value="title">제목만</option>
          <option value="content">본문만</option>
        </select>
        <button type="submit" className="h-12 rounded-lg bg-[#346ddb] px-6 text-sm font-semibold text-white transition hover:bg-[#2458bd]">검색</button>
      </form>

      {query ? (
        <section className="mt-8" aria-live="polite">
          <p className="mb-4 text-sm text-[#666]"><strong className="text-[#222]">‘{query}’</strong> 검색 결과 {result.items.length.toLocaleString('ko-KR')}개</p>
          <div className="divide-y divide-[#ededed] border-y border-[#ededed]">
            {result.items.map((item) => (
              <Link key={item.pageId} href={item.routePath} className="block px-1 py-5 transition hover:bg-[#fafafa] sm:px-3">
                <h2 className="font-semibold text-[#252525]">{item.displayTitle}</h2>
                <p className="mt-2 line-clamp-2 text-sm leading-6 text-[#777]">{item.snippet}</p>
              </Link>
            ))}
            {result.items.length === 0 ? <p className="py-8 text-sm text-[#777]">일치하는 문서가 없습니다.</p> : null}
          </div>
          {result.nextCursor ? (
            <Link href={`${rootPath}/_search?q=${encodeURIComponent(query)}&target=${encodeURIComponent(target)}&cursor=${encodeURIComponent(result.nextCursor)}`} className="mt-5 inline-flex min-h-11 items-center rounded-lg border border-[#dedede] px-4 text-sm font-semibold text-[#346ddb] hover:border-[#9ab5ef]">다음 결과</Link>
          ) : null}
        </section>
      ) : null}
    </ServerWikiWorkspace>
  );
}

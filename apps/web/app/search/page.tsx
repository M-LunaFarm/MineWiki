import Link from 'next/link';
import { BookOpen, Server, ShieldCheck, Users, Vote } from 'lucide-react';
import type { ServerSummary } from '@minewiki/schemas';
import { WikiSearchSuggestForm } from '../../components/wiki/wiki-search-suggest-form';
import { fetchServerRankings } from '../../lib/api';
import { buildServerPath } from '../../lib/server-routes';
import type { WikiSearchResult } from '../../lib/wiki-api';
import { searchWiki } from '../../lib/wiki-server-api';
import { formatCombinedSearchSummary, formatWikiResultBadge } from '../../lib/search-result-count.mjs';
import { formatWikiNamespace, formatWikiResultPath } from '../../lib/wiki-search-display.mjs';

interface SearchPageProps {
  readonly searchParams: Promise<{
    q?: string;
    namespace?: string;
    target?: string;
    cursor?: string;
  }>;
}

export const metadata = {
  title: '통합 검색',
  description: 'MineWiki의 서버 랭킹과 위키 지식을 한 번에 검색합니다.',
};

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const query = params.q?.trim().slice(0, 100) ?? '';
  const namespace = params.namespace?.trim() ?? '';
  const target = params.target === 'title' || params.target === 'content' ? params.target : 'all';
  const cursor = params.cursor?.trim() ?? '';
  const [wikiResult, serverResult] = query
    ? await Promise.all([
        searchWikiTitleFirst({
          query,
          namespace: namespace || undefined,
          requestedTarget: target,
          cursor: cursor || undefined,
        }),
        fetchServerRankings({ search: query, page: 1, pageSize: 8 })
          .then((result) => ({ items: result.items, total: result.total, available: true }))
          .catch((error) => {
            console.error('Unified search failed to load server results', error);
            return { items: [] as ServerSummary[], total: 0, available: false };
          }),
      ])
    : [
        {
          items: [] as WikiSearchResult[],
          nextCursor: null,
          available: true,
          resolvedTarget: target,
          usedContentFallback: false,
        },
        { items: [] as ServerSummary[], total: 0, available: true },
      ];
  const wikiHasMore = Boolean(wikiResult.nextCursor);
  const combinedSummary = formatCombinedSearchSummary({
    serverTotal: serverResult.total,
    wikiShown: wikiResult.items.length,
    wikiHasMore,
    continued: Boolean(cursor),
  });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
      <header className="border-b border-white/10 pb-7">
        <p className="text-xs font-semibold uppercase tracking-[.18em] text-[#35e5b7]">
          MineWiki Discovery
        </p>
        <h1 className="mt-2 text-3xl font-extrabold text-white sm:text-4xl">서버와 지식을 한 번에</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          서버 이름과 주소, 위키 문서 제목과 본문을 같은 검색어로 탐색합니다.
        </p>
      </header>

      <WikiSearchSuggestForm query={query} target={target} namespace={namespace} />

      {!query ? (
        <EmptySearch />
      ) : (
        <div className="space-y-10">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p className="text-slate-300">
              <strong className="text-white">&lsquo;{query}&rsquo;</strong> {combinedSummary}
            </p>
            <Link href={`/servers?search=${encodeURIComponent(query)}`} className="text-[#35e5b7] hover:text-[#64efc8]">
              서버 고급 필터로 보기
            </Link>
          </div>

          <SearchSection
            icon={<Server />}
            title="서버 랭킹"
            count={serverResult.total}
            available={serverResult.available}
            unavailableMessage="서버 랭킹 검색에 일시적으로 연결할 수 없습니다."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {serverResult.items.map((server) => <ServerResult key={server.id} server={server} />)}
            </div>
          </SearchSection>

          <SearchSection
            icon={<BookOpen />}
            title="위키 지식"
            count={wikiResult.items.length}
            countLabel={formatWikiResultBadge({ wikiShown: wikiResult.items.length, wikiHasMore, continued: Boolean(cursor) })}
            available={wikiResult.available}
            unavailableMessage="위키 검색에 일시적으로 연결할 수 없습니다."
          >
            {wikiResult.usedContentFallback ? (
              <p className="wiki-search-fallback mb-4 rounded-lg border px-4 py-3 text-sm">
                제목과 일치하는 문서가 없어 본문 내용에서 찾았습니다.
              </p>
            ) : null}
            <div className="divide-y divide-white/[0.08] border-y border-white/[0.08]">
              {wikiResult.items.map((result) => <WikiResult key={result.pageId} result={result} />)}
            </div>
            {wikiResult.nextCursor ? (
              <Link
                href={`/search?q=${encodeURIComponent(query)}${namespace ? `&namespace=${encodeURIComponent(namespace)}` : ''}&target=${encodeURIComponent(wikiResult.resolvedTarget)}&cursor=${encodeURIComponent(wikiResult.nextCursor)}`}
                className="mt-4 inline-flex min-h-11 items-center rounded-lg border border-white/10 px-4 py-2 text-sm font-semibold text-[#35e5b7] transition hover:border-[#35e5b7]/40 hover:bg-[#35e5b7]/[.06]"
              >
                다음 위키 검색 결과
              </Link>
            ) : null}
          </SearchSection>
        </div>
      )}
    </div>
  );
}

async function searchWikiTitleFirst({
  query,
  namespace,
  requestedTarget,
  cursor,
}: {
  readonly query: string;
  readonly namespace?: string;
  readonly requestedTarget: 'all' | 'title' | 'content';
  readonly cursor?: string;
}): Promise<{
  readonly items: WikiSearchResult[];
  readonly nextCursor: string | null;
  readonly available: boolean;
  readonly resolvedTarget: 'title' | 'content';
  readonly usedContentFallback: boolean;
}> {
  const run = async (target: 'title' | 'content') =>
    searchWiki({ q: query, namespace, target, cursor, limit: 30 });
  try {
    if (requestedTarget === 'title' || requestedTarget === 'content') {
      const result = await run(requestedTarget);
      return {
        ...result,
        available: true,
        resolvedTarget: requestedTarget,
        usedContentFallback: false,
      };
    }
    const titleResult = await run('title');
    if (titleResult.items.length > 0 || titleResult.nextCursor) {
      return {
        ...titleResult,
        available: true,
        resolvedTarget: 'title',
        usedContentFallback: false,
      };
    }
    const contentResult = await run('content');
    return {
      ...contentResult,
      available: true,
      resolvedTarget: 'content',
      usedContentFallback: true,
    };
  } catch (error) {
    console.error('Unified search failed to load wiki results', error);
    return {
      items: [],
      nextCursor: null,
      available: false,
      resolvedTarget: requestedTarget === 'content' ? 'content' : 'title',
      usedContentFallback: false,
    };
  }
}

function EmptySearch() {
  return (
    <section className="grid gap-3 sm:grid-cols-3">
      <DiscoveryHint icon={<Server />} title="서버 찾기" body="서버명, 접속 주소와 플레이 장르로 찾을 수 있습니다." />
      <DiscoveryHint icon={<BookOpen />} title="지식 찾기" body="문서 제목뿐 아니라 본문에 포함된 내용도 검색합니다." />
      <DiscoveryHint icon={<ShieldCheck />} title="신뢰도 비교" body="검증 상태와 실제 투표·리뷰 지표를 함께 확인하세요." />
    </section>
  );
}

function SearchSection({ icon, title, count, countLabel, available, unavailableMessage, children }: {
  readonly icon: React.ReactElement;
  readonly title: string;
  readonly count: number;
  readonly countLabel?: string;
  readonly available: boolean;
  readonly unavailableMessage: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#35e5b7]/20 bg-[#35e5b7]/[.08] text-[#35e5b7] [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
        <h2 className="text-xl font-bold text-white">{title}</h2>
        <span className="chip chip-muted">{countLabel ?? count.toLocaleString('ko-KR')}</span>
      </div>
      {!available ? (
        <p className="rounded-xl border border-rose-400/20 bg-rose-500/[.06] p-5 text-sm text-rose-200">{unavailableMessage}</p>
      ) : count === 0 ? (
        <p className="surface-flat p-5 text-sm text-slate-400">일치하는 결과가 없습니다.</p>
      ) : children}
    </section>
  );
}

function ServerResult({ server }: { readonly server: ServerSummary }) {
  return (
    <Link href={buildServerPath(server)} className="surface-card surface-card-hover block p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-bold text-white">{server.name}</h3>
            {server.verificationGrade === 'Verified' ? <span className="chip chip-accent">검증</span> : null}
          </div>
          <p className="mt-1 truncate font-mono text-xs text-slate-500">{server.joinHost}:{server.joinPort}</p>
        </div>
        <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${server.isOnline ? 'bg-[#35e5b7]' : 'bg-slate-600'}`} />
      </div>
      <p className="mt-4 line-clamp-2 min-h-12 text-sm leading-6 text-slate-300">{server.shortDescription}</p>
      <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-white/[0.07] pt-3 text-xs text-slate-500">
        <span className="flex items-center gap-1.5"><Vote className="h-3.5 w-3.5" /> 24시간 {server.votes24h.toLocaleString('ko-KR')}</span>
        <span className="flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> {server.playersOnline ?? 0}명</span>
        <span>{server.edition === 'java' ? 'Java' : 'Bedrock'}</span>
      </div>
    </Link>
  );
}

function WikiResult({ result }: { readonly result: WikiSearchResult }) {
  return (
    <Link href={result.routePath} className="block px-1 py-5 transition hover:bg-white/[0.025] sm:px-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span className="chip chip-muted">{formatWikiNamespace(result.namespace)}</span>
        <span className="break-all">{formatWikiResultPath(result.routePath)}</span>
        <span>{new Date(result.updatedAt).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}</span>
      </div>
      <h3 className="mt-2 text-lg font-semibold text-white">
        <HighlightedText value={result.displayTitle} ranges={result.highlights?.title ?? []} />
      </h3>
      <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-300">
        <HighlightedText value={result.snippet} ranges={result.highlights?.snippet ?? []} />
      </p>
    </Link>
  );
}

function HighlightedText({ value, ranges }: {
  readonly value: string;
  readonly ranges: ReadonlyArray<readonly [start: number, length: number]>;
}) {
  if (ranges.length === 0) return value;
  const parts: React.ReactNode[] = [];
  let offset = 0;
  for (const [start, length] of ranges) {
    if (start < offset || start < 0 || length <= 0 || start + length > value.length) continue;
    if (start > offset) parts.push(value.slice(offset, start));
    parts.push(<mark key={`${start}:${length}`} className="rounded-sm bg-amber-300/25 px-0.5 text-amber-100">{value.slice(start, start + length)}</mark>);
    offset = start + length;
  }
  if (offset < value.length) parts.push(value.slice(offset));
  return <>{parts}</>;
}

function DiscoveryHint({ icon, title, body }: { readonly icon: React.ReactElement; readonly title: string; readonly body: string }) {
  return (
    <article className="surface-card p-5">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/[0.05] text-[#35e5b7] [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      <h2 className="mt-4 font-bold text-white">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-400">{body}</p>
    </article>
  );
}

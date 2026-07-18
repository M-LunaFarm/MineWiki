'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ServerRankingResponse, ServerSummary } from '@minewiki/schemas';
import {
  Activity,
  BadgeCheck,
  Copy,
  ListFilter,
  Search,
  SearchX,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  ThumbsUp,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { SiteHeader } from '../layout/site-header';
import { SiteFooter } from '../layout/site-footer';
import {
  getServerPreviewFallbackClass,
  getServerPreviewInitial,
  getServerPreviewSeed,
} from '../../lib/server-preview';
import { buildServerPath } from '../../lib/server-routes';
import { fetchServerRankings, RankingEpochConflictError } from '../../lib/api';
import {
  serverRankingRequestFromFilters,
  shouldLoadUnrankedServerPreview,
  unrankedServerBrowseHref,
} from '../../lib/server-ranking-preview.mjs';

const PAGE_SIZE = 6;

const GENRE_OPTIONS = [
  {
    key: 'survival',
    label: '야생 (Survival)',
    aliases: ['생존', '야생', 'survival'],
  },
  {
    key: 'rpg',
    label: 'RPG',
    aliases: ['rpg', 'roleplay'],
  },
  {
    key: 'skyblock',
    label: '스카이블럭',
    aliases: ['스카이블럭', 'skyblock'],
  },
  {
    key: 'minigame',
    label: '미니게임',
    aliases: ['미니게임', 'minigame', 'minigames'],
  },
  {
    key: 'economy',
    label: '경제',
    aliases: ['경제', 'economy'],
  },
] as const;

type GenreKey = (typeof GENRE_OPTIONS)[number]['key'];
type EditionFilter = 'all' | 'java' | 'bedrock';
type GradeFilter = 'all' | 'Verified' | 'Unverified';
type OnlineFilter = 'all' | 'online';
type SortFilter =
  | 'votes24h_desc'
  | 'votesMonthly_desc'
  | 'playersOnline_desc'
  | 'reviews_desc'
  | 'latest'
  | 'name_asc';

export interface ServerListInitialFilters {
  readonly search: string;
  readonly edition: EditionFilter;
  readonly grade: GradeFilter;
  readonly online: OnlineFilter;
  readonly sort: SortFilter;
  readonly tags: string[];
  readonly page: number;
}

interface ServerListExplorerProps {
  readonly initialRanking: ServerRankingResponse;
  readonly initialFilters: ServerListInitialFilters;
  readonly initialLoadError?: string | null;
  readonly initialUnrankedPreview?: readonly ServerSummary[];
}

export function ServerListExplorer({
  initialRanking,
  initialFilters,
  initialLoadError = null,
  initialUnrankedPreview = [],
}: ServerListExplorerProps) {
  const [ranking, setRanking] = useState(initialRanking);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(initialLoadError);
  const [unrankedPreview, setUnrankedPreview] = useState<readonly ServerSummary[]>(initialUnrankedPreview);
  const [searchQuery, setSearchQuery] = useState(initialFilters.search);
  const [edition, setEdition] = useState<EditionFilter>(initialFilters.edition);
  const [grade, setGrade] = useState<GradeFilter>(initialFilters.grade);
  const [online, setOnline] = useState<OnlineFilter>(initialFilters.online);
  const [sort, setSort] = useState<SortFilter>(initialFilters.sort);
  const [selectedGenres, setSelectedGenres] = useState<GenreKey[]>(() =>
    initialFilters.tags.filter(isGenreKey),
  );
  const [currentPage, setCurrentPage] = useState(initialFilters.page);
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const didMountRef = useRef(false);
  const didFetchRef = useRef(false);
  const rankEpochRef = useRef(initialRanking.rankEpoch);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    if (mobileFilterOpen) {
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileFilterOpen]);

  const servers = ranking.items;

  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    edition !== 'all' ||
    grade !== 'all' ||
    online !== 'all' ||
    sort !== 'votes24h_desc' ||
    selectedGenres.length > 0;

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    setCurrentPage(1);
  }, [searchQuery, edition, grade, online, sort, selectedGenres]);

  const totalPages = Math.max(1, ranking.totalPages);
  const onlineCount = ranking.summary.online;
  const verifiedCount = ranking.summary.verified;
  const hasOnlyUnrankedServers = shouldLoadUnrankedServerPreview(ranking, sort);
  const activeFilterState = {
    search: searchQuery, edition, grade, online, sort, tags: selectedGenres, page: currentPage,
  };
  const unrankedBrowseHref = unrankedServerBrowseHref(activeFilterState);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const resetFilters = () => {
    setSearchQuery('');
    setEdition('all');
    setGrade('all');
    setOnline('all');
    setSort('votes24h_desc');
    setSelectedGenres([]);
    setCurrentPage(1);
  };

  const toggleGenre = (genre: GenreKey) => {
    setSelectedGenres((current) => (current.includes(genre) ? [] : [genre]));
  };

  useEffect(() => {
    if (!didFetchRef.current && !initialLoadError) {
      didFetchRef.current = true;
      return;
    }
    didFetchRef.current = true;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setLoadError(null);
      setUnrankedPreview([]);
      const params = new URLSearchParams();
      if (searchQuery.trim()) params.set('search', searchQuery.trim());
      if (edition !== 'all') params.set('edition', edition);
      if (grade !== 'all') params.set('grade', grade);
      if (online === 'online') params.set('online', 'true');
      if (selectedGenres[0]) params.set('tag', selectedGenres[0]);
      if (sort !== 'votes24h_desc') params.set('sort', sort);
      const query = params.toString();
      const pathname = window.location.pathname === '/' ? '/' : '/servers';
      window.history.replaceState(null, '', query ? `${pathname}?${query}` : pathname);
      try {
        const filters = { search: searchQuery, edition, grade, online, sort, tags: selectedGenres, page: currentPage };
        const nextRanking = await fetchServerRankings(serverRankingRequestFromFilters(filters, {
          pageSize: PAGE_SIZE,
          rankEpoch: sort === 'votes24h_desc' && currentPage > 1 ? rankEpochRef.current ?? undefined : undefined,
        }));
        if (controller.signal.aborted) return;
        let nextPreview: readonly ServerSummary[] = [];
        if (shouldLoadUnrankedServerPreview(nextRanking, sort)) {
          try {
            nextPreview = (await fetchServerRankings(serverRankingRequestFromFilters(filters, {
              sort: 'latest', page: 1, pageSize: PAGE_SIZE,
            }))).items;
          } catch (previewError) {
            if (!controller.signal.aborted) console.warn('Failed to refresh unranked server preview', previewError);
          }
        }
        if (controller.signal.aborted) return;
        rankEpochRef.current = nextRanking.rankEpoch;
        setUnrankedPreview(nextPreview);
        setRanking((current) => {
          if (currentPage === 1) return nextRanking;
          const knownIds = new Set(current.items.map((item) => item.id));
          return {
            ...nextRanking,
            items: [...current.items, ...nextRanking.items.filter((item) => !knownIds.has(item.id))],
          };
        });

      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof RankingEpochConflictError && currentPage > 1) {
          rankEpochRef.current = null;
          setCurrentPage(1);
          setRetryToken((value) => value + 1);
          return;
        }
        console.error('Failed to refresh server rankings', error);
        setLoadError('서버 순위 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [currentPage, edition, grade, initialLoadError, online, retryToken, searchQuery, selectedGenres, sort]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || loading || loadError || currentPage >= totalPages) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setCurrentPage((page) => Math.min(totalPages, page + 1));
        }
      },
      { rootMargin: '320px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [currentPage, loadError, loading, totalPages]);

  return (
    <div className="paper-directory min-h-screen text-[#252925] antialiased">
      <SiteHeader variant="paper" />

      <main className="mx-auto flex w-full max-w-[1440px] flex-col px-4 pb-10 pt-24 sm:px-6 lg:px-8">
        <section className="sticky top-16 z-40 -mx-4 mb-0 border-y border-[#aaa79e]/60 bg-[#f4f2ec]/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <div className="mx-auto flex max-w-[1440px] flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <label className="relative w-full lg:w-[420px]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                <input
                  type="search"
                  aria-label="서버 검색"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="서버명, 주소, 태그 검색"
                  className="paper-control h-10 w-full pl-10 pr-3"
                />
              </label>

              <div className="hidden w-full items-center rounded-md border border-[#aaa79e] bg-white/25 p-1 md:flex md:w-auto">
                <FilterToggleButton
                  active={edition === 'all'}
                  onClick={() => setEdition('all')}
                  label="전체"
                />
                <FilterToggleButton
                  active={edition === 'java'}
                  onClick={() => setEdition('java')}
                  label="Java"
                />
                <FilterToggleButton
                  active={edition === 'bedrock'}
                  onClick={() => setEdition('bedrock')}
                  label="Bedrock"
                />
              </div>

              <select
                aria-label="검증 상태"
                value={grade}
                onChange={(event) => setGrade(event.target.value as GradeFilter)}
                className="paper-control hidden h-10 min-w-[140px] cursor-pointer px-3 md:block"
              >
                <option value="all">모든 상태</option>
                <option value="Verified">Verified</option>
                <option value="Unverified">Unverified</option>
              </select>

              <button
                type="button"
                onClick={() => setMobileFilterOpen(true)}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-[#8f938a] bg-white/25 px-3 text-sm font-medium text-[#343a34] md:hidden"
              >
                <SlidersHorizontal className="h-4 w-4" />
                필터
              </button>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between xl:w-auto">
              <div className="paper-results-summary flex items-center gap-3 text-sm text-[#676c64]">
                {hasOnlyUnrankedServers ? <span>순위 집계 <strong className="paper-results-count text-[#20231f]">0</strong>개 · 등록 서버 <strong className="text-[#20231f]">{ranking.unrankedCount.toLocaleString('ko-KR')}</strong>개</span> : <span>결과 <strong className="paper-results-count text-[#20231f]">{ranking.total.toLocaleString('ko-KR')}</strong>개</span>}
                {ranking.rankUpdatedAt ? (
                  <span className="hidden text-xs text-gray-500 sm:inline">
                    순위 기준 {formatRankUpdatedAt(ranking.rankUpdatedAt)}
                  </span>
                ) : null}
                {sort === 'votes24h_desc' && ranking.unrankedCount > 0 ? (
                  <span className="hidden text-xs text-amber-700 sm:inline">
                    순위 미집계 {ranking.unrankedCount.toLocaleString('ko-KR')}개
                  </span>
                ) : null}
                {loading ? <span className="text-xs text-[#13ec80]">순위 갱신 중</span> : null}
                {loadError ? <span className="text-xs text-red-300">{loadError}</span> : null}
                {hasActiveFilters ? (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="rounded border border-[#13ec80]/30 bg-[#13ec80]/10 px-2 py-1 text-xs font-medium text-[#13ec80] transition hover:bg-[#13ec80]/15"
                  >
                    필터 초기화
                  </button>
                ) : null}
              </div>

              <div className="relative min-w-[120px]">
                <select
                  aria-label="서버 정렬"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortFilter)}
                  className="paper-control h-10 w-full cursor-pointer appearance-none px-3 pr-8 font-medium"
                >
                  <option value="votes24h_desc">24시간 투표순</option>
                  <option value="votesMonthly_desc">월간 투표순</option>
                  <option value="playersOnline_desc">동접순</option>
                  <option value="reviews_desc">리뷰 많은순</option>
                  <option value="latest">최신순</option>
                  <option value="name_asc">이름순</option>
                </select>
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-500">
                  ▼
                </span>
              </div>
            </div>
          </div>
        </section>

        <div className="grid lg:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="paper-filter hidden self-start border-r border-[#aaa79e]/60 p-5 lg:sticky lg:top-[121px] lg:block">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-[#262b25]">
              <ListFilter className="h-4 w-4 text-[#13ec80]" />
              탐색 필터
            </div>
            <div className="space-y-5">
              <FilterGroup title="에디션">
                <div className="grid grid-cols-3 gap-2">
                  <FilterToggleButton
                    active={edition === 'all'}
                    onClick={() => setEdition('all')}
                    label="전체"
                  />
                  <FilterToggleButton
                    active={edition === 'java'}
                    onClick={() => setEdition('java')}
                    label="Java"
                  />
                  <FilterToggleButton
                    active={edition === 'bedrock'}
                    onClick={() => setEdition('bedrock')}
                    label="Bedrock"
                  />
                </div>
              </FilterGroup>
              <FilterGroup title="검증 상태">
                <div className="grid gap-2">
                  <FilterToggleButton
                    active={grade === 'all'}
                    onClick={() => setGrade('all')}
                    label="모든 상태"
                  />
                  <FilterToggleButton
                    active={grade === 'Verified'}
                    onClick={() => setGrade('Verified')}
                    label="Verified"
                  />
                  <FilterToggleButton
                    active={grade === 'Unverified'}
                    onClick={() => setGrade('Unverified')}
                    label="Unverified"
                  />
                </div>
              </FilterGroup>
              <FilterGroup title="접속 상태">
                <div className="grid grid-cols-2 gap-2">
                  <FilterToggleButton
                    active={online === 'all'}
                    onClick={() => setOnline('all')}
                    label="전체"
                  />
                  <FilterToggleButton
                    active={online === 'online'}
                    onClick={() => setOnline('online')}
                    label="온라인"
                  />
                </div>
              </FilterGroup>
              <FilterGroup title="장르">
                <div className="flex flex-wrap gap-2">
                  {GENRE_OPTIONS.map((genre) => {
                    const active = selectedGenres.includes(genre.key);
                    return (
                      <button
                        key={genre.key}
                        type="button"
                        onClick={() => toggleGenre(genre.key)}
                        className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                          active
                            ? 'border-[#13ec80]/40 bg-[#13ec80]/15 text-[#13ec80]'
                            : 'border-[#aaa79e] bg-white/20 text-[#4e544d] hover:border-[#6f746c]'
                        }`}
                      >
                        {genre.label}
                      </button>
                    );
                  })}
                </div>
              </FilterGroup>
              <FilterGroup title="품질 지표">
                <div className="grid grid-cols-2 gap-2">
                  <SideStat label="검증" value={verifiedCount.toLocaleString('ko-KR')} />
                  <SideStat label="온라인" value={onlineCount.toLocaleString('ko-KR')} />
                </div>
              </FilterGroup>
            </div>
          </aside>

          <div className="min-w-0">
            {servers.length === 0 && loadError ? (
              <section className="flex min-h-[360px] flex-col items-center justify-center rounded-xl border border-red-400/20 bg-red-500/[0.06] px-6 py-16 text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-red-500/10">
                  <WifiOff className="h-7 w-7 text-red-200" />
                </div>
                <h2 className="mb-2 text-lg font-bold text-white">서버 순위를 불러오지 못했습니다</h2>
                <p className="mb-6 max-w-md text-sm leading-6 text-red-100/70">{loadError}</p>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => setRetryToken((value) => value + 1)}
                  className="rounded-lg bg-[#13ec80] px-4 py-2 text-sm font-bold text-[#07100b] transition hover:bg-[#38f09b] disabled:cursor-wait disabled:opacity-60"
                >
                  {loading ? '다시 연결 중' : '다시 시도'}
                </button>
              </section>
            ) : servers.length === 0 && hasOnlyUnrankedServers ? (
              <div className="mb-12">
                <section className="flex flex-col gap-4 border-b border-amber-700/30 bg-amber-500/[0.05] px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-lg bg-amber-500/10"><Activity className="h-5 w-5 text-amber-700" /></span>
                    <div><h2 className="font-bold text-[#252925]">투표 순위 집계 전입니다</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-[#676c64]">유효한 투표가 생긴 서버부터 정기 집계에 순위가 표시됩니다. 아래 서버는 순위 번호 없이 최신 등록순으로 안내합니다.</p></div>
                  </div>
                  <Link href={unrankedBrowseHref} className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg bg-[#247253] px-4 text-sm font-bold text-white transition hover:bg-[#1d6045]">등록된 서버 전체 보기</Link>
                </section>
                {unrankedPreview.length > 0 ? <section aria-labelledby="unranked-server-preview-title" className="divide-y divide-[#aaa79e]/55 border-b border-[#aaa79e]/55">
                  <h2 id="unranked-server-preview-title" className="sr-only">순위 집계 전 등록 서버</h2>
                  {unrankedPreview.map((server) => <ServerCard key={server.id} server={server} rank={null} />)}
                </section> : loading ? <p className="flex min-h-28 items-center justify-center text-sm text-[#676c64]" role="status">등록 서버를 불러오는 중입니다.</p> : <p className="border-b border-[#aaa79e]/55 px-5 py-8 text-center text-sm text-[#676c64]">미리보기를 불러오지 못했습니다. 전체 보기에서 등록 서버를 확인할 수 있습니다.</p>}
              </div>
            ) : servers.length === 0 ? (
              <section className="flex min-h-[360px] flex-col items-center justify-center rounded-xl border border-dashed border-gray-800 bg-[#111821] px-6 py-16 text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-[#1A1A1E]">
                  <SearchX className="h-7 w-7 text-gray-500" />
                </div>
                <h2 className="mb-2 text-lg font-bold text-white">조건에 맞는 서버가 없습니다</h2>
                <p className="mb-6 text-sm text-gray-500">
                  장르, 검증 상태, 검색어를 줄여서 다시 확인해보세요.
                </p>
                <button
                  type="button"
                  onClick={resetFilters}
                  className="rounded-lg bg-[#252529] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#33363d]"
                >
                  필터 초기화
                </button>
              </section>
            ) : (
              <section className="mb-12 divide-y divide-[#aaa79e]/55 border-b border-[#aaa79e]/55">
                {servers.map((server) => (
                  <ServerCard
                    key={server.id}
                    server={server}
                    rank={sort === 'votes24h_desc' ? server.rank?.current ?? null : null}
                  />
                ))}
              </section>
            )}
          </div>
        </div>

        <div ref={loadMoreRef} className="flex min-h-20 items-center justify-center pb-8" aria-live="polite">
          {loading && currentPage > 1 ? (
            <div className="flex items-center gap-3 text-sm text-[#5e655d]">
              <span className="h-2 w-2 animate-pulse rounded-full bg-[#247253]" />
              다음 서버를 펼치는 중
            </div>
          ) : currentPage < totalPages ? (
            <span className="paper-load-more-hint text-xs font-semibold uppercase tracking-[0.16em] text-[#777b73]">
              아래로 스크롤하면 더 불러옵니다
            </span>
          ) : servers.length > 0 || unrankedPreview.length > 0 ? (
            <span className="text-xs text-[#777b73]">모든 서버를 확인했습니다.</span>
          ) : null}
        </div>
      </main>

      <SiteFooter variant="paper" />

      {mobileFilterOpen ? (
        <div className="fixed inset-0 z-[60] md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileFilterOpen(false)}
            aria-label="필터 닫기"
          />
          <aside className="paper-mobile-filter absolute right-0 top-0 h-full w-[88%] max-w-sm overflow-y-auto border-l border-[#aaa79e] p-5">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#20251f]">필터</h2>
              <button
                type="button"
                onClick={() => setMobileFilterOpen(false)}
                className="rounded-md border border-[#8f938a] p-2 text-[#424841]"
                aria-label="닫기"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-5 pb-20">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
                  에디션
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <FilterToggleButton
                    active={edition === 'all'}
                    onClick={() => setEdition('all')}
                    label="전체"
                  />
                  <FilterToggleButton
                    active={edition === 'java'}
                    onClick={() => setEdition('java')}
                    label="Java"
                  />
                  <FilterToggleButton
                    active={edition === 'bedrock'}
                    onClick={() => setEdition('bedrock')}
                    label="Bedrock"
                  />
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
                  검증 상태
                </p>
                <select
                  aria-label="검증 상태"
                  value={grade}
                  onChange={(event) => setGrade(event.target.value as GradeFilter)}
                  className="paper-control h-10 w-full px-3"
                >
                  <option value="all">모든 상태</option>
                  <option value="Verified">Verified</option>
                  <option value="Unverified">Unverified</option>
                </select>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
                  접속 상태
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <FilterToggleButton
                    active={online === 'all'}
                    onClick={() => setOnline('all')}
                    label="전체"
                  />
                  <FilterToggleButton
                    active={online === 'online'}
                    onClick={() => setOnline('online')}
                    label="온라인"
                  />
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
                  정렬
                </p>
                <select
                  aria-label="서버 정렬"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortFilter)}
                  className="paper-control h-10 w-full px-3"
                >
                  <option value="votes24h_desc">24시간 투표순</option>
                  <option value="votesMonthly_desc">월간 투표순</option>
                  <option value="playersOnline_desc">동접순</option>
                  <option value="reviews_desc">리뷰 많은순</option>
                  <option value="latest">최신순</option>
                  <option value="name_asc">이름순</option>
                </select>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
                  장르 태그
                </p>
                <div className="flex flex-wrap gap-2">
                  {GENRE_OPTIONS.map((genre) => {
                    const active = selectedGenres.includes(genre.key);
                    return (
                      <button
                        key={genre.key}
                        type="button"
                        onClick={() => toggleGenre(genre.key)}
                        className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
                          active
                            ? 'border-[#13ec80]/40 bg-[#13ec80]/15 text-[#13ec80]'
                            : 'border-[#aaa79e] bg-white/20 text-[#4e544d]'
                        }`}
                      >
                        {genre.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="fixed bottom-0 right-0 w-[88%] max-w-sm border-t border-[#aaa79e] bg-[#efede6] p-4">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={resetFilters}
                  className="flex-1 rounded-lg border border-[#8f938a] bg-white/25 py-2.5 text-sm font-semibold text-[#343a34]"
                >
                  초기화
                </button>
                <button
                  type="button"
                  onClick={() => setMobileFilterOpen(false)}
                  className="flex-1 rounded-lg bg-[#13ec80] py-2.5 text-sm font-semibold text-[#101012]"
                >
                  적용
                </button>
              </div>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function FilterGroup({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase text-[#666b63]">{title}</h2>
      {children}
    </section>
  );
}

function SideStat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-md border border-[#b7b3a9] bg-white/20 px-3 py-2">
      <p className="paper-side-stat-label text-[11px] text-[#72766e]">{label}</p>
      <p className="mt-1 text-sm font-bold text-[#242824]">{value}</p>
    </div>
  );
}

function ServerCard({ server, rank }: { readonly server: ServerSummary; readonly rank: number | null }) {
  const online = resolveOnline(server);
  const badgeTone = getGradeTone(server.verificationGrade);
  const fallback = getServerPreviewFallbackClass(getServerPreviewSeed(server));
  const fallbackInitial = getServerPreviewInitial(server.name);
  const hostPort = `${server.joinHost}:${server.joinPort}`;
  const reviewMetric = formatReviewMetric(server);
  const serverPath = buildServerPath(server);
  const versionLabel = server.supportedVersions[0] ?? '-';
  const hasMoreVersions = server.supportedVersions.length > 1;
  const updatedAt = formatUpdatedAt(server.playersLastUpdatedAt);

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(hostPort);
    } catch {
      // no-op
    }
  };

  return (
    <article className="paper-server-row group px-4 py-4 transition-colors hover:bg-[#e3eadf]/55">
      <div className="grid gap-3 lg:grid-cols-[42px_112px_minmax(0,1fr)_340px] lg:items-center">
        <div className="hidden text-center text-sm font-bold text-gray-500 lg:block">{rank ?? '—'}</div>

        <div className="relative h-20 overflow-hidden border border-[#b7b3a9] bg-[#e8e5de] sm:h-20 lg:h-[74px]">
          {server.bannerUrl ? (
            <Image
              alt={`${server.name} 배너`}
              fill
              sizes="(min-width: 1024px) 112px, 100vw"
              className="object-cover"
              src={server.bannerUrl}
              unoptimized
            />
          ) : (
            <div className={`flex h-full w-full items-center justify-center ${fallback}`}>
              <span className="server-preview-initial text-2xl font-black">{fallbackInitial}</span>
            </div>
          )}
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {rank ? <span className="rounded border border-gray-700 bg-[#090d12] px-2 py-0.5 text-xs font-bold text-gray-400 lg:hidden">
              #{rank}
            </span> : null}
            <Link
              href={serverPath}
              className="min-w-0 truncate text-base font-bold text-white transition-colors hover:text-[#13ec80]"
            >
              {server.name}
            </Link>
            <span
              className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-bold ${
                online
                  ? 'border-[#13ec80]/30 bg-[#13ec80]/10 text-[#13ec80]'
                  : 'border-red-500/30 bg-red-500/10 text-red-200'
              }`}
            >
              {online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              {online ? 'ONLINE' : 'OFFLINE'}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-bold ${
                badgeTone === 'V'
                  ? 'border-[#13ec80]/30 bg-[#13ec80]/10 text-[#13ec80]'
                  : 'border-amber-400/35 bg-amber-500/10 text-amber-200'
              }`}
            >
              {badgeTone === 'V' ? (
                <BadgeCheck className="h-3 w-3" />
              ) : (
                <ShieldCheck className="h-3 w-3" />
              )}
              {server.verificationGrade === 'Unverified' ? '미검증' : '검증'}
            </span>
          </div>

          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
            <span className="max-w-full truncate rounded border border-gray-700 bg-[#090d12] px-2 py-1 font-mono text-xs text-gray-300">
              {hostPort}
            </span>
            <button
              type="button"
              onClick={copyAddress}
              className="inline-flex h-7 w-7 items-center justify-center rounded border border-gray-700 text-gray-500 transition-colors hover:border-white/20 hover:text-white"
              aria-label="서버 주소 복사"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
            <span className="rounded border border-gray-700 bg-[#090d12] px-2 py-1 text-xs text-gray-300">
              {server.edition === 'java' ? 'Java' : 'Bedrock'}
            </span>
            <span className="rounded border border-gray-700 bg-[#090d12] px-2 py-1 text-xs text-gray-300">
              {versionLabel}
              {hasMoreVersions ? ` +${server.supportedVersions.length - 1}` : ''}
            </span>
            {server.voteRequiresOwnership ? (
              <span className="rounded border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-100">
                인증투표
              </span>
            ) : null}
          </div>

          <p className="mt-2 line-clamp-2 text-sm leading-5 text-gray-400">
            {server.shortDescription}
          </p>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {server.tags.slice(0, 4).map((tag) => (
              <span
                key={`${server.id}-${tag}`}
                className="rounded border border-white/10 bg-[#090d12] px-2 py-0.5 text-[11px] text-gray-400"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto] lg:grid-cols-1">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2">
            <MetricCell
              icon={<ThumbsUp className="h-3.5 w-3.5 text-[#13ec80]" />}
              label="24h"
              value={server.votes24h.toLocaleString('ko-KR')}
            />
            <MetricCell
              icon={<Activity className="h-3.5 w-3.5 text-emerald-300" />}
              label="월간"
              value={(server.votesMonthly ?? 0).toLocaleString('ko-KR')}
            />
            <MetricCell
              icon={<Users className="h-3.5 w-3.5 text-cyan-300" />}
              label="인원"
              value={formatPlayers(server)}
            />
            <MetricCell
              icon={<Star className="h-3.5 w-3.5 text-yellow-300" />}
              label="리뷰"
              value={reviewMetric}
            />
          </div>

          <div className="flex items-center gap-2 lg:justify-end">
            <span className="hidden min-w-0 flex-1 truncate text-xs text-gray-500 sm:block lg:hidden">
              {updatedAt}
            </span>
            <Link
              href={serverPath}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-white/15 px-3 text-sm font-medium text-gray-300 transition-colors hover:border-white/30 hover:bg-white/5 hover:text-white"
            >
              상세
            </Link>
            <Link
              href={`${serverPath}?vote=1`}
              className="inline-flex h-9 items-center justify-center rounded-lg bg-[#13ec80] px-3 text-sm font-bold text-[#07100b] transition-colors hover:bg-[#38f09b]"
            >
              투표
            </Link>
          </div>
          <p className="hidden truncate text-right text-xs text-gray-500 lg:block">{updatedAt}</p>
        </div>
      </div>
    </article>
  );
}

function MetricCell({
  icon,
  label,
  value,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="min-w-0 border-l border-[#b7b3a9]/70 px-3 py-1 first:border-l-0">
      <span className="flex items-center gap-1 text-[11px] text-[#74786f]">
        {icon}
        {label}
      </span>
      <span className="mt-1 block truncate text-sm font-semibold text-[#242824]">{value}</span>
    </div>
  );
}

function FilterToggleButton({
  active,
  onClick,
  label,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-medium transition-colors ${
        active
          ? 'border-[#2b7959]/60 bg-[#dce9dd]/80 text-[#1f694c]'
          : 'border-transparent bg-transparent text-[#555b54] hover:border-[#aaa79e] hover:text-[#20251f]'
      }`}
    >
      {label}
    </button>
  );
}

function isGenreKey(value: string): value is GenreKey {
  return GENRE_OPTIONS.some((option) => option.key === value);
}

function resolveOnline(server: ServerSummary): boolean {
  if (typeof server.isOnline === 'boolean') {
    return server.isOnline;
  }
  if (typeof server.playersOnline === 'number') {
    return server.playersOnline > 0;
  }
  return false;
}

function formatPlayers(server: ServerSummary): string {
  if (server.isOnline === false) {
    return '오프라인';
  }

  const playersOnline = typeof server.playersOnline === 'number' ? server.playersOnline : null;
  const playersMax = typeof server.playersMax === 'number' ? server.playersMax : null;

  if (playersOnline === null && playersMax === null) {
    return '-';
  }
  if (playersOnline !== null && playersMax !== null) {
    return `${playersOnline.toLocaleString('ko-KR')} / ${playersMax.toLocaleString('ko-KR')}`;
  }
  if (playersOnline !== null) {
    return playersOnline.toLocaleString('ko-KR');
  }
  return `- / ${playersMax?.toLocaleString('ko-KR')}`;
}

function formatUpdatedAt(value?: string | null): string {
  if (!value) {
    return '접속 정보 없음';
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return '접속 정보 없음';
  }
  return `업데이트 ${new Date(timestamp).toLocaleString('ko-KR')}`;
}

function formatRankUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '집계 대기';
  }
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatReviewMetric(server: ServerSummary): string {
  if (server.reviewsCount <= 0) {
    return '-';
  }
  return server.reviewsCount.toLocaleString('ko-KR');
}

function getGradeTone(grade: ServerSummary['verificationGrade']): 'V' | 'U' {
  return grade === 'Verified' ? 'V' : 'U';
}

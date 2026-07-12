'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ServerRankingResponse, ServerSummary } from '@minewiki/schemas';
import {
  Activity,
  BadgeCheck,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
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
import {
  getServerPreviewFallbackClass,
  getServerPreviewInitial,
  getServerPreviewSeed,
} from '../../lib/server-preview';
import { buildServerPath } from '../../lib/server-routes';
import { fetchServerRankings } from '../../lib/api';

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
}

export function ServerListExplorer({
  initialRanking,
  initialFilters,
  initialLoadError = null,
}: ServerListExplorerProps) {
  const [ranking, setRanking] = useState(initialRanking);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(initialLoadError);
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
  const totalVotes24h = ranking.summary.votes24h;

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const pageTokens = useMemo(
    () => buildPageTokens(totalPages, currentPage),
    [totalPages, currentPage],
  );

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
      const params = new URLSearchParams();
      if (searchQuery.trim()) params.set('search', searchQuery.trim());
      if (edition !== 'all') params.set('edition', edition);
      if (grade !== 'all') params.set('grade', grade);
      if (online === 'online') params.set('online', 'true');
      if (selectedGenres[0]) params.set('tag', selectedGenres[0]);
      if (sort !== 'votes24h_desc') params.set('sort', sort);
      if (currentPage > 1) params.set('page', String(currentPage));
      const query = params.toString();
      window.history.replaceState(null, '', query ? `/servers?${query}` : '/servers');
      try {
        const nextRanking = await fetchServerRankings({
          edition: edition === 'all' ? undefined : edition,
          grade: grade === 'all' ? undefined : grade,
          online: online === 'online' ? true : undefined,
          tag: selectedGenres[0],
          search: searchQuery.trim() || undefined,
          sort,
          page: currentPage,
          pageSize: PAGE_SIZE,
        });
        if (controller.signal.aborted) return;
        setRanking(nextRanking);

      } catch (error) {
        if (controller.signal.aborted) return;
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

  return (
    <div className="min-h-screen bg-[#090d12] text-gray-100 antialiased">
      <SiteHeader />

      <main className="mx-auto flex w-full max-w-[1440px] flex-col px-4 pb-10 pt-24 sm:px-6 lg:px-8">
        <header className="mb-5 border-b border-white/10 pb-5">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#13ec80]">
                Minecraft Server Directory
              </p>
              <h1 className="mt-2 text-2xl font-bold text-white sm:text-3xl">
                한국 마인크래프트 서버 목록
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-400">
                접속 상태, 투표, 리뷰, 에디션을 한 화면에서 비교하세요.
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-[repeat(3,minmax(116px,1fr))_auto] lg:min-w-[560px]">
              <HeaderStat label="등록" value={ranking.total.toLocaleString('ko-KR')} />
              <HeaderStat label="온라인" value={onlineCount.toLocaleString('ko-KR')} tone="cyan" />
              <HeaderStat
                label="24h 투표"
                value={totalVotes24h.toLocaleString('ko-KR')}
                tone="emerald"
              />
              <Link
                href="/servers/register"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-[#13ec80] px-4 text-sm font-bold text-[#07100b] transition-colors hover:bg-[#38f09b]"
              >
                <ExternalLink className="h-4 w-4" />
                서버 등록하기
              </Link>
            </div>
          </div>
        </header>

        <section className="sticky top-16 z-40 -mx-4 mb-5 border-b border-white/10 bg-[#090d12]/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <div className="mx-auto flex max-w-[1440px] flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <label className="relative w-full lg:w-[420px]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="서버명, 주소, 태그 검색"
                  className="h-10 w-full rounded-lg border border-white/10 bg-[#111821] pl-10 pr-3 text-sm text-white placeholder:text-gray-500 focus:border-[#13ec80] focus:outline-none focus:ring-2 focus:ring-[#13ec80]/15"
                />
              </label>

              <div className="hidden w-full items-center rounded-lg border border-gray-700 bg-[#1A1A1E] p-1 md:flex md:w-auto">
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
                value={grade}
                onChange={(event) => setGrade(event.target.value as GradeFilter)}
                className="hidden h-10 min-w-[140px] cursor-pointer rounded-lg border border-gray-700 bg-[#1A1A1E] px-3 text-sm text-gray-200 focus:border-[#13ec80] focus:outline-none md:block"
              >
                <option value="all">모든 상태</option>
                <option value="Verified">Verified</option>
                <option value="Unverified">Unverified</option>
              </select>

              <button
                type="button"
                onClick={() => setMobileFilterOpen(true)}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-gray-700 bg-[#111821] px-3 text-sm font-medium text-gray-200 md:hidden"
              >
                <SlidersHorizontal className="h-4 w-4" />
                필터
              </button>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between xl:w-auto">
              <div className="flex items-center gap-3 text-sm text-gray-400">
                <span>
                  결과{' '}
                  <strong className="text-white">
                    {ranking.total.toLocaleString('ko-KR')}
                  </strong>
                  개
                </span>
                {ranking.rankUpdatedAt ? (
                  <span className="hidden text-xs text-gray-500 sm:inline">
                    순위 기준 {formatRankUpdatedAt(ranking.rankUpdatedAt)}
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
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortFilter)}
                  className="h-10 w-full cursor-pointer appearance-none rounded-lg border border-gray-700 bg-[#111821] px-3 pr-8 text-sm font-medium text-gray-300 focus:border-[#13ec80] focus:outline-none"
                >
                  <option value="votes24h_desc">투표순</option>
                  <option value="votesMonthly_desc">월간 투표순</option>
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

        <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="hidden self-start rounded-xl border border-white/10 bg-[#111821] p-4 lg:sticky lg:top-36 lg:block">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
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
                            : 'border-white/10 bg-[#090d12] text-gray-300 hover:border-white/25'
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
              <section className="mb-12 grid gap-3">
                {servers.map((server, index) => (
                  <ServerCard
                    key={server.id}
                    server={server}
                    rank={server.rank?.current ?? (currentPage - 1) * PAGE_SIZE + index + 1}
                  />
                ))}
              </section>
            )}
          </div>
        </div>

        {totalPages > 1 ? (
          <nav className="mt-auto flex items-center justify-center gap-2 pb-12">
            <button
              type="button"
              disabled={currentPage === 1}
              onClick={() => setCurrentPage((value) => Math.max(1, value - 1))}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-gray-800 text-gray-500 transition-colors hover:bg-[#1A1A1E] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="이전 페이지"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>

            {pageTokens.map((token, index) =>
              token === 'ellipsis' ? (
                <span
                  key={`ellipsis-${index}`}
                  className="inline-flex h-10 w-10 items-center justify-center text-gray-600"
                >
                  ...
                </span>
              ) : (
                <button
                  key={token}
                  type="button"
                  onClick={() => setCurrentPage(token)}
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-lg border text-sm font-bold transition-colors ${
                    token === currentPage
                      ? 'border-[#13ec80]/40 bg-[#13ec80] text-[#101012]'
                      : 'border-gray-800 text-gray-400 hover:bg-[#1A1A1E] hover:text-white'
                  }`}
                >
                  {token}
                </button>
              ),
            )}

            <button
              type="button"
              disabled={currentPage === totalPages}
              onClick={() => setCurrentPage((value) => Math.min(totalPages, value + 1))}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-gray-800 text-gray-400 transition-colors hover:bg-[#1A1A1E] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="다음 페이지"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </nav>
        ) : null}
      </main>

      {mobileFilterOpen ? (
        <div className="fixed inset-0 z-[60] md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileFilterOpen(false)}
            aria-label="필터 닫기"
          />
          <aside className="absolute right-0 top-0 h-full w-[88%] max-w-sm overflow-y-auto border-l border-gray-700 bg-[#121212] p-5">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">필터</h2>
              <button
                type="button"
                onClick={() => setMobileFilterOpen(false)}
                className="rounded-lg border border-gray-700 p-2 text-gray-300"
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
                  value={grade}
                  onChange={(event) => setGrade(event.target.value as GradeFilter)}
                  className="h-10 w-full rounded-lg border border-gray-700 bg-[#1A1A1E] px-3 text-sm text-gray-200 focus:border-[#13ec80] focus:outline-none"
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
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortFilter)}
                  className="h-10 w-full rounded-lg border border-gray-700 bg-[#1A1A1E] px-3 text-sm text-gray-200 focus:border-[#13ec80] focus:outline-none"
                >
                  <option value="votes24h_desc">투표순</option>
                  <option value="votesMonthly_desc">월간 투표순</option>
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
                            : 'border-gray-700 bg-[#1A1A1E] text-gray-300'
                        }`}
                      >
                        {genre.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="fixed bottom-0 right-0 w-[88%] max-w-sm border-t border-gray-700 bg-[#121212] p-4">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={resetFilters}
                  className="flex-1 rounded-lg border border-gray-700 bg-[#1A1A1E] py-2.5 text-sm font-semibold text-gray-200"
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

function HeaderStat({
  label,
  value,
  tone = 'slate',
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'slate' | 'cyan' | 'emerald';
}) {
  const valueClass =
    tone === 'cyan' ? 'text-cyan-300' : tone === 'emerald' ? 'text-[#13ec80]' : 'text-white';

  return (
    <div className="rounded-lg border border-white/10 bg-[#111821] px-3 py-2">
      <p className="text-[11px] font-medium text-gray-500">{label}</p>
      <p className={`mt-0.5 text-lg font-bold ${valueClass}`}>{value}</p>
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
      <h2 className="mb-2 text-xs font-semibold uppercase text-gray-500">{title}</h2>
      {children}
    </section>
  );
}

function SideStat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-[#090d12] px-3 py-2">
      <p className="text-[11px] text-gray-500">{label}</p>
      <p className="mt-1 text-sm font-bold text-white">{value}</p>
    </div>
  );
}

function ServerCard({ server, rank }: { readonly server: ServerSummary; readonly rank: number }) {
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
    <article className="group rounded-xl border border-white/10 bg-[#111821] p-3 transition-colors hover:border-[#13ec80]/35 hover:bg-[#131d28]">
      <div className="grid gap-3 lg:grid-cols-[42px_112px_minmax(0,1fr)_340px] lg:items-center">
        <div className="hidden text-center text-sm font-bold text-gray-500 lg:block">{rank}</div>

        <div className="relative h-20 overflow-hidden rounded-lg border border-white/10 bg-[#1A1A1E] sm:h-20 lg:h-[74px]">
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
              <span className="text-2xl font-black text-white/45">{fallbackInitial}</span>
            </div>
          )}
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-gray-700 bg-[#090d12] px-2 py-0.5 text-xs font-bold text-gray-400 lg:hidden">
              #{rank}
            </span>
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
            {online ? (
              <Link
                href={`${serverPath}?vote=1`}
                className="inline-flex h-9 items-center justify-center rounded-lg bg-[#13ec80] px-3 text-sm font-bold text-[#07100b] transition-colors hover:bg-[#38f09b]"
              >
                투표
              </Link>
            ) : (
              <span className="inline-flex h-9 cursor-not-allowed items-center justify-center rounded-lg bg-gray-800 px-3 text-sm font-bold text-gray-500">
                투표 불가
              </span>
            )}
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
    <div className="min-w-0 rounded-lg border border-white/10 bg-[#090d12] px-2 py-2">
      <span className="flex items-center gap-1 text-[11px] text-gray-500">
        {icon}
        {label}
      </span>
      <span className="mt-0.5 block truncate text-sm font-semibold text-white">{value}</span>
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
          ? 'border-[#13ec80]/40 bg-[#13ec80]/15 text-[#13ec80]'
          : 'border-transparent bg-transparent text-gray-400 hover:border-gray-600 hover:text-white'
      }`}
    >
      {label}
    </button>
  );
}

function buildPageTokens(totalPages: number, currentPage: number): Array<number | 'ellipsis'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  if (currentPage <= 3) {
    return [1, 2, 3, 4, 'ellipsis', totalPages];
  }

  if (currentPage >= totalPages - 2) {
    return [1, 'ellipsis', totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }

  return [1, 'ellipsis', currentPage - 1, currentPage, currentPage + 1, 'ellipsis', totalPages];
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

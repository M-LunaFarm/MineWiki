'use client';

import type { FormEvent, MouseEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

const EDITION_FILTERS = [
  { label: 'Java', query: { edition: 'java' } },
  { label: 'Bedrock', query: { edition: 'bedrock' } },
] as const;

const GENRE_FILTERS = [
  { label: '생존', tag: 'survival' },
  { label: '크리에이티브', tag: 'creative' },
  { label: '스카이블록', tag: 'skyblock' },
  { label: 'RPG', tag: 'rpg' },
  { label: '미니게임', tag: 'minigame' },
  { label: '경제', tag: 'economy' },
] as const;

export function NavLinks() {
  const router = useRouter();
  const [isServersOpen, setServersOpen] = useState(false);

  const buildParamsWithUpdates = useCallback((updates: Record<string, string>) => {
    let params = new URLSearchParams();
    if (typeof window !== 'undefined' && window.location.pathname === '/servers') {
      params = new URLSearchParams(window.location.search);
    }
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === null || value === '') {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }
    params.delete('page');
    const queryString = params.toString();
    return `/servers${queryString ? `?${queryString}` : ''}`;
  }, []);

  const navigateWithQuery = useCallback(
    (query: Record<string, string>) => {
      router.push(buildParamsWithUpdates(query));
      setServersOpen(false);
    },
    [router, buildParamsWithUpdates],
  );

  const handleEditionClick = (
    event: MouseEvent<HTMLButtonElement>,
    query: (typeof EDITION_FILTERS)[number]['query'],
  ) => {
    event.preventDefault();
    navigateWithQuery(query);
  };

  const handleGenreClick = (event: MouseEvent<HTMLButtonElement>, tag: string) => {
    event.preventDefault();
    navigateWithQuery({ tag });
  };

  return (
    <nav className="hidden flex-1 items-center justify-center gap-6 md:flex">
      <div
        className="relative"
        onMouseEnter={() => setServersOpen(true)}
        onMouseLeave={() => setServersOpen(false)}
      >
        <Link
          href="/servers"
          className="rounded-lg px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/5"
        >
          서버 목록
        </Link>
        {isServersOpen ? (
          <div className="absolute left-1/2 top-full z-30 mt-2 w-56 -translate-x-1/2 rounded-xl border border-white/[.12] bg-slate-950/95 p-3 shadow-xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Edition</p>
            <div className="mt-2 space-y-1.5">
              {EDITION_FILTERS.map((edition) => (
                <button
                  key={edition.label}
                  type="button"
                  className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-slate-200 transition hover:bg-white/5"
                  onClick={(event) => handleEditionClick(event, edition.query)}
                >
                  {edition.label}
                </button>
              ))}
            </div>

            <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Tag</p>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {GENRE_FILTERS.map((genre) => (
                <button
                  key={genre.tag}
                  type="button"
                  className="rounded-lg px-2 py-1.5 text-left text-xs text-slate-300 transition hover:bg-white/5"
                  onClick={(event) => handleGenreClick(event, genre.tag)}
                >
                  {genre.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <SearchBox />
    </nav>
  );
}

function SearchBox() {
  const router = useRouter();
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const initialSearch = params.get('search') ?? '';
    setQuery(initialSearch);
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.trim();
    let paramsString = '/servers';
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(
        window.location.pathname === '/servers' ? window.location.search : '',
      );
      if (trimmed) {
        params.set('search', trimmed);
      } else {
        params.delete('search');
      }
      params.delete('page');
      const qs = params.toString();
      paramsString = `/servers${qs ? `?${qs}` : ''}`;
    } else if (trimmed) {
      paramsString = `/servers?search=${encodeURIComponent(trimmed)}`;
    }
    router.push(paramsString);
    setQuery(trimmed);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-2 rounded-lg border border-white/[.12] bg-slate-950/70 px-3 py-1.5 text-sm text-slate-300"
    >
      <input
        className="w-40 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
        placeholder="서버 검색"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        type="search"
      />
      <button
        type="submit"
        className="rounded-md border border-emerald-300/40 bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-500/25"
      >
        검색
      </button>
    </form>
  );
}

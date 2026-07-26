'use client';

import Link from 'next/link';
import { Search } from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { fetchWikiSuggestions, type WikiSearchResult } from '../../lib/wiki-api';

interface WikiSearchSuggestFormProps {
  readonly query: string;
  readonly target: 'all' | 'title' | 'content';
  readonly namespace: string;
}

export function WikiSearchSuggestForm({
  query,
  target,
  namespace,
}: WikiSearchSuggestFormProps) {
  const listId = useId();
  const [value, setValue] = useState(query);
  const [focused, setFocused] = useState(false);
  const [items, setItems] = useState<WikiSearchResult[]>([]);
  const [exactMatch, setExactMatch] = useState<WikiSearchResult | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setValue(query);
  }, [query]);

  useEffect(() => {
    const normalizedQuery = value.trim();
    if (!focused || !normalizedQuery) {
      setItems([]);
      setExactMatch(null);
      setActiveIndex(-1);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void fetchWikiSuggestions(normalizedQuery)
        .then((result) => {
          if (!active) return;
          setItems(result.items);
          setExactMatch(result.exactMatch);
          setActiveIndex(-1);
        })
        .catch(() => {
          if (!active) return;
          setItems([]);
          setExactMatch(null);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 100);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [focused, value]);

  const suggestions = useMemo(() => {
    if (!exactMatch) return items;
    return [exactMatch, ...items.filter((item) => item.pageId !== exactMatch.pageId)];
  }, [exactMatch, items]);

  const open = focused && value.trim().length > 0;

  function submit(event: FormEvent<HTMLFormElement>) {
    const selected = activeIndex >= 0 ? suggestions[activeIndex] : exactMatch;
    if (!selected) return;
    event.preventDefault();
    window.location.assign(selected.routePath);
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault();
      setActiveIndex((current) => (current >= suggestions.length - 1 ? 0 : current + 1));
      return;
    }
    if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault();
      setActiveIndex((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
      return;
    }
    if (event.key === 'Escape') {
      setFocused(false);
      setActiveIndex(-1);
    }
  }

  return (
    <form
      action="/search"
      className="surface-card grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_14rem_12rem_auto]"
      onSubmit={submit}
    >
      <div
        className="relative"
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setFocused(false);
            setActiveIndex(-1);
          }
        }}
      >
        <label className="relative block">
          <span className="sr-only">서버와 위키 통합 검색</span>
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            name="q"
            type="search"
            role="combobox"
            maxLength={100}
            autoComplete="off"
            value={value}
            aria-label="서버와 위키 통합 검색"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
            placeholder="문서 제목을 입력하면 바로 찾아드려요"
            className="h-12 w-full rounded-xl border border-white/10 bg-black/20 pl-10 pr-3 text-sm text-white placeholder:text-slate-500 focus:border-[#35e5b7]/50 focus:outline-none focus:ring-2 focus:ring-[#35e5b7]/10"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={keyDown}
          />
        </label>

        {open ? (
          <div
            id={listId}
            role="listbox"
            aria-label="위키 제목 제안"
            className="wiki-search-suggest-results absolute inset-x-0 top-[3.25rem] z-40 overflow-hidden rounded-xl border border-white/10 bg-[#10151b] text-slate-100 shadow-2xl"
            onMouseDown={(event) => event.preventDefault()}
          >
            {suggestions.map((item, index) => {
              const isExact = exactMatch?.pageId === item.pageId;
              return (
                <Link
                  id={`${listId}-${index}`}
                  key={item.pageId}
                  href={item.routePath}
                  role="option"
                  aria-selected={activeIndex === index}
                  className="wiki-search-suggest-result block border-b border-white/[0.07] px-4 py-3 text-left transition last:border-0 hover:bg-white/[0.05] aria-selected:bg-emerald-300/10"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold">{item.displayTitle}</span>
                    {isExact ? (
                      <span className="wiki-search-suggest-badge shrink-0 rounded-full bg-[#35e5b7]/10 px-2 py-0.5 text-[10px] font-bold text-[#35e5b7]">
                        제목 일치
                      </span>
                    ) : null}
                  </span>
                  <span className="wiki-search-suggest-meta mt-1 block truncate text-[11px] text-slate-500">
                    {item.namespace}:{item.title}
                  </span>
                </Link>
              );
            })}
            {loading ? (
              <p className="wiki-search-suggest-meta px-4 py-3 text-xs text-slate-500" role="status">
                문서 제목 찾는 중...
              </p>
            ) : null}
            {!loading && suggestions.length === 0 ? (
              <p className="wiki-search-suggest-meta px-4 py-3 text-xs text-slate-500" role="status">
                제목 일치 없음 · Enter로 내용 검색
              </p>
            ) : null}
            {exactMatch ? (
              <p className="wiki-search-suggest-hint border-t border-white/[0.07] px-4 py-2 text-[11px] text-slate-500">
                Enter를 누르면 정확히 일치하는 문서로 바로 이동합니다.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <select
        name="target"
        aria-label="위키 검색 대상"
        defaultValue={target}
        className="h-12 rounded-xl border border-white/10 bg-[#0d1219] px-3 text-sm text-white focus:border-[#35e5b7]/50 focus:outline-none"
      >
        <option value="all">제목 우선 · 없으면 본문</option>
        <option value="title">제목만</option>
        <option value="content">본문만</option>
      </select>
      <select
        name="namespace"
        aria-label="위키 이름공간"
        defaultValue={namespace}
        className="h-12 rounded-xl border border-white/10 bg-[#0d1219] px-3 text-sm text-white focus:border-[#35e5b7]/50 focus:outline-none"
      >
        <option value="">위키 전체</option>
        <option value="main">일반</option>
        <option value="server">서버 위키</option>
        <option value="mod">모드</option>
        <option value="modpack">모드팩</option>
        <option value="dev">개발</option>
        <option value="help">도움말</option>
        <option value="project">프로젝트</option>
        <option value="template">틀</option>
        <option value="file">파일</option>
      </select>
      <button type="submit" className="btn-primary h-12 px-6">
        검색
      </button>
    </form>
  );
}

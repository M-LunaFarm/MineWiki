'use client';

import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import type { ServerReferral } from '@creepervote/schemas';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';

interface ServerReferralListProps {
  readonly serverId: string;
  readonly initialReferrals: ServerReferral[];
  readonly apiBaseUrl?: string;
}

interface FetchState {
  readonly items: ServerReferral[];
  readonly loading: boolean;
  readonly error: string | null;
}

const FETCH_DEBOUNCE_MS = 300;

export function ServerReferralList({
  serverId,
  initialReferrals,
  apiBaseUrl
}: ServerReferralListProps) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<FetchState>({
    items: initialReferrals,
    loading: false,
    error: null
  });
  const baseUrl = useMemo(() => normalizeApiBaseUrl(apiBaseUrl), [apiBaseUrl]);

  useEffect(() => {
    setState((current) => ({ ...current, items: initialReferrals }));
  }, [initialReferrals]);

  useEffect(() => {
    const controller = new AbortController();
    const handle = setTimeout(async () => {
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const searchParams = new URLSearchParams({ limit: '100' });
        if (query.trim().length > 0) {
          searchParams.set('search', query.trim());
        }
        const response = await fetch(
          `${baseUrl}/v1/servers/${serverId}/votes/recent?${searchParams.toString()}`,
          {
            credentials: 'include',
            signal: controller.signal
          }
        );
        if (!response.ok) {
          throw new Error(`추천인 목록을 불러오지 못했습니다. (${response.status})`);
        }
        const payload = (await response.json()) as ServerReferral[];
        setState({ items: payload, loading: false, error: null });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : '추천인 목록을 불러오지 못했습니다.'
        }));
      }
    }, FETCH_DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [baseUrl, query, serverId]);

  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat('ko-KR', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }),
    []
  );

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  };

  return (
    <section className="rounded-xl border border-[#30343b] bg-[#151922] p-5 shadow-lg shadow-black/20">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">최근 추천인 목록</h3>
          <p className="text-sm text-[#9ca3af]">최근 등록된 투표자 최대 100명을 확인할 수 있습니다.</p>
        </div>
        <div className="flex w-full max-w-xs items-center gap-2 rounded-lg border border-[#30343b] bg-[#101216] px-3 py-2 text-sm text-white">
          <input
            className="w-full bg-transparent text-sm text-white placeholder:text-[#9ca3af] focus:outline-none"
            placeholder="닉네임 검색"
            value={query}
            onChange={handleChange}
          />
        </div>
      </header>

      {state.error ? (
        <p className="mt-4 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {state.error}
        </p>
      ) : null}

      <div className="mt-6 flex items-center justify-between text-xs text-[#9ca3af]">
        <span>{`총 ${state.items.length}건`}</span>
        {state.loading ? <span className="text-emerald-200">불러오는 중…</span> : null}
      </div>

      {state.items.length === 0 && !state.loading ? (
        <p className="mt-6 rounded-xl border border-dashed border-[#30343b] bg-[#101216] p-5 text-sm text-[#9ca3af]">
          표시할 추천인이 없습니다. 새 투표가 등록되면 자동으로 표시됩니다.
        </p>
      ) : null}

      {state.items.length > 0 ? (
        <ul className="mt-4 divide-y divide-[#30343b] rounded-xl border border-[#30343b] bg-[#101216]">
          {state.items.map((entry) => {
            const date = new Date(entry.votedAt);
            return (
              <li
                key={`${entry.username}-${entry.votedAt}`}
                className="flex flex-col gap-1 px-4 py-3 text-sm text-[#d1d5db] sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="font-medium text-white">{entry.username}</span>
                <span className="text-xs text-[#9ca3af]">
                  {Number.isNaN(date.getTime()) ? entry.votedAt : formatter.format(date)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

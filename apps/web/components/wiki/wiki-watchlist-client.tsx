'use client';

import Link from 'next/link';
import { BellRing, Loader2, StarOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchWikiWatchlist, setWikiPageWatched, type WikiWatchlistItem } from '../../lib/wiki-api';
import { useAuth } from '../providers/auth-context';

export function WikiWatchlistClient() {
  const { account, loading: authLoading } = useAuth();
  const [items, setItems] = useState<WikiWatchlistItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!account) { setLoading(false); return () => { active = false; }; }
    void fetchWikiWatchlist()
      .then((result) => { if (active) { setItems(result.items); setCursor(result.nextCursor); } })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : '관심 문서를 불러오지 못했습니다.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [account]);

  async function remove(pageId: string) {
    try {
      await setWikiPageWatched(pageId, false);
      setItems((current) => current.filter((item) => item.pageId !== pageId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '관심 문서를 해제하지 못했습니다.');
    }
  }

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await fetchWikiWatchlist(cursor);
      setItems((current) => [...current, ...result.items.filter((item) => !current.some((existing) => existing.pageId === item.pageId))]);
      setCursor(result.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '관심 문서를 더 불러오지 못했습니다.');
    } finally {
      setLoadingMore(false);
    }
  }

  if (authLoading || loading) return <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 관심 문서를 불러오는 중입니다.</p>;
  if (!account) return <p className="text-sm text-slate-300"><Link href="/login?returnTo=%2Fwiki%2Fwatchlist" className="text-emerald-300 hover:underline">로그인</Link>하면 관심 문서와 읽지 않은 변경을 확인할 수 있습니다.</p>;

  return (
    <div className="space-y-4">
      {error ? <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{error}</p> : null}
      {items.map((item) => (
        <article key={item.pageId} className="flex flex-col gap-4 border border-white/10 bg-[#111821] p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {item.unread ? <BellRing className="size-4 shrink-0 text-emerald-300" aria-label="읽지 않은 변경" /> : null}
              <Link href={item.routePath} className="truncate font-semibold text-white hover:text-emerald-200">{item.title}</Link>
              {item.unread ? <span className="chip chip-accent">새 변경</span> : null}
            </div>
            <p className="mt-2 text-xs text-slate-500">{item.namespace} · {formatDate(item.updatedAt)}</p>
          </div>
          <button type="button" onClick={() => void remove(item.pageId)} className="chip chip-muted inline-flex self-start items-center gap-1.5"><StarOff className="size-3.5" /> 해제</button>
        </article>
      ))}
      {cursor ? <button type="button" disabled={loadingMore} onClick={() => void loadMore()} className="btn-secondary min-h-11 w-full">{loadingMore ? '불러오는 중…' : '관심 문서 더 보기'}</button> : null}
      {items.length === 0 ? <p className="border border-dashed border-white/10 p-8 text-center text-sm text-slate-500">관심 문서가 없습니다. 문서 도구에서 관심 문서를 추가해 보세요.</p> : null}
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value));
}

'use client';

import { Loader2, MessageSquareText, MessagesSquare } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fetchRecentWikiThreads, type WikiRecentThreadSummary } from '../../lib/wiki-api';

export function WikiRecentDiscussionsClient() {
  const [items, setItems] = useState<WikiRecentThreadSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchRecentWikiThreads()
      .then((result) => { if (active) { setItems(result.items); setCursor(result.nextCursor); } })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : '최근 토론을 불러오지 못했습니다.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function loadMore() {
    if (!cursor) return;
    setLoading(true); setError(null);
    try {
      const result = await fetchRecentWikiThreads(cursor);
      setItems((current) => [...current, ...result.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setCursor(result.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '다음 토론을 불러오지 못했습니다.');
    } finally { setLoading(false); }
  }

  return <div className="space-y-5">
    {error ? <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{error}</p> : null}
    {items.length > 0 ? <ol className="divide-y divide-white/[0.07] border border-white/10 bg-[#0d1219]">
      {items.map((item) => <li key={item.id}>
        <Link href={item.discussionHref} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 p-4 transition hover:bg-white/[0.035] sm:p-5">
          <span className="mt-0.5 flex size-9 items-center justify-center rounded-full bg-emerald-300/10 text-emerald-300"><MessageSquareText className="size-4" /></span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2"><strong className="truncate text-sm text-white">{item.title}</strong><span className={`chip ${item.status === 'open' ? 'chip-accent' : 'chip-muted'}`}>{item.status === 'open' ? '열림' : '닫힘'}</span></span>
            <span className="mt-1 block truncate text-sm text-slate-400">{item.pageTitle} · {item.createdByName}</span>
            <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600"><span>댓글 {item.commentCount.toLocaleString('ko-KR')}</span><time>{formatDate(item.updatedAt)}</time><span>{item.namespace}</span></span>
          </span>
        </Link>
      </li>)}
    </ol> : !loading ? <div className="border border-dashed border-white/15 p-10 text-center"><MessagesSquare className="mx-auto size-7 text-slate-600" /><p className="mt-3 text-sm text-slate-400">읽을 수 있는 토론이 아직 없습니다.</p></div> : null}
    {loading ? <p className="flex items-center justify-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 토론을 불러오는 중입니다.</p> : null}
    {cursor && !loading ? <button type="button" onClick={() => void loadMore()} className="chip chip-muted mx-auto block">이전 토론 더 보기</button> : null}
  </div>;
}

function formatDate(value: string) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)); }

'use client';

import { Loader2, MessageSquareText, MessagesSquare } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { fetchRecentWikiThreads, type WikiRecentThreadSummary } from '../../lib/wiki-api';
import {
  WIKI_DISCUSSION_STATUS_FILTERS,
  WIKI_RECENT_DISCUSSION_SORTS,
  wikiDiscussionStatusClass,
  wikiDiscussionStatusLabel,
  wikiRecentDiscussionHref,
} from '../../lib/wiki-discussion-status.mjs';

type RecentStatus = 'all' | 'active' | 'open' | 'paused' | 'closed';
type RecentSort = 'newest' | 'oldest';

export function WikiRecentDiscussionsClient({ status, sort, serverSlug, basePath = '/wiki/discussions' }: {
  readonly status: RecentStatus;
  readonly sort: RecentSort;
  readonly serverSlug?: string;
  readonly basePath?: string;
}) {
  const router = useRouter();
  const [items, setItems] = useState<WikiRecentThreadSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const serverMode = Boolean(serverSlug);
  const itemHref = (href: string) => {
    const prefix = serverSlug ? `/serverWiki/${encodeURIComponent(serverSlug)}` : '';
    return basePath.startsWith('/_') && prefix && href.startsWith(prefix) ? href.slice(prefix.length) || '/' : href;
  };

  useEffect(() => {
    const controller = new AbortController();
    setItems([]); setCursor(null); setError(null); setLoading(true);
    void fetchRecentWikiThreads({ status, sort, serverSlug, signal: controller.signal })
      .then((result) => { setItems(result.items); setCursor(result.nextCursor); })
      .catch((caught) => { if (caught instanceof DOMException && caught.name === 'AbortError') return; setError(caught instanceof Error ? caught.message : '최근 토론을 불러오지 못했습니다.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [serverSlug, sort, status]);

  async function loadMore() {
    if (!cursor) return;
    setLoading(true); setError(null);
    try {
      const result = await fetchRecentWikiThreads({ cursor, status, sort, serverSlug });
      setItems((current) => [...current, ...result.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setCursor(result.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '다음 토론을 불러오지 못했습니다.');
    } finally { setLoading(false); }
  }

  return <div className="space-y-5">
    <div className={`flex flex-col gap-3 border p-3 sm:flex-row sm:items-center sm:justify-between ${serverMode ? 'border-[#e2e2e2] bg-[#fafafa]' : 'border-white/10 bg-white/[0.025]'}`}>
      <nav aria-label="토론 상태" className="flex flex-wrap gap-2">
        {WIKI_DISCUSSION_STATUS_FILTERS.map((filter) => <Link key={filter.value} href={wikiRecentDiscussionHref(filter.value, sort, basePath)} aria-current={status === filter.value ? 'page' : undefined} className={`chip ${status === filter.value ? 'chip-accent' : 'chip-muted'}`}>{filter.label}</Link>)}
      </nav>
      <label className="flex items-center gap-2 text-xs font-semibold text-slate-400">정렬
        <select aria-label="최근 토론 정렬" value={sort} onChange={(event) => router.push(wikiRecentDiscussionHref(status, event.target.value, basePath))} className={`min-h-10 rounded-lg border px-3 text-sm ${serverMode ? 'border-[#ddd] bg-white text-[#333]' : 'border-white/10 bg-[#0d1219] text-slate-200'}`}>
          {WIKI_RECENT_DISCUSSION_SORTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    </div>
    {error ? <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{error}</p> : null}
    {items.length > 0 ? <ol className={`divide-y border ${serverMode ? 'divide-[#ececec] border-[#e2e2e2] bg-white' : 'divide-white/[0.07] border-white/10 bg-[#0d1219]'}`}>
      {items.map((item) => <li key={item.id}>
        <Link href={itemHref(item.discussionHref)} className={`grid grid-cols-[auto_minmax(0,1fr)] gap-3 p-4 transition sm:p-5 ${serverMode ? 'hover:bg-[#fafafa]' : 'hover:bg-white/[0.035]'}`}>
          <span className="mt-0.5 flex size-9 items-center justify-center rounded-full bg-emerald-300/10 text-emerald-300"><MessageSquareText className="size-4" /></span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2"><strong className={`truncate text-sm ${serverMode ? 'text-[#222]' : 'text-white'}`}>{item.title}</strong><span className={`chip ${wikiDiscussionStatusClass(item.status)}`}>{wikiDiscussionStatusLabel(item.status)}</span></span>
            <span className="mt-1 block truncate text-sm text-slate-400">{item.pageTitle} · {item.createdByName}</span>
            <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600"><span>댓글 {item.commentCount.toLocaleString('ko-KR')}</span><time>{formatDate(item.updatedAt)}</time><span>{item.namespace}</span></span>
          </span>
        </Link>
      </li>)}
    </ol> : !loading ? <div className="border border-dashed border-white/15 p-10 text-center"><MessagesSquare className="mx-auto size-7 text-slate-600" /><p className="mt-3 text-sm text-slate-400">{emptyMessage(status)}</p></div> : null}
    {loading ? <p className="flex items-center justify-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 토론을 불러오는 중입니다.</p> : null}
    {cursor && !loading ? <button type="button" onClick={() => void loadMore()} className="chip chip-muted mx-auto block">이전 토론 더 보기</button> : null}
  </div>;
}

function emptyMessage(status: RecentStatus) {
  if (status === 'active') return '현재 진행 중인 토론이 없습니다.';
  if (status === 'open') return '열린 토론이 없습니다.';
  if (status === 'paused') return '일시 중지된 토론이 없습니다.';
  if (status === 'closed') return '종료된 토론이 없습니다.';
  return '읽을 수 있는 토론이 아직 없습니다.';
}

function formatDate(value: string) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)); }

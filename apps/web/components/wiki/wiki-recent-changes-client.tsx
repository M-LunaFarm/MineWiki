'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { fetchWikiRecent, type WikiRecentChangeListResponse, type WikiRecentChangeSummary } from '../../lib/wiki-api';

interface WikiRecentChangesClientProps {
  readonly initial: WikiRecentChangeListResponse;
  readonly filters: { readonly changeType?: string; readonly namespace?: string; readonly minor?: string };
}

export function WikiRecentChangesClient({ initial, filters }: WikiRecentChangesClientProps) {
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetchWikiRecent({ ...filters, cursor });
      setItems((current) => [...current, ...response.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setCursor(response.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '이전 변경 기록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return <div className="space-y-4">
    {error ? <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{error}</p> : null}
    <section className="divide-y divide-white/10 border border-white/10 bg-[#111821]">
      {items.map((change) => <RecentChange key={change.id} change={change} />)}
      {items.length === 0 ? <p className="px-4 py-8 text-sm text-slate-400">조건에 맞는 최근 변경이 없습니다.</p> : null}
    </section>
    {cursor ? <button type="button" disabled={loading} onClick={() => void loadMore()} className="btn-secondary min-h-11 w-full sm:w-auto">{loading ? <Loader2 className="size-4 animate-spin" /> : null} 이전 변경 더 보기</button> : null}
  </div>;
}

function RecentChange({ change }: { readonly change: WikiRecentChangeSummary }) {
  return <article className="grid gap-3 px-4 py-4 md:grid-cols-[1fr_auto] md:items-center">
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap gap-2">
        <span className="chip chip-accent">{namespaceLabel(change.namespaceCode)}</span>
        <span className="chip chip-muted">{changeTypeLabel(change.changeType)}</span>
        {change.isMinor ? <span className="chip chip-muted">사소한 편집</span> : null}
      </div>
      <h2 className="truncate text-base font-semibold text-white"><Link href={change.routePath} className="hover:text-emerald-200">{change.title}</Link></h2>
      <p className="mt-1 break-words text-sm text-slate-400">{change.summary ?? '요약 없음'}</p>
    </div>
    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-400 md:justify-end">
      <time>{formatDate(change.createdAt)}</time>
      {change.revisionId ? <Link href={`/wiki/revision/${change.revisionId}`} className="chip chip-muted">판 보기</Link> : null}
    </div>
  </article>;
}

function changeTypeLabel(value: string): string {
  return ({ create: '새 문서', edit: '편집', move: '이동', delete: '삭제', restore: '복구', revert: '되돌리기', protect: '보호', rollback: '관리자 되돌리기', revision_visibility: '판 공개 설정' } as Record<string, string>)[value] ?? value;
}

function namespaceLabel(value: string): string {
  return ({ main: '일반', server: '서버', mod: '모드', modpack: '모드팩', project: '프로젝트', dev: '개발', help: '도움말', file: '파일', template: '틀' } as Record<string, string>)[value] ?? value;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value));
}

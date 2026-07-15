'use client';

import Link from 'next/link';
import { AlertTriangle, FilePenLine, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchWikiEditRequestQueue, type WikiEditRequestQueueItem, type WikiEditRequestQueueResponse } from '../../lib/wiki-api';
import { buildServerWikiToolPath } from '../../lib/wiki-routes.mjs';

const EMPTY: WikiEditRequestQueueResponse = { items: [], viewerProfileId: null, nextCursor: null };

export function WikiEditRequestQueueClient({
  status,
  scope,
  namespace,
}: {
  readonly status: string;
  readonly scope: string;
  readonly namespace: string;
}) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchWikiEditRequestQueue({ status, scope, namespace: namespace || undefined })
      .then((result) => { if (active) setData(result); })
      .catch((caught) => { if (active) setError(message(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [namespace, scope, status]);

  async function loadMore() {
    if (!data.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const next = await fetchWikiEditRequestQueue({ status, scope, namespace: namespace || undefined, cursor: data.nextCursor });
      setData((current) => ({
        ...next,
        items: [...current.items, ...next.items.filter((item) => !current.items.some((existing) => existing.id === item.id))],
      }));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading) return <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 편집 요청을 불러오는 중입니다.</p>;
  return (
    <div className="space-y-4">
      {error ? <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{error}</p> : null}
      {data.items.map((item) => <QueueCard key={item.id} item={item} viewerProfileId={data.viewerProfileId} />)}
      {data.items.length === 0 && !error ? <p className="border border-dashed border-white/10 p-8 text-center text-sm text-slate-500">조건에 맞는 편집 요청이 없습니다.</p> : null}
      {data.nextCursor ? (
        <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="btn-secondary min-h-11">
          {loadingMore ? <Loader2 className="size-4 animate-spin" /> : null} 이전 요청 더 보기
        </button>
      ) : null}
    </div>
  );
}

function QueueCard({ item, viewerProfileId }: { readonly item: WikiEditRequestQueueItem; readonly viewerProfileId: string | null }) {
  const detailPath = item.pageId === null
    ? `/wiki/edit-requests/request/${encodeURIComponent(item.id)}?returnTo=${encodeURIComponent(item.routePath)}`
    : item.routePath.startsWith('/server/')
    ? `${buildServerWikiToolPath(item.routePath, 'requests')}?request=${encodeURIComponent(item.id)}`
    : `/wiki/edit-requests/${encodeURIComponent(item.pageId)}?returnTo=${encodeURIComponent(item.routePath)}&request=${encodeURIComponent(item.id)}`;
  return (
    <article className="surface-flat p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>{namespaceLabel(item.namespace)}</span>
            <span>·</span>
            <span>{statusLabel(item.status)}</span>
            {item.canReview ? <span className="chip chip-accent">검토 가능</span> : null}
            {viewerProfileId === item.createdBy ? <span className="chip chip-muted">내 요청</span> : null}
          </div>
          <h2 className="mt-2 break-words text-lg font-semibold text-white"><Link href={detailPath} className="hover:text-emerald-200">{item.pageDisplayTitle}</Link></h2>
          <p className="mt-2 break-words text-sm text-slate-300">{item.editSummary}</p>
          <p className="mt-2 text-xs text-slate-500">{item.createdByName} · {formatDate(item.createdAt)}</p>
        </div>
        <Link href={detailPath} className="btn-secondary min-h-11 flex-none gap-2"><FilePenLine className="size-4" /> 요청 검토</Link>
      </div>
      {item.isStale ? <p className="mt-4 flex gap-2 border border-amber-300/20 bg-amber-300/10 p-3 text-sm text-amber-100"><AlertTriangle className="mt-0.5 size-4 flex-none" /> 기준 판이 바뀌어 재배치가 필요합니다.</p> : null}
    </article>
  );
}

function message(error: unknown) { return error instanceof Error ? error.message : '편집 요청 목록을 불러오지 못했습니다.'; }
function formatDate(value: string) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)); }
function namespaceLabel(namespace: string) { return ({ main: '일반', server: '서버', mod: '모드', modpack: '모드팩', dev: '개발', guide: '가이드', data: '데이터', help: '도움말', project: '프로젝트', template: '틀', category: '분류', file: '파일' } as Record<string, string>)[namespace] ?? namespace; }
function statusLabel(status: string) { return ({ pending: '검토 대기', reviewing: '처리 중', accepted: '승인됨', rejected: '반려됨', stale: '기준 판 만료', closed: '작성자가 닫음' } as Record<string, string>)[status] ?? status; }

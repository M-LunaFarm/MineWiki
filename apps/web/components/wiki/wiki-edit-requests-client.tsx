'use client';

import Link from 'next/link';
import { Check, FilePenLine, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchWikiEditRequests, reviewWikiEditRequest, type WikiEditRequestListResponse } from '../../lib/wiki-api';

export function WikiEditRequestsClient({ pageId, returnTo }: { readonly pageId: string; readonly returnTo: string }) {
  const [data, setData] = useState<WikiEditRequestListResponse>({ items: [], canReview: false });
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchWikiEditRequests(pageId)
      .then((result) => { if (active) setData(result); })
      .catch((caught) => { if (active) setError(message(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [pageId]);

  async function review(requestId: string, action: 'accept' | 'reject') {
    const reviewNote = window.prompt(action === 'accept' ? '승인 메모(선택)' : '반려 사유(선택)') ?? undefined;
    setWorking(requestId); setError(null);
    try {
      const updated = await reviewWikiEditRequest({ requestId, action, reviewNote });
      setData((current) => ({ ...current, items: current.items.map((item) => item.id === updated.id ? updated : item) }));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400"><Link href={returnTo} className="hover:text-emerald-200">문서로 돌아가기</Link><span>/</span><span className="text-slate-200">편집 요청</span></nav>
      <header className="border-b border-white/10 pb-6"><h1 className="flex items-center gap-3 text-3xl font-bold text-white"><FilePenLine className="size-7 text-emerald-300" /> 편집 요청</h1><p className="mt-3 text-sm text-slate-400">제안된 변경을 원문과 비교하고 승인 또는 반려합니다.</p></header>
      {error ? <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{error}</p> : null}
      {loading ? <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 불러오는 중입니다.</p> : null}
      <div className="space-y-4">
        {data.items.map((item) => (
          <article key={item.id} className="border border-white/10 bg-[#111821] p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h2 className="font-semibold text-white">{item.editSummary}</h2><p className="mt-2 text-xs text-slate-500">{item.createdByName} · {formatDate(item.createdAt)} · {statusLabel(item.status)}</p></div>
              {data.canReview && item.status === 'pending' ? <div className="flex gap-2"><button type="button" disabled={working === item.id} onClick={() => void review(item.id, 'accept')} className="chip chip-accent inline-flex items-center gap-1"><Check className="size-3.5" /> 승인</button><button type="button" disabled={working === item.id} onClick={() => void review(item.id, 'reject')} className="chip chip-muted inline-flex items-center gap-1"><X className="size-3.5" /> 반려</button></div> : null}
            </div>
            <details className="mt-4"><summary className="cursor-pointer text-sm font-semibold text-slate-300">제안 원문 보기</summary><pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words border border-white/10 bg-black/20 p-4 text-xs leading-6 text-slate-300">{item.proposedContent}</pre></details>
            {item.reviewNote ? <p className="mt-4 border-l-2 border-emerald-400/40 pl-3 text-sm text-slate-300">검토 메모: {item.reviewNote}</p> : null}
          </article>
        ))}
        {!loading && data.items.length === 0 ? <p className="border border-dashed border-white/10 p-8 text-center text-sm text-slate-500">편집 요청이 없습니다.</p> : null}
      </div>
    </div>
  );
}

function message(error: unknown) { return error instanceof Error ? error.message : '편집 요청 처리에 실패했습니다.'; }
function formatDate(value: string) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)); }
function statusLabel(status: string) { return ({ pending: '검토 대기', reviewing: '처리 중', accepted: '승인됨', rejected: '반려됨', stale: '기준 판 만료' } as Record<string, string>)[status] ?? status; }

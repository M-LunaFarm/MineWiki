'use client';

import Link from 'next/link';
import { AlertTriangle, Check, FilePenLine, GitCompare, Loader2, Pencil, RotateCcw, Save, X } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  changeWikiEditRequestState,
  fetchWikiEditRequest,
  fetchWikiEditRequestContext,
  fetchWikiEditRequestDiff,
  fetchWikiEditRequests,
  rebaseWikiEditRequest,
  reviewWikiEditRequest,
  updateWikiEditRequest,
  WikiApiError,
  type WikiEditConflictDetails,
  type WikiEditRequestDiffResponse,
  type WikiEditRequestListResponse,
  type WikiEditRequestSummary
} from '../../lib/wiki-api';
import { WikiEditSummary } from './wiki-edit-summary';

const EMPTY: WikiEditRequestListResponse = { items: [], canReview: false, viewerProfileId: null, nextCursor: null, currentRevisionId: null };

interface RebaseConflictState {
  readonly requestId: string;
  readonly currentRevisionId: string;
  readonly conflictCount: number;
}

export function WikiEditRequestsClient({ pageId, requestId, returnTo }: { readonly pageId?: string; readonly requestId?: string; readonly returnTo: string }) {
  const searchParams = useSearchParams();
  const requestedRequestId = requestId ?? searchParams.get('request');
  const [data, setData] = useState<WikiEditRequestListResponse>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, WikiEditRequestDiffResponse>>({});
  const [editing, setEditing] = useState<WikiEditRequestSummary | null>(null);
  const [rebaseConflict, setRebaseConflict] = useState<RebaseConflictState | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const load = requestId
      ? Promise.all([fetchWikiEditRequestContext(requestId), Promise.resolve(null)])
      : Promise.all([
          fetchWikiEditRequests(pageId!),
          requestedRequestId ? fetchWikiEditRequest(requestedRequestId) : Promise.resolve(null),
        ]);
    void load
      .then(([result, requested]) => {
        if (!active) return;
        if (requested && requested.pageId !== pageId) throw new Error('이 문서의 편집 요청이 아닙니다.');
        setData(requested && !result.items.some((item) => item.id === requested.id)
          ? { ...result, items: [requested, ...result.items] }
          : result);
      })
      .catch((caught) => { if (active) setError(message(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [pageId, requestId, requestedRequestId]);

  useEffect(() => {
    if (loading || !requestedRequestId) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`edit-request-${requestedRequestId}`);
      target?.scrollIntoView({ block: 'start' });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [loading, requestedRequestId]);

  function replace(updated: WikiEditRequestSummary) {
    setData((current) => ({ ...current, items: current.items.map((item) => item.id === updated.id ? updated : item) }));
    setDiffs((current) => { const next = { ...current }; delete next[updated.id]; return next; });
    window.dispatchEvent(new Event('wiki:edit-request-changed'));
  }

  async function review(requestId: string, action: 'accept' | 'reject') {
    const reviewNote = window.prompt(action === 'accept' ? '승인 메모(선택)' : '반려 사유(선택)') ?? undefined;
    await run(`${requestId}:${action}`, async () => replace(await reviewWikiEditRequest({ requestId, action, reviewNote })));
  }

  async function changeState(requestId: string, action: 'close' | 'reopen') {
    if (action === 'close' && !window.confirm('이 편집 요청을 닫을까요?')) return;
    await run(`${requestId}:${action}`, async () => replace(await changeWikiEditRequestState(requestId, action)));
  }

  async function loadDiff(requestId: string) {
    if (diffs[requestId]) return;
    await run(`${requestId}:diff`, async () => {
      const diff = await fetchWikiEditRequestDiff(requestId);
      setDiffs((current) => ({ ...current, [requestId]: diff }));
    });
  }

  async function saveEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || (editing.requestKind === 'edit' && !data.currentRevisionId) || containsWikiConflictMarkers(editing.proposedContent)) return;
    await run(`${editing.id}:update`, async () => {
      const updated = rebaseConflict?.requestId === editing.id
        ? await rebaseWikiEditRequest(editing.id, {
            contentRaw: editing.proposedContent,
            currentRevisionId: rebaseConflict.currentRevisionId,
            editSummary: editing.editSummary ?? '',
            isMinor: editing.isMinor
          })
        : await updateWikiEditRequest({
            requestId: editing.id,
            baseRevisionId: editing.baseRevisionId ?? undefined,
            contentRaw: editing.proposedContent,
            editSummary: editing.editSummary ?? '',
            isMinor: editing.isMinor
          });
      replace(updated);
      setEditing(null);
      setRebaseConflict(null);
    });
  }

  async function rebase(item: WikiEditRequestSummary) {
    await run(`${item.id}:rebase`, async () => {
      try {
        const updated = await rebaseWikiEditRequest(item.id);
        replace(updated);
        setEditing(null);
        setRebaseConflict(null);
      } catch (caught) {
        const conflict = wikiEditConflict(caught);
        if (!conflict) throw caught;
        setEditing({
          ...item,
          baseRevisionId: conflict.currentRevisionId,
          proposedContent: conflict.mergedContentRaw
        });
        setRebaseConflict({
          requestId: item.id,
          currentRevisionId: conflict.currentRevisionId,
          conflictCount: conflict.conflictCount
        });
      }
    });
  }

  function startEditing(item: WikiEditRequestSummary) {
    setEditing({ ...item });
    setRebaseConflict(null);
  }

  function cancelEditing() {
    setEditing(null);
    setRebaseConflict(null);
  }

  async function loadMore() {
    if (!data.nextCursor) return;
    await run('more', async () => {
      if (!pageId) return;
      const next = await fetchWikiEditRequests(pageId, data.nextCursor ?? undefined);
      setData((current) => ({ ...current, items: [...current.items, ...next.items.filter((item) => !current.items.some((existing) => existing.id === item.id))], nextCursor: next.nextCursor, currentRevisionId: next.currentRevisionId }));
    });
  }

  async function run(key: string, action: () => Promise<void>) {
    setWorking(key); setError(null);
    try { await action(); } catch (caught) { setError(message(caught)); } finally { setWorking(null); }
  }

  return <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
    <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400"><Link href={returnTo} className="hover:text-emerald-200">문서로 돌아가기</Link><span>/</span><span className="text-slate-200">편집 요청</span></nav>
    <header className="border-b border-white/10 pb-6"><h1 className="flex items-center gap-3 text-3xl font-bold text-white"><FilePenLine className="size-7 text-emerald-300" /> 편집 요청</h1><p className="mt-3 text-sm text-slate-400">기준판과 제안 내용을 비교하고, 작성자는 요청을 수정·닫기·다시 열 수 있습니다.</p></header>
    {error ? <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{error}</p> : null}
    {loading ? <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 불러오는 중입니다.</p> : null}
    <div className="space-y-4">{data.items.map((item) => {
      const isAuthor = data.viewerProfileId === item.createdBy;
      const isMutable = ['pending', 'stale', 'closed'].includes(item.status);
      const isStale = item.requestKind === 'edit' && isMutable && (item.status === 'stale' || !data.currentRevisionId || item.baseRevisionId !== data.currentRevisionId);
      const canEdit = isAuthor && ['pending', 'closed'].includes(item.status) && !isStale;
      const canRebase = item.requestKind === 'edit' && isAuthor && ['pending', 'stale', 'closed'].includes(item.status) && isStale && Boolean(data.currentRevisionId);
      const resolvingConflict = rebaseConflict?.requestId === item.id;
      const unresolvedMarkers = resolvingConflict && editing?.id === item.id
        ? containsWikiConflictMarkers(editing.proposedContent)
        : false;
      return <article id={`edit-request-${item.id}`} tabIndex={-1} data-highlighted={item.id === requestedRequestId || undefined} key={item.id} className="border border-white/10 bg-[#111821] p-4 outline-none data-[highlighted=true]:border-emerald-300/60 data-[highlighted=true]:bg-emerald-300/[0.06] sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="font-semibold text-white"><WikiEditSummary summary={item.editSummary} hidden={item.editSummaryHidden} /></h2><p className="mt-2 text-xs text-slate-500">{item.requestKind === 'create' ? '새 문서 요청 · ' : ''}{item.createdByName} · {formatDate(item.createdAt)} · {statusLabel(item.status)}</p></div>
          <div className="flex flex-wrap gap-2">
            {data.canReview && item.status === 'pending' && !isStale ? <Action disabled={Boolean(working)} onClick={() => void review(item.id, 'accept')} accent icon={<Check />}>승인</Action> : null}
            {data.canReview && item.status === 'pending' ? <Action disabled={Boolean(working)} onClick={() => void review(item.id, 'reject')} icon={<X />}>반려</Action> : null}
            {canRebase ? <Action disabled={Boolean(working)} onClick={() => void rebase(item)} accent icon={<RotateCcw />}>최신 판으로 재배치</Action> : null}
            {canEdit ? <Action disabled={Boolean(working)} onClick={() => startEditing(item)} icon={<Pencil />}>수정</Action> : null}
            {isAuthor && ['pending', 'stale'].includes(item.status) ? <Action disabled={Boolean(working)} onClick={() => void changeState(item.id, 'close')} icon={<X />}>닫기</Action> : null}
            {isAuthor && item.status === 'closed' && !isStale ? <Action disabled={Boolean(working)} onClick={() => void changeState(item.id, 'reopen')} icon={<RotateCcw />}>다시 열기</Action> : null}
          </div>
        </div>
        {isStale ? <div className="mt-4 flex gap-3 border border-amber-300/25 bg-amber-400/10 p-3 text-sm text-amber-100" role="status"><AlertTriangle className="mt-0.5 size-4 flex-none" /><p>이 요청은 현재 문서보다 오래된 판을 기준으로 합니다. 승인하거나 수정하기 전에 작성자가 최신 판으로 재배치해야 합니다.</p></div> : null}
        {editing?.id === item.id ? <form onSubmit={(event) => void saveEdit(event)} className="mt-4 grid gap-3 border border-emerald-300/20 bg-black/20 p-4">
          {resolvingConflict ? <div role="alert" className="flex gap-3 border border-amber-300/30 bg-amber-400/10 p-3 text-sm text-amber-100"><AlertTriangle className="mt-0.5 size-4 flex-none" /><div className="space-y-1"><p className="font-semibold">겹치는 변경 {rebaseConflict.conflictCount}개를 직접 정리해 주세요.</p><p className="text-xs leading-5 text-amber-100/80"><code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; 내 편집</code>, <code>=======</code>, <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt; 최신 판</code> 표시를 모두 제거하면 재배치 저장이 활성화됩니다.</p></div></div> : null}
          <label className="grid gap-2 text-sm text-slate-300">요약<input name="editSummary" value={editing.editSummary ?? ''} onChange={(event) => setEditing({ ...editing, editSummary: event.target.value })} maxLength={255} required className="input min-h-11" /></label>
          <label className="grid gap-2 text-sm text-slate-300">제안 원문<textarea name="contentRaw" value={editing.proposedContent} onChange={(event) => setEditing({ ...editing, proposedContent: event.target.value })} required rows={12} className="input min-h-64 resize-y overflow-x-auto font-mono text-xs [overflow-wrap:anywhere]" /></label>
          <label className="flex min-h-11 items-center gap-2 text-sm text-slate-300"><input name="isMinor" type="checkbox" checked={editing.isMinor} onChange={(event) => setEditing({ ...editing, isMinor: event.target.checked })} /> 사소한 편집</label>
          <div className="flex flex-wrap gap-2"><button type="submit" disabled={Boolean(working) || unresolvedMarkers} className="chip chip-accent inline-flex min-h-11 items-center gap-1"><Save className="size-4" /> {resolvingConflict ? '충돌 해결 후 재배치' : '저장'}</button><button type="button" onClick={cancelEditing} className="chip chip-muted min-h-11">취소</button></div>
        </form> : null}
        <div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={Boolean(working)} onClick={() => void loadDiff(item.id)} className="chip chip-muted inline-flex min-h-11 items-center gap-1"><GitCompare className="size-4" /> 기준판과 비교</button><details><summary className="chip chip-muted flex min-h-11 cursor-pointer items-center">제안 원문</summary><pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words border border-white/10 bg-black/20 p-4 text-xs leading-6 text-slate-300">{item.proposedContent}</pre></details></div>
        {diffs[item.id] ? <DiffTable diff={diffs[item.id]} /> : null}
        {item.reviewNote ? <p className="mt-4 border-l-2 border-emerald-400/40 pl-3 text-sm text-slate-300">검토 메모: {item.reviewNote}</p> : null}
      </article>;
    })}{!loading && data.items.length === 0 ? <p className="border border-dashed border-white/10 p-8 text-center text-sm text-slate-500">편집 요청이 없습니다.</p> : null}</div>
    {data.nextCursor ? <button type="button" disabled={Boolean(working)} onClick={() => void loadMore()} className="btn-secondary min-h-11 self-start">이전 요청 더 보기</button> : null}
  </div>;
}

function Action({ disabled, onClick, accent = false, icon, children }: { readonly disabled: boolean; readonly onClick: () => void; readonly accent?: boolean; readonly icon: React.ReactElement; readonly children: React.ReactNode }) { return <button type="button" disabled={disabled} onClick={onClick} className={`chip min-h-11 ${accent ? 'chip-accent' : 'chip-muted'} inline-flex items-center gap-1 [&>svg]:size-3.5`}>{icon}{children}</button>; }
function DiffTable({ diff }: { readonly diff: WikiEditRequestDiffResponse }) { return <div className="mt-4 overflow-x-auto border border-white/10"><table className="min-w-full font-mono text-xs"><tbody>{diff.hunks.map((hunk, index) => <tr key={`${index}-${hunk.type}`} className={hunk.type === 'added' ? 'bg-emerald-500/10 text-emerald-100' : hunk.type === 'removed' ? 'bg-red-500/10 text-red-100' : 'text-slate-400'}><td className="w-12 px-2 py-1 text-right">{hunk.leftLine ?? ''}</td><td className="w-12 px-2 py-1 text-right">{hunk.rightLine ?? ''}</td><td className="w-6 px-2 py-1">{hunk.type === 'added' ? '+' : hunk.type === 'removed' ? '-' : ' '}</td><td className="whitespace-pre-wrap break-all px-2 py-1">{hunk.line || ' '}</td></tr>)}</tbody></table></div>; }
function wikiEditConflict(error: unknown): WikiEditConflictDetails | null {
  if (!(error instanceof WikiApiError) || error.code !== 'wiki_edit_conflict') return null;
  const details = error.details;
  if (!details || typeof details !== 'object') return null;
  const candidate = details as Partial<WikiEditConflictDetails>;
  if (
    candidate.type !== 'wiki_edit_conflict' ||
    candidate.scope !== 'page' ||
    typeof candidate.baseRevisionId !== 'string' ||
    typeof candidate.currentRevisionId !== 'string' ||
    typeof candidate.currentRevisionNo !== 'number' ||
    typeof candidate.mergedContentRaw !== 'string' ||
    typeof candidate.conflictCount !== 'number'
  ) return null;
  return candidate as WikiEditConflictDetails;
}
function containsWikiConflictMarkers(contentRaw: string): boolean {
  return /^(?:<<<<<<< 내 편집|\|\|\|\|\|\|\| 기준 판|=======|>>>>>>> 최신 판)$/m.test(contentRaw.replace(/\r\n?/g, '\n'));
}
function message(error: unknown) { return error instanceof Error ? error.message : '편집 요청 처리에 실패했습니다.'; }
function formatDate(value: string) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)); }
function statusLabel(status: string) { return ({ pending: '검토 대기', reviewing: '처리 중', accepted: '승인됨', rejected: '반려됨', stale: '기준 판 만료', closed: '작성자가 닫음' } as Record<string, string>)[status] ?? status; }

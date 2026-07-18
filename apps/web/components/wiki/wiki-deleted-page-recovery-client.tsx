'use client';

import { ArchiveRestore, ChevronRight, History, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  fetchWikiDeletedPageRecovery,
  restoreWikiPage,
  type WikiDeletedPageRecoveryResponse,
  type WikiRevisionSummary,
} from '../../lib/wiki-api';
import { WikiEditSummary } from './wiki-edit-summary';

export function WikiDeletedPageRecoveryClient({ pageId }: { readonly pageId: string }) {
  const [data, setData] = useState<WikiDeletedPageRecoveryResponse | null>(null);
  const [revisions, setRevisions] = useState<WikiRevisionSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('삭제 문서함에서 검토 후 복구');

  useEffect(() => {
    let active = true;
    void fetchWikiDeletedPageRecovery({ pageId })
      .then((response) => {
        if (!active) return;
        setData(response);
        setRevisions(response.revisions.items);
        setCursor(response.revisions.nextCursor);
      })
      .catch((caught) => { if (active) setError(message(caught, '삭제 문서 복구 정보를 불러오지 못했습니다.')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [pageId]);

  async function selectRevision(revisionId: string) {
    if (!data || data.selectedRevision.id === revisionId || working) return;
    setWorking(true);
    setError(null);
    try {
      const response = await fetchWikiDeletedPageRecovery({ pageId, revisionId });
      setData({ ...response, revisions: { items: revisions, nextCursor: cursor } });
    } catch (caught) {
      setError(message(caught, '선택한 판을 미리 볼 수 없습니다.'));
    } finally {
      setWorking(false);
    }
  }

  async function loadMore() {
    if (!cursor || !data || working) return;
    setWorking(true);
    setError(null);
    try {
      const response = await fetchWikiDeletedPageRecovery({
        pageId,
        revisionId: data.selectedRevision.id,
        cursor,
      });
      setRevisions((current) => [...current, ...response.revisions.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setCursor(response.revisions.nextCursor);
    } catch (caught) {
      setError(message(caught, '이전 판을 더 불러오지 못했습니다.'));
    } finally {
      setWorking(false);
    }
  }

  async function restore() {
    if (!data || reason.trim().length < 2 || working) return;
    setWorking(true);
    setError(null);
    try {
      await restoreWikiPage({
        pageId,
        reason: reason.trim(),
        revisionId: data.page.canSelectHistoricalRevision ? data.selectedRevision.id : undefined,
      });
      window.location.assign('/wiki/deleted');
    } catch (caught) {
      setError(message(caught, '선택한 판으로 문서를 복구하지 못했습니다.'));
      setWorking(false);
    }
  }

  if (loading) return <RecoveryShell><p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 복구 이력을 확인하는 중입니다.</p></RecoveryShell>;
  if (!data) return <RecoveryShell><ErrorMessage value={error ?? '복구 정보를 찾을 수 없습니다.'} /></RecoveryShell>;

  return (
    <RecoveryShell>
      <header className="border-b border-white/10 pb-6">
        <p className="text-xs font-semibold uppercase tracking-[.18em] text-emerald-300">Private recovery workspace</p>
        <h1 className="mt-3 text-3xl font-bold text-white">{data.page.displayTitle}</h1>
        <p className="mt-3 text-sm text-slate-400">{data.page.namespace}:{data.page.title}</p>
        <p className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm leading-6 text-amber-100">삭제 문서의 내용과 이력은 복구 권한이 있는 사용자에게만 표시됩니다. 선택한 판은 기존 이력을 덮어쓰지 않고 새 판으로 복사됩니다.</p>
      </header>
      {error ? <ErrorMessage value={error} /> : null}
      <div className="grid gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className="space-y-4">
          <section className="border border-white/10 bg-[#111821] p-4">
            <h2 className="flex items-center gap-2 font-semibold text-white"><History className="size-4 text-emerald-300" /> 보존된 공개 판</h2>
            {!data.page.canSelectHistoricalRevision ? <p className="mt-2 text-xs leading-5 text-amber-200">파일 문서는 보존 자산과의 불일치를 막기 위해 최신 공개 판만 복구할 수 있습니다.</p> : null}
            <ol className="mt-4 divide-y divide-white/10">
              {revisions.map((revision) => <RevisionItem key={revision.id} revision={revision} selected={revision.id === data.selectedRevision.id} disabled={!data.page.canSelectHistoricalRevision || working} onSelect={selectRevision} />)}
            </ol>
            {cursor ? <button type="button" onClick={() => void loadMore()} disabled={working} className="btn-secondary mt-4 min-h-11 w-full disabled:opacity-50">이전 판 더 보기</button> : null}
          </section>
          <section className="border border-white/10 bg-[#111821] p-4">
            <h2 className="font-semibold text-white">삭제·이동 기록</h2>
            <ol className="mt-4 space-y-3 text-xs text-slate-400">
              {data.lifecycle.items.map((event) => <li key={event.id} className="border-l border-white/15 pl-3"><strong className="text-slate-200">{lifecycleLabel(event.eventType)}</strong><span className="mt-1 block">{formatDate(event.createdAt)}{event.actorName ? ` · ${event.actorName}` : ''}</span>{event.reason ? <span className="mt-1 block break-words">{event.reason}</span> : null}</li>)}
            </ol>
          </section>
        </aside>
        <div className="min-w-0 space-y-5">
          <section className="border border-white/10 bg-[#111821] p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold text-emerald-300">선택한 판</p><h2 className="mt-1 text-xl font-bold text-white">rev {data.selectedRevision.revisionNo}</h2><p className="mt-2 text-sm text-slate-400"><WikiEditSummary summary={data.selectedRevision.editSummary} hidden={data.selectedRevision.editSummaryHidden} /> · {formatDate(data.selectedRevision.createdAt)}</p></div><span className="chip chip-muted">{formatBytes(data.selectedRevision.contentSize)}</span></div>
          </section>
          <article className="wiki-rendered min-h-48 border border-white/10 bg-[#111821] p-5 sm:p-7" dangerouslySetInnerHTML={{ __html: data.selectedRevision.html }} />
          <section className="border border-emerald-300/20 bg-emerald-300/[0.06] p-4 sm:p-5">
            <label className="grid gap-2 text-sm font-semibold text-slate-200">복구 사유<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={255} className="input min-h-11" /></label>
            <button type="button" onClick={() => void restore()} disabled={working || reason.trim().length < 2} className="btn-primary mt-4 min-h-11 w-full disabled:opacity-50 sm:w-auto">{working ? <Loader2 className="size-4 animate-spin" /> : <ArchiveRestore className="size-4" />} rev {data.selectedRevision.revisionNo} 기준으로 복구</button>
          </section>
        </div>
      </div>
    </RecoveryShell>
  );
}

function RecoveryShell({ children }: { readonly children: ReactNode }) {
  return <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8"><nav className="flex items-center gap-2 text-sm text-slate-400"><Link href="/wiki/deleted" className="hover:text-emerald-200">삭제 문서함</Link><ChevronRight className="size-4" /><span className="text-slate-200">복구 검토</span></nav>{children}</main>;
}

function RevisionItem({ revision, selected, disabled, onSelect }: { readonly revision: WikiRevisionSummary; readonly selected: boolean; readonly disabled: boolean; readonly onSelect: (id: string) => Promise<void> }) {
  return <li><button type="button" onClick={() => void onSelect(revision.id)} disabled={disabled} className={`min-h-16 w-full px-2 py-3 text-left transition disabled:cursor-not-allowed ${selected ? 'bg-emerald-300/10' : 'hover:bg-white/[0.03]'}`}><span className="flex items-center justify-between gap-3"><strong className={selected ? 'text-emerald-200' : 'text-white'}>rev {revision.revisionNo}</strong><time className="text-[11px] text-slate-500">{formatDate(revision.createdAt)}</time></span><span className="mt-1 block truncate text-xs text-slate-400"><WikiEditSummary summary={revision.editSummary} hidden={revision.editSummaryHidden} /></span><span className="mt-1 block text-[11px] text-slate-600">{revision.createdByName ?? '알 수 없는 기여자'} · {formatBytes(revision.contentSize)}</span></button></li>;
}

function ErrorMessage({ value }: { readonly value: string }) { return <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{value}</p>; }
function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function lifecycleLabel(value: string) { return ({ delete: '삭제', restore: '복구', move: '이동' } as Record<string, string>)[value] ?? value; }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`; }
function formatDate(value: string) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)); }

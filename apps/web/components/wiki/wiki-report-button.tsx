'use client';

import { AlertTriangle, Flag, Loader2, X } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { createWikiReport, type WikiReportTargetType } from '../../lib/wiki-api';
import { useAuth } from '../providers/auth-context';

const LABELS: Record<WikiReportTargetType, string> = { page: '문서', revision: '판', discussion: '토론', comment: '댓글' };

export function WikiReportButton({ targetType, targetId, returnTo, compact = false }: {
  readonly targetType: WikiReportTargetType;
  readonly targetId: string;
  readonly returnTo: string;
  readonly compact?: boolean;
}) {
  const { account, loading } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true); setMessage(null);
    try {
      const result = await createWikiReport({ targetType, targetId, reason: reason.trim() });
      setSuccess(true);
      setMessage(result.deduplicated ? '이미 접수한 신고입니다. 기존 처리 건에 안전하게 연결했습니다.' : `신고가 접수되었습니다. 현재 ${result.reportCount.toLocaleString('ko-KR')}건이 함께 검토됩니다.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '신고를 접수하지 못했습니다.');
    } finally { setWorking(false); }
  }

  function close() { setOpen(false); setReason(''); setMessage(null); setSuccess(false); }

  return <>
    <button type="button" disabled={loading} onClick={() => setOpen(true)} className={compact ? 'inline-flex min-h-11 items-center gap-1 text-slate-500 hover:text-red-200' : 'chip chip-muted inline-flex min-h-11 items-center gap-1.5'}>
      <Flag className="size-3.5" /> 신고
    </button>
    {open ? <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }} className="fixed inset-0 z-[80] grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <section role="dialog" aria-modal="true" aria-labelledby={`report-${targetType}-${targetId}`} className="w-full max-w-lg rounded-xl border border-white/15 bg-[#111821] p-5 shadow-2xl sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-red-200">Safety report</p><h2 id={`report-${targetType}-${targetId}`} className="mt-2 text-xl font-bold text-white">{LABELS[targetType]} 신고</h2><p className="mt-2 text-sm leading-6 text-slate-400">운영진에게만 보이는 사유와 현재 콘텐츠 증거가 함께 보존됩니다.</p></div>
          <button type="button" onClick={close} aria-label="신고 창 닫기" className="grid size-10 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"><X className="size-5" /></button>
        </div>
        {!account ? <div className="mt-5 border border-amber-300/25 bg-amber-300/[0.06] p-4 text-sm leading-6 text-amber-100"><AlertTriangle className="mr-2 inline size-4" />신고 이력의 악용을 막기 위해 로그인이 필요합니다. <Link href={`/login?returnTo=${encodeURIComponent(returnTo)}`} className="font-semibold underline">로그인</Link></div> : success ? <div role="status" className="mt-5 border border-emerald-300/25 bg-emerald-300/[0.06] p-4 text-sm leading-6 text-emerald-100">{message}</div> : <form onSubmit={submit} className="mt-5 space-y-4">
          <label className="block text-sm font-semibold text-slate-200">신고 사유<textarea autoFocus required minLength={3} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="문제가 되는 내용과 이유를 구체적으로 적어 주세요." className="mt-2 min-h-32 w-full rounded-lg border border-white/10 bg-black/20 p-3 font-normal leading-6 text-white outline-none focus:border-emerald-300/60" /></label>
          <div className="flex items-center justify-between gap-3"><span className="text-xs text-slate-500">{reason.length.toLocaleString('ko-KR')} / 1,000</span><button disabled={working || reason.trim().length < 3} className="btn-primary min-h-11 gap-2 disabled:opacity-40">{working ? <Loader2 className="size-4 animate-spin" /> : <Flag className="size-4" />} 신고 접수</button></div>
          {message ? <p role="alert" className="text-sm text-red-200">{message}</p> : null}
        </form>}
      </section>
    </div> : null}
  </>;
}

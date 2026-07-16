'use client';

import { AlertTriangle, Flag, Loader2, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
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
  const titleId = useId();
  const descriptionId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : triggerRef.current;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => {
      if (account) textareaRef.current?.focus();
      else firstFocusable(dialogRef.current)?.focus();
    }, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false); setReason(''); setMessage(null); setSuccess(false);
      } else if (event.key === 'Tab') {
        trapFocus(event, dialogRef.current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [account, open]);

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
    <button ref={triggerRef} type="button" disabled={loading} onClick={() => setOpen(true)} className={compact ? 'inline-flex min-h-11 items-center gap-1 text-slate-500 hover:text-red-200' : 'chip chip-muted inline-flex min-h-11 items-center gap-1.5'}>
      <Flag className="size-3.5" /> 신고
    </button>
    {open ? <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }} className="fixed inset-0 z-[80] grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} className="wiki-report-dialog surface-flat w-full max-w-lg p-5 shadow-2xl sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div><p className="wiki-report-eyebrow text-xs font-semibold uppercase tracking-[0.18em]">Safety report</p><h2 id={titleId} className="mt-2 text-xl font-bold text-white">{LABELS[targetType]} 신고</h2><p id={descriptionId} className="mt-2 text-sm leading-6 text-slate-400">운영진에게만 보이는 사유와 현재 콘텐츠 증거가 함께 보존됩니다.</p></div>
          <button type="button" onClick={close} aria-label="신고 창 닫기" className="grid size-10 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"><X className="size-5" /></button>
        </div>
        {!account ? <div className="wiki-report-warning mt-5 border p-4 text-sm leading-6"><AlertTriangle className="mr-2 inline size-4" />신고 이력의 악용을 막기 위해 로그인이 필요합니다. <Link href={`/login?returnTo=${encodeURIComponent(returnTo)}`} className="font-semibold underline">로그인</Link></div> : success ? <div role="status" className="mt-5 border border-emerald-300/25 bg-emerald-300/[0.06] p-4 text-sm leading-6 text-emerald-100">{message}</div> : <form onSubmit={submit} className="mt-5 space-y-4">
          <label className="block text-sm font-semibold text-slate-200">신고 사유<textarea ref={textareaRef} required minLength={3} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="문제가 되는 내용과 이유를 구체적으로 적어 주세요." className="mt-2 min-h-32 w-full rounded-lg border border-white/10 bg-black/20 p-3 font-normal leading-6 text-white outline-none focus:border-emerald-300/60" /></label>
          <div className="flex items-center justify-between gap-3"><span className="text-xs text-slate-500">{reason.length.toLocaleString('ko-KR')} / 1,000</span><button disabled={working || reason.trim().length < 3} className="btn-primary min-h-11 gap-2 disabled:opacity-40">{working ? <Loader2 className="size-4 animate-spin" /> : <Flag className="size-4" />} 신고 접수</button></div>
          {message ? <p role="alert" className="text-sm text-red-200">{message}</p> : null}
        </form>}
      </section>
    </div> : null}
  </>;
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    .filter((element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true');
}

function firstFocusable(container: HTMLElement | null): HTMLElement | undefined { return focusableElements(container)[0]; }

function trapFocus(event: KeyboardEvent, container: HTMLElement | null): void {
  const controls = focusableElements(container);
  if (controls.length === 0) return;
  const first = controls[0]!;
  const last = controls.at(-1)!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

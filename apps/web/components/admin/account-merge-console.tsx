'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, GitMerge, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { csrfHeaders } from '../../lib/csrf';
import { getApiBaseUrl } from '../../lib/runtime-config';
import type { AccountMergeAdminItem, AccountMergeStatus } from './account-merge-types';

const STATUS_LABELS: Record<AccountMergeStatus, string> = {
  pending: '검토 대기', completed: '연결 완료', rejected: '반려', failed: '처리 실패',
};

const CONFLICT_LABELS: Record<string, string> = {
  verified_email_duplicate: '인증 이메일 중복',
  minecraft_identity_duplicate: 'Minecraft 계정 중복',
  discord_identity_duplicate: 'Discord 계정 중복',
  discord_minecraft_mismatch: 'Discord·Minecraft 검증 불일치',
  legacy_wiki_profile: '기존 위키 프로필',
};

type Decision = {
  readonly item: AccountMergeAdminItem;
  readonly action: 'approve' | 'reject';
};

export function AccountMergeConsole() {
  const [items, setItems] = useState<AccountMergeAdminItem[]>([]);
  const [status, setStatus] = useState<AccountMergeStatus | 'all'>('pending');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [targetAccountId, setTargetAccountId] = useState('');
  const [reason, setReason] = useState('');
  const [evidenceConfirmed, setEvidenceConfirmed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = status === 'all' ? '' : `?status=${encodeURIComponent(status)}`;
      const response = await fetch(`${getApiBaseUrl()}/v1/admin/account-merge-requests${query}`, {
        credentials: 'include',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(problemMessage(payload, '계정 병합 요청을 불러오지 못했습니다.'));
      if (!Array.isArray(payload)) throw new Error('계정 병합 요청 응답 형식이 올바르지 않습니다.');
      setItems(payload as AccountMergeAdminItem[]);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '계정 병합 요청을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  function begin(item: AccountMergeAdminItem, action: Decision['action']) {
    setDecision({ item, action });
    setTargetAccountId(item.targetCanonicalAccountId ?? item.candidateTargetAccountIds[0] ?? '');
    setReason('');
    setEvidenceConfirmed(false);
    setError(null);
    setFeedback(null);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!decision || reason.trim().length < 8) return;
    if (decision.action === 'approve' && (!targetAccountId || !evidenceConfirmed)) return;
    setWorking(true);
    setError(null);
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/v1/admin/account-merge-requests/${decision.item.id}/${decision.action}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
          body: JSON.stringify(decision.action === 'approve' ? {
            targetCanonicalAccountId: targetAccountId,
            reason: reason.trim(),
            evidenceConfirmed: true,
            version: decision.item.version,
          } : {
            reason: reason.trim(),
            version: decision.item.version,
          }),
        },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(problemMessage(payload, '계정 병합 요청을 처리하지 못했습니다.'));
      setFeedback(decision.action === 'approve'
        ? '계정 연결을 완료하고 기존 세션을 모두 종료했습니다.'
        : '계정 연결 요청을 반려했습니다.');
      setDecision(null);
      await load();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '계정 병합 요청을 처리하지 못했습니다.');
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="space-y-6 text-white">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#35e5b7]">Account Recovery</p>
        <h1 className="mt-2 flex items-center gap-3 text-3xl font-extrabold"><GitMerge className="h-7 w-7 text-[#35e5b7]" />계정 연결 검토</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">Discord·이메일·Minecraft 로그인 충돌의 snapshot을 재검증하고, 소유권 증거가 확인된 요청만 하나의 대표 계정으로 연결합니다.</p>
      </header>

      <section className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-[#17191c] p-4 sm:flex-row sm:items-center">
        <label className="flex-1"><span className="sr-only">상태 필터</span><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="min-h-11 w-full rounded-lg border border-white/10 bg-[#101214] px-3 text-sm sm:max-w-xs"><option value="all">모든 상태</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/10 px-4 text-sm font-bold hover:bg-white/5 disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />새로고침</button>
      </section>

      {error ? <p role="alert" className="rounded-xl border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">{error}</p> : null}
      {feedback ? <p role="status" className="rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-4 text-sm text-emerald-100">{feedback}</p> : null}
      {loading ? <div className="flex min-h-44 items-center justify-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />요청을 불러오는 중</div> : null}
      {!loading && items.length === 0 ? <p className="rounded-2xl border border-dashed border-white/10 p-12 text-center text-sm text-slate-500">조건에 맞는 계정 연결 요청이 없습니다.</p> : null}

      <section className="space-y-4">
        {items.map((item) => <MergeRequestCard key={item.id} item={item} working={working} onDecision={begin} />)}
      </section>

      {decision ? <DecisionPanel decision={decision} targetAccountId={targetAccountId} reason={reason} evidenceConfirmed={evidenceConfirmed} working={working} onTarget={setTargetAccountId} onReason={setReason} onEvidence={setEvidenceConfirmed} onCancel={() => setDecision(null)} onSubmit={submit} /> : null}
    </div>
  );
}

function MergeRequestCard({ item, working, onDecision }: { readonly item: AccountMergeAdminItem; readonly working: boolean; readonly onDecision: (item: AccountMergeAdminItem, action: Decision['action']) => void }) {
  return <article className="rounded-2xl border border-white/10 bg-[#17191c] p-5 sm:p-6"><div className="flex flex-col gap-3 sm:flex-row sm:justify-between"><div><span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-xs font-bold">{STATUS_LABELS[item.status] ?? item.status}</span><h2 className="mt-3 text-sm font-bold">요청 {shortId(item.id)}</h2><p className="mt-1 text-xs text-slate-500">지원 티켓 {shortId(item.ticketId)} · v{item.version}</p></div><p className="text-xs text-slate-400">{formatDate(item.createdAt)}</p></div><dl className="mt-4 grid gap-2 rounded-xl bg-black/20 p-4 text-xs sm:grid-cols-2"><div><dt className="text-slate-500">요청 계정</dt><dd className="mt-1 break-all text-slate-200">{item.sourceCanonicalAccountId}</dd></div><div><dt className="text-slate-500">후보 대표 계정</dt><dd className="mt-1 break-all text-slate-200">{item.candidateTargetAccountIds.join(', ') || '자동 승인 불가'}</dd></div></dl><div className="mt-4 space-y-2">{item.conflicts.map((conflict) => <div key={conflict.id} className="rounded-lg border border-amber-300/15 bg-amber-300/5 p-3 text-xs leading-5 text-amber-50/80"><strong className="text-amber-100">{CONFLICT_LABELS[conflict.kind] ?? conflict.kind}</strong><p>{conflict.message}</p></div>)}</div>{item.decisionReason ? <p className="mt-4 text-xs leading-5 text-slate-400">결정 사유: {item.decisionReason}</p> : null}{item.status === 'pending' ? <div className="mt-5 flex flex-col gap-2 border-t border-white/10 pt-4 sm:flex-row"><button type="button" onClick={() => onDecision(item, 'approve')} disabled={working || item.candidateTargetAccountIds.length === 0} className="btn-primary min-h-11"><CheckCircle2 className="h-4 w-4" />증거 확인 후 승인</button><button type="button" onClick={() => onDecision(item, 'reject')} disabled={working} className="btn-secondary min-h-11"><XCircle className="h-4 w-4" />반려</button>{item.candidateTargetAccountIds.length === 0 ? <span className="flex items-center gap-1 text-xs text-amber-200"><AlertTriangle className="h-4 w-4" />상대 계정 증거가 없어 승인할 수 없습니다.</span> : null}</div> : null}</article>;
}

function DecisionPanel(props: { readonly decision: Decision; readonly targetAccountId: string; readonly reason: string; readonly evidenceConfirmed: boolean; readonly working: boolean; readonly onTarget: (value: string) => void; readonly onReason: (value: string) => void; readonly onEvidence: (value: boolean) => void; readonly onCancel: () => void; readonly onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  const approve = props.decision.action === 'approve';
  return <form onSubmit={props.onSubmit} className="sticky bottom-4 z-20 rounded-2xl border border-[#35e5b7]/25 bg-[#111513] p-5 shadow-2xl"><h2 className="text-lg font-bold">{approve ? '계정 연결 승인' : '계정 연결 반려'}</h2><p className="mt-1 text-xs text-slate-400">요청 {shortId(props.decision.item.id)}의 현재 버전 {props.decision.item.version}을 처리합니다.</p>{approve ? <><label className="mt-4 block text-xs font-semibold text-slate-300">대표 계정<select value={props.targetAccountId} onChange={(event) => props.onTarget(event.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm">{props.decision.item.candidateTargetAccountIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label><label className="mt-4 flex items-start gap-3 rounded-xl border border-amber-300/20 bg-amber-300/5 p-3 text-sm text-amber-50"><input type="checkbox" checked={props.evidenceConfirmed} onChange={(event) => props.onEvidence(event.target.checked)} className="mt-1" /><span>지원 기록과 외부 증거로 양쪽 로그인 수단의 실제 소유권을 확인했습니다.</span></label></> : null}<label className="mt-4 block text-xs font-semibold text-slate-300">운영 사유<textarea value={props.reason} onChange={(event) => props.onReason(event.target.value)} required minLength={8} maxLength={1000} rows={4} className="mt-2 w-full rounded-lg border border-white/10 bg-black/20 p-3 text-sm font-normal" placeholder="검증 근거와 결정 사유를 8자 이상 기록하세요." /></label><div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={props.onCancel} disabled={props.working} className="btn-secondary min-h-11">취소</button><button disabled={props.working || props.reason.trim().length < 8 || (approve && !props.evidenceConfirmed)} className="btn-primary min-h-11">{props.working ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{approve ? '연결 승인' : '반려 확정'}</button></div></form>;
}

function shortId(value: string): string { return value.length > 13 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value; }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('ko-KR'); }
function problemMessage(payload: unknown, fallback: string): string { return typeof payload === 'object' && payload && 'message' in payload && typeof payload.message === 'string' ? payload.message : fallback; }

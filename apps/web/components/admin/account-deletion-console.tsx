'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Ban, Loader2, RefreshCw, ShieldAlert, UserRoundX } from 'lucide-react';
import { csrfHeaders } from '../../lib/csrf';
import { getApiBaseUrl } from '../../lib/runtime-config';

type DeletionStatus = 'requested' | 'processing' | 'blocked' | 'cancelled' | 'completed' | 'rejected';

interface AccountDeletionBlocker {
  readonly type: string;
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

interface AccountDeletionAdminItem {
  readonly id: string;
  readonly status: DeletionStatus;
  readonly requestedAt: string;
  readonly scheduledFor: string;
  readonly cancelledAt: string | null;
  readonly processedAt: string | null;
  readonly adminNote: string | null;
  readonly canonicalAccountId: string;
  readonly accountIds: string[];
  readonly blockers: AccountDeletionBlocker[] | null;
  readonly requestedBy: string;
  readonly processedBy: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

const STATUS_LABELS: Record<DeletionStatus, string> = {
  requested: '유예 중', processing: '처리 중', blocked: '자산 이전 필요', cancelled: '사용자 취소', completed: '비식별화 완료', rejected: '관리자 반려',
};

const ACTIVE_STATUSES = new Set<DeletionStatus>(['requested', 'blocked', 'processing']);

export function AccountDeletionConsole() {
  const [items, setItems] = useState<AccountDeletionAdminItem[]>([]);
  const [status, setStatus] = useState<DeletionStatus | 'all'>('requested');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = status === 'all' ? '' : `?status=${encodeURIComponent(status)}`;
      const response = await fetch(`${getApiBaseUrl()}/v1/admin/account-deletions${query}`, { credentials: 'include' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? '계정 종료 요청을 불러오지 못했습니다.');
      if (!Array.isArray(payload)) throw new Error('계정 종료 요청 응답 형식이 올바르지 않습니다.');
      setItems(payload as AccountDeletionAdminItem[]);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '계정 종료 요청을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  async function act(item: AccountDeletionAdminItem, action: 'process' | 'reject') {
    const promptText = action === 'process'
      ? '처리 메모를 입력하세요. 유예기간이 끝났고 blocker가 없으면 개인정보가 비식별화됩니다.'
      : '반려 사유를 입력하세요. 사용자 계정은 다시 활성 상태가 됩니다.';
    const note = window.prompt(promptText);
    if (!note?.trim()) return;
    if (action === 'process' && !window.confirm('이 계정 그룹을 영구 비식별화 처리하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
    setPending(item.id);
    setError(null);
    try {
      const response = await fetch(`${getApiBaseUrl()}/v1/admin/account-deletions/${item.id}/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({ note: note.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message ?? '계정 종료 요청 상태를 변경하지 못했습니다.');
      await load();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '계정 종료 요청 상태를 변경하지 못했습니다.');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-6 text-white">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#35e5b7]">Account Lifecycle</p>
        <h1 className="mt-2 flex items-center gap-3 text-3xl font-extrabold"><UserRoundX className="h-7 w-7 text-[#35e5b7]" />계정 종료 운영</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">14일 유예, 자산 이전 blocker, 취소와 비식별화 처리 상태를 확인합니다. 완료 작업은 감사 이벤트에 기록됩니다.</p>
      </header>

      <section className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-[#17191c] p-4 sm:flex-row sm:items-center">
        <label className="flex-1 text-sm text-slate-300">
          <span className="sr-only">상태 필터</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="min-h-11 w-full rounded-lg border border-white/10 bg-[#101214] px-3 text-sm text-white sm:max-w-xs">
            <option value="all">모든 상태</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/10 px-4 text-sm font-bold hover:bg-white/5 disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />새로고침</button>
      </section>

      {error ? <p role="alert" className="rounded-xl border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">{error}</p> : null}
      {loading ? <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />계정 종료 요청을 불러오는 중</div> : null}
      {!loading && items.length === 0 ? <p className="rounded-2xl border border-dashed border-white/10 p-12 text-center text-sm text-slate-500">조건에 맞는 계정 종료 요청이 없습니다.</p> : null}

      <section className="space-y-4">
        {items.map((item) => {
          const blockers = Array.isArray(item.blockers) ? item.blockers : [];
          const due = Date.parse(item.scheduledFor) <= Date.now();
          const staleProcessing = item.status === 'processing' && Date.parse(item.updatedAt) <= Date.now() - 15 * 60_000;
          const actionable = ACTIVE_STATUSES.has(item.status) && (item.status !== 'processing' || staleProcessing);
          return (
            <article key={item.id} className="rounded-2xl border border-white/10 bg-[#17191c] p-5 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold ${item.status === 'blocked' ? 'border-amber-400/25 bg-amber-500/10 text-amber-200' : item.status === 'completed' ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200' : 'border-white/10 bg-black/20 text-slate-200'}`}>{STATUS_LABELS[item.status] ?? item.status}</span>
                  <h2 className="mt-3 break-all text-sm font-bold text-white">대표 계정 {item.canonicalAccountId}</h2>
                  <p className="mt-1 text-xs text-slate-500">요청 ID {item.id} · 연결 계정 {item.accountIds.length}개 · v{item.version}</p>
                </div>
                <div className="text-xs leading-5 text-slate-400 sm:text-right">
                  <p>요청 {formatDate(item.requestedAt)}</p>
                  <p className={due ? 'font-semibold text-amber-200' : ''}>처리 예정 {formatDate(item.scheduledFor)}</p>
                </div>
              </div>

              {blockers.length > 0 ? <div className="mt-4 space-y-2 rounded-xl border border-amber-400/20 bg-amber-500/5 p-3"><p className="flex items-center gap-2 text-xs font-bold text-amber-200"><ShieldAlert className="h-4 w-4" />이전 필수 자산 {blockers.length}건</p>{blockers.map((blocker) => <div key={`${blocker.type}:${blocker.id}`} className="text-xs leading-5 text-amber-100/80"><strong className="text-amber-100">{blocker.name}</strong> · {blocker.reason}</div>)}</div> : null}
              {item.adminNote ? <p className="mt-4 rounded-lg bg-black/20 p-3 text-xs leading-5 text-slate-300">운영 메모: {item.adminNote}</p> : null}
              <dl className="mt-4 grid gap-2 text-xs text-slate-500 sm:grid-cols-2">
                <div><dt className="inline">신청자 </dt><dd className="inline break-all text-slate-300">{item.requestedBy}</dd></div>
                <div><dt className="inline">처리자 </dt><dd className="inline break-all text-slate-300">{item.processedBy ?? '-'}</dd></div>
                {item.cancelledAt ? <div><dt className="inline">취소 </dt><dd className="inline text-slate-300">{formatDate(item.cancelledAt)}</dd></div> : null}
                {item.processedAt ? <div><dt className="inline">완료 </dt><dd className="inline text-slate-300">{formatDate(item.processedAt)}</dd></div> : null}
              </dl>

              {actionable ? <div className="mt-5 flex flex-col gap-2 border-t border-white/10 pt-4 sm:flex-row">
                <button type="button" onClick={() => void act(item, 'process')} disabled={!due || pending === item.id} title={!due ? '14일 유예기간이 끝난 뒤 처리할 수 있습니다.' : undefined} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-400/25 bg-red-500/10 px-4 text-sm font-bold text-red-100 disabled:cursor-not-allowed disabled:opacity-40"><AlertTriangle className="h-4 w-4" />{pending === item.id ? '처리 중' : due ? '비식별화 처리' : '유예기간 진행 중'}</button>
                {item.status !== 'processing' ? <button type="button" onClick={() => void act(item, 'reject')} disabled={pending === item.id} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/10 px-4 text-sm font-bold hover:bg-white/5 disabled:opacity-40"><Ban className="h-4 w-4" />관리자 반려</button> : null}
              </div> : null}
            </article>
          );
        })}
      </section>
    </div>
  );
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleString('ko-KR');
}

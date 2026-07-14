'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, Search, UserCheck, X } from 'lucide-react';
import { csrfHeaders } from '../../lib/csrf';
import { getApiBaseUrl } from '../../lib/runtime-config';

type ReportStatus = 'open' | 'in_review' | 'resolved' | 'dismissed';
interface ReportItem {
  readonly id: string;
  readonly reason: string;
  readonly status: ReportStatus;
  readonly resolution: string | null;
  readonly createdAt: string;
  readonly statusUpdatedAt: string;
  readonly assignee: { id: string; displayName: string | null; email: string | null } | null;
  readonly reporter: { id: string; displayName: string | null; email: string | null };
  readonly review: {
    id: string;
    serverId: string;
    serverName: string;
    authorDisplayName: string;
    body: string;
    visibility: 'public' | 'staff';
    reports: number;
  };
}

interface QueueResponse {
  readonly items: ReportItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

const STATUS_LABELS: Record<ReportStatus, string> = {
  open: '접수',
  in_review: '조사 중',
  resolved: '해결',
  dismissed: '기각',
};

export function ReviewModerationConsole() {
  const [queue, setQueue] = useState<QueueResponse>({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });
  const [status, setStatus] = useState<ReportStatus | 'all'>('open');
  const [assignee, setAssignee] = useState<'all' | 'me' | 'unassigned'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (status !== 'all') params.set('status', status);
    if (assignee !== 'all') params.set('assignee', assignee);
    if (search.trim()) params.set('search', search.trim());
    try {
      const response = await fetch(`${getApiBaseUrl()}/v1/admin/review-reports?${params}`, {
        credentials: 'include',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message ?? '신고 큐를 불러오지 못했습니다.');
      setQueue(body as QueueResponse);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '신고 큐를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [assignee, page, search, status]);

  useEffect(() => { void load(); }, [load]);

  async function mutate(reportId: string, action: 'assign' | 'resolve' | 'dismiss') {
    let body: Record<string, unknown> = {};
    if (action !== 'assign') {
      const resolution = window.prompt(action === 'resolve' ? '처리 결과를 입력하세요.' : '기각 사유를 입력하세요.');
      if (!resolution?.trim()) return;
      body = {
        resolution: resolution.trim(),
        hideReview: window.confirm('이 리뷰를 공개 목록에서 숨기시겠습니까?'),
      };
    }
    setPending(reportId);
    try {
      const response = await fetch(`${getApiBaseUrl()}/v1/admin/review-reports/${reportId}/${action}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message ?? '신고 상태를 변경하지 못했습니다.');
      await load();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '신고 상태를 변경하지 못했습니다.');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-6 text-white">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#35e5b7]">Review Trust &amp; Safety</p>
        <h1 className="mt-2 text-3xl font-extrabold">리뷰 신고 관리</h1>
        <p className="mt-2 text-sm text-slate-400">신고를 배정하고 조사 결과와 리뷰 공개 상태를 함께 관리합니다.</p>
      </header>

      <section className="grid gap-3 rounded-2xl border border-white/10 bg-[#17191c] p-4 md:grid-cols-[180px_180px_1fr_auto]">
        <select value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setPage(1); }} className="rounded-lg border border-white/10 bg-[#101214] px-3 py-2 text-sm">
          <option value="all">모든 상태</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select value={assignee} onChange={(event) => { setAssignee(event.target.value as typeof assignee); setPage(1); }} className="rounded-lg border border-white/10 bg-[#101214] px-3 py-2 text-sm">
          <option value="all">모든 담당자</option><option value="me">내 담당</option><option value="unassigned">미배정</option>
        </select>
        <label className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#101214] px-3">
          <Search className="h-4 w-4 text-slate-500" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="사유·리뷰·작성자 검색" className="w-full bg-transparent py-2 text-sm outline-none" />
        </label>
        <button type="button" onClick={() => { setPage(1); void load(); }} className="rounded-lg bg-[#35e5b7] px-4 py-2 text-sm font-bold text-[#07110e]">검색</button>
      </section>

      {error ? <p className="rounded-xl border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">{error}</p> : null}
      {loading ? <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> 신고 큐를 불러오는 중</div> : null}
      {!loading && queue.items.length === 0 ? <p className="rounded-2xl border border-dashed border-white/10 p-12 text-center text-sm text-slate-500">조건에 맞는 신고가 없습니다.</p> : null}

      <div className="space-y-3">
        {queue.items.map((report) => (
          <article key={report.id} className="rounded-2xl border border-white/10 bg-[#17191c] p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><span className="rounded-full border border-amber-400/20 bg-amber-500/10 px-2.5 py-1 text-xs font-bold text-amber-200">{STATUS_LABELS[report.status]}</span><h2 className="mt-3 font-bold">{report.review.serverName} · {report.review.authorDisplayName}</h2></div>
              <span className="text-xs text-slate-500">{new Date(report.createdAt).toLocaleString('ko-KR')}</span>
            </div>
            <p className="mt-4 rounded-lg bg-black/20 p-3 text-sm text-slate-200">{report.review.body}</p>
            <div className="mt-3 flex items-start gap-2 text-sm text-amber-100"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{report.reason}</div>
            <p className="mt-3 text-xs text-slate-500">담당: {report.assignee?.displayName ?? report.assignee?.email ?? '미배정'} · 공개 상태: {report.review.visibility}</p>
            {report.resolution ? <p className="mt-2 text-xs text-slate-400">처리 결과: {report.resolution}</p> : null}
            {!['resolved', 'dismissed'].includes(report.status) ? <div className="mt-4 flex flex-wrap gap-2">
              <ActionButton icon={UserCheck} label="내게 배정" disabled={pending === report.id} onClick={() => void mutate(report.id, 'assign')} />
              <ActionButton icon={Check} label="해결" disabled={pending === report.id} onClick={() => void mutate(report.id, 'resolve')} />
              <ActionButton icon={X} label="기각" disabled={pending === report.id} onClick={() => void mutate(report.id, 'dismiss')} />
            </div> : null}
          </article>
        ))}
      </div>

      <footer className="flex items-center justify-between text-sm text-slate-400"><span>총 {queue.total.toLocaleString('ko-KR')}건</span><div className="flex gap-2"><button disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded border border-white/10 px-3 py-1 disabled:opacity-40">이전</button><span className="px-2 py-1">{page} / {Math.max(queue.totalPages, 1)}</span><button disabled={queue.totalPages === 0 || page >= queue.totalPages} onClick={() => setPage((value) => value + 1)} className="rounded border border-white/10 px-3 py-1 disabled:opacity-40">다음</button></div></footer>
    </div>
  );
}

function ActionButton({ icon: Icon, label, disabled, onClick }: { readonly icon: typeof Check; readonly label: string; readonly disabled: boolean; readonly onClick: () => void }) {
  return <button type="button" disabled={disabled} onClick={onClick} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5 disabled:opacity-40"><Icon className="h-3.5 w-3.5" />{label}</button>;
}

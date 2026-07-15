'use client';

import { AlertTriangle, CheckCircle2, GitMerge, Loader2, XCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import {
  approveWikiProfileMerge,
  fetchWikiProfileMergeRequests,
  rejectWikiProfileMerge,
  type WikiProfileMergeAdminRequest
} from '../../lib/wiki-api';

export function WikiProfileMergeAdmin() {
  const [requests, setRequests] = useState<WikiProfileMergeAdminRequest[]>([]);
  const [selected, setSelected] = useState<{ request: WikiProfileMergeAdminRequest; action: 'approve' | 'reject' } | null>(null);
  const [sourceUsername, setSourceUsername] = useState('');
  const [targetUsername, setTargetUsername] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setRequests(await fetchWikiProfileMergeRequests());
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '프로필 병합 요청을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const choose = (request: WikiProfileMergeAdminRequest, action: 'approve' | 'reject') => {
    setSelected({ request, action });
    setSourceUsername('');
    setTargetUsername('');
    setReason('');
    setError(null);
    setFeedback(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    if (reason.trim().length < 8) {
      setError('운영 사유를 8자 이상 입력해 주세요.');
      return;
    }
    if (selected.action === 'approve' &&
        (sourceUsername !== selected.request.source?.username || targetUsername !== selected.request.target?.username)) {
      setError('원본 및 대상 사용자명을 정확히 입력해 주세요.');
      return;
    }
    setWorking(true);
    setError(null);
    try {
      if (selected.action === 'approve') {
        await approveWikiProfileMerge({
          requestId: selected.request.id,
          sourceUsername,
          targetUsername,
          reason: reason.trim()
        });
        setFeedback('위키 프로필 병합이 완료되었습니다. 감사 기록과 별칭이 생성되었습니다.');
      } else {
        await rejectWikiProfileMerge({ requestId: selected.request.id, reason: reason.trim() });
        setFeedback('위키 프로필 병합 요청을 거절했습니다.');
      }
      setRequests((current) => current.filter((request) => request.id !== selected.request.id));
      setSelected(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '프로필 병합 요청을 처리하지 못했습니다.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="border border-white/10 bg-white/[0.025] p-4 sm:p-5" aria-labelledby="profile-merge-admin-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="profile-merge-admin-title" className="flex items-center gap-2 text-lg font-semibold text-white"><GitMerge className="size-5 text-blue-200" /> 프로필 병합 승인</h2>
          <p className="mt-1 text-sm leading-6 text-slate-400">연결된 계정 그룹을 서버에서 다시 검증한 뒤 현재 소유권과 ACL만 이동합니다.</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="btn-secondary min-h-11 w-full sm:w-auto">{loading ? <Loader2 className="size-4 animate-spin" /> : null} 새로고침</button>
      </div>

      {loading ? <p className="mt-4 flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin text-emerald-300" /> 대기 중 요청을 불러오는 중입니다.</p> : null}
      {!loading && requests.length === 0 ? <p className="mt-4 border border-dashed border-white/15 p-5 text-center text-sm text-slate-500">대기 중인 병합 요청이 없습니다.</p> : null}
      <div className="mt-4 grid gap-3">
        {requests.map((request) => {
          const historyCount = request.preview ? sumCounts(request.preview.counts.historical) : 0;
          const currentCount = request.preview ? sumCounts(request.preview.counts.current) : 0;
          return (
            <article key={request.id} className="border border-white/10 bg-[#111821] p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <p className="break-all font-semibold text-white">@{request.source?.username ?? request.sourceProfileId} <span className="text-slate-500">→</span> @{request.target?.username ?? request.targetProfileId}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">과거 활동 {historyCount}건 · 이동할 현재 상태 {currentCount}건 · {formatDate(request.requestedAt)}</p>
                  {request.preview?.requiresBlockedStatus ? <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-amber-200"><AlertTriangle className="size-3.5" /> 승인 시 대상 프로필도 차단 상태가 됩니다.</p> : null}
                  {request.reason ? <p className="mt-2 text-sm text-slate-300 [overflow-wrap:anywhere]">요청자 설명: {request.reason}</p> : null}
                </div>
                <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
                  <button type="button" onClick={() => choose(request, 'reject')} className="btn-secondary min-h-11 w-full text-red-200 sm:w-auto"><XCircle className="size-4" /> 거절</button>
                  <button type="button" onClick={() => choose(request, 'approve')} className="btn-primary min-h-11 w-full sm:w-auto"><CheckCircle2 className="size-4" /> 검토 후 승인</button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {selected ? (
        <form onSubmit={submit} className="mt-4 space-y-4 border border-amber-300/25 bg-amber-300/5 p-4 sm:p-5">
          <div>
            <h3 className="font-semibold text-white">{selected.action === 'approve' ? '병합을 최종 승인합니다.' : '병합 요청을 거절합니다.'}</h3>
            <p className="mt-1 text-sm leading-6 text-slate-400">요청 ID <span className="break-all font-mono text-xs">{selected.request.id}</span></p>
          </div>
          {selected.action === 'approve' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-slate-300">원본 사용자명 재입력<input value={sourceUsername} onChange={(event) => setSourceUsername(event.target.value)} autoComplete="off" placeholder={selected.request.source?.username ?? ''} className="mt-2 min-h-11 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm font-normal text-white outline-none focus:border-emerald-300/50" /></label>
              <label className="text-xs font-semibold text-slate-300">대상 사용자명 재입력<input value={targetUsername} onChange={(event) => setTargetUsername(event.target.value)} autoComplete="off" placeholder={selected.request.target?.username ?? ''} className="mt-2 min-h-11 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm font-normal text-white outline-none focus:border-emerald-300/50" /></label>
            </div>
          ) : null}
          <label className="block text-xs font-semibold text-slate-300">운영 사유<textarea value={reason} onChange={(event) => setReason(event.target.value)} required minLength={8} maxLength={1000} rows={4} className="mt-2 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm font-normal text-white outline-none focus:border-emerald-300/50" placeholder="검증 근거와 승인 또는 거절 사유를 8자 이상 기록하세요." /></label>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={() => setSelected(null)} className="btn-secondary min-h-11">취소</button>
            <button disabled={working} className={`min-h-11 ${selected.action === 'approve' ? 'btn-primary' : 'btn-secondary text-red-200'}`}>{working ? <Loader2 className="size-4 animate-spin" /> : null}{selected.action === 'approve' ? '승인 및 실행' : '거절 확정'}</button>
          </div>
        </form>
      ) : null}
      {error ? <p role="alert" className="mt-4 flex gap-2 border border-red-300/30 bg-red-500/10 p-3 text-sm text-red-100"><AlertTriangle className="size-4 shrink-0" /> {error}</p> : null}
      {feedback ? <p role="status" className="mt-4 flex gap-2 border border-emerald-300/25 bg-emerald-300/10 p-3 text-sm text-emerald-100"><CheckCircle2 className="size-4 shrink-0" /> {feedback}</p> : null}
    </section>
  );
}

function sumCounts(counts: object): number {
  return Object.values(counts as Record<string, number>).reduce((sum, value) => sum + value, 0);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value));
}

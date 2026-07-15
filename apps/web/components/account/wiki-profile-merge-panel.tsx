'use client';

import { AlertTriangle, CheckCircle2, GitMerge, Loader2, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  fetchWikiProfileMergePreview,
  requestWikiProfileMerge,
  type WikiProfileMergePreview,
  type WikiProfileMergeRequestResponse
} from '../../lib/wiki-api';

export function WikiProfileMergePanel() {
  const [preview, setPreview] = useState<WikiProfileMergePreview | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceConfirmation, setSourceConfirmation] = useState('');
  const [targetConfirmation, setTargetConfirmation] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<WikiProfileMergeRequestResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchWikiProfileMergePreview()
      .then((value) => {
        if (!cancelled) setPreview(value);
      })
      .catch((problem) => {
        if (!cancelled) setError(problem instanceof Error ? problem.message : '위키 프로필 정보를 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const selected = useMemo(
    () => preview?.candidates.find((candidate) => candidate.profile.id === selectedId) ?? null,
    [preview, selectedId]
  );

  if (!loading && !error && !request && preview?.candidates.length === 0) return null;

  const submit = async () => {
    if (!preview || !selected) {
      setError('병합할 이전 위키 프로필을 선택해 주세요.');
      return;
    }
    if (sourceConfirmation !== selected.profile.username || targetConfirmation !== preview.target.username) {
      setError('이전 사용자명과 현재 사용자명을 각각 정확히 입력해 주세요.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await requestWikiProfileMerge({
        sourceProfileId: selected.profile.id,
        sourceUsername: sourceConfirmation,
        targetUsername: targetConfirmation,
        reason: reason.trim() || undefined
      });
      setRequest(created);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '위키 프로필 병합 요청을 접수하지 못했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="mb-6 rounded-lg border border-[#30363d] bg-[#181a1d] p-5 shadow-sm sm:p-6" aria-labelledby="wiki-profile-merge-title">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-blue-300/25 bg-blue-300/10 text-blue-200">
          <GitMerge className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 id="wiki-profile-merge-title" className="text-lg font-bold text-white">연결된 위키 프로필 통합</h2>
          <p className="mt-1 text-sm leading-6 text-[#a0a0a0]">
            로그인 수단을 연결하기 전에 각 계정으로 작성한 위키 기록이 따로 남아 있다면 하나의 공개 프로필로 통합할 수 있습니다.
          </p>
        </div>
      </div>

      {loading ? (
        <p className="mt-5 flex items-center gap-2 text-sm text-[#a0a0a0]" role="status">
          <Loader2 className="size-4 animate-spin text-[#13ec80]" aria-hidden /> 병합 가능한 위키 프로필을 확인하는 중입니다.
        </p>
      ) : null}

      {request ? (
        <div className="mt-5 rounded-lg border border-emerald-300/25 bg-emerald-300/10 p-4" role="status">
          <p className="flex items-center gap-2 font-semibold text-emerald-100"><CheckCircle2 className="size-4" /> 관리자 검토 요청이 접수되었습니다.</p>
          <p className="mt-2 break-all text-xs leading-5 text-emerald-100/75">요청 ID {request.id} · 현재 상태 {request.status}</p>
          <p className="mt-1 text-xs leading-5 text-emerald-100/75">승인 전에는 기여 기록이나 권한이 변경되지 않습니다.</p>
        </div>
      ) : null}

      {!loading && preview && !request ? (
        <div className="mt-5 space-y-5">
          <div className="rounded-lg border border-white/10 bg-[#111315] px-4 py-3">
            <p className="text-xs font-semibold text-[#8f98a3]">통합 대상 현재 프로필</p>
            <p className="mt-1 break-all text-sm font-semibold text-white">{preview.target.displayName} · @{preview.target.username}</p>
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-semibold text-white">이전 프로필 선택</legend>
            {preview.candidates.map((candidate) => {
              const currentCount = sumCounts(candidate.counts.current);
              const historyCount = sumCounts(candidate.counts.historical);
              const selectedCandidate = selectedId === candidate.profile.id;
              return (
                <label key={candidate.profile.id} className={`block cursor-pointer rounded-lg border p-4 transition ${selectedCandidate ? 'border-[#13ec80]/60 bg-[#13ec80]/10' : 'border-[#30363d] bg-[#111315] hover:border-[#59616a]'}`}>
                  <span className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="wiki-profile-merge-source"
                      value={candidate.profile.id}
                      checked={selectedCandidate}
                      onChange={() => {
                        setSelectedId(candidate.profile.id);
                        setSourceConfirmation('');
                        setTargetConfirmation('');
                        setError(null);
                      }}
                      className="mt-1 size-4 accent-[#13ec80]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block break-all text-sm font-semibold text-white">{candidate.profile.displayName} · @{candidate.profile.username}</span>
                      <span className="mt-1 block text-xs leading-5 text-[#8f98a3]">과거 활동 {historyCount}건 · 이동할 현재 상태 {currentCount}건</span>
                      {candidate.requiresBlockedStatus ? <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-amber-200"><AlertTriangle className="size-3.5" /> 차단 상태가 현재 프로필에도 적용됩니다.</span> : null}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          {selected ? (
            <div className="space-y-4 rounded-lg border border-white/10 bg-[#111315] p-4">
              <div className="flex items-start gap-2 text-xs leading-5 text-[#a0a0a0]">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[#13ec80]" aria-hidden />
                <p>과거 판·토론의 작성자 ID는 보존합니다. 현재 소유권·구독·ACL만 중복을 제거해 이동하며 사용자 문서를 덮어쓰지 않습니다.</p>
              </div>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-[#b8c0c8]">이전 사용자명 확인</span>
                <input value={sourceConfirmation} onChange={(event) => setSourceConfirmation(event.target.value)} placeholder={selected.profile.username} autoComplete="off" className="min-h-11 w-full rounded-md border border-[#30363d] bg-[#181a1d] px-3 text-sm text-white outline-none focus:border-[#13ec80]" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-[#b8c0c8]">현재 사용자명 확인</span>
                <input value={targetConfirmation} onChange={(event) => setTargetConfirmation(event.target.value)} placeholder={preview.target.username} autoComplete="off" className="min-h-11 w-full rounded-md border border-[#30363d] bg-[#181a1d] px-3 text-sm text-white outline-none focus:border-[#13ec80]" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-[#b8c0c8]">관리자에게 전달할 설명 (선택)</span>
                <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} placeholder="두 프로필이 모두 본인 소유임을 확인할 수 있는 내용을 적어 주세요." className="w-full rounded-md border border-[#30363d] bg-[#181a1d] px-3 py-2 text-sm text-white outline-none focus:border-[#13ec80]" />
              </label>
              <button type="button" onClick={() => void submit()} disabled={submitting} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-[#13ec80] px-4 text-sm font-semibold text-black transition hover:bg-[#35f29a] disabled:opacity-50 sm:w-auto">
                {submitting ? <Loader2 className="size-4 animate-spin" /> : <GitMerge className="size-4" />}
                {submitting ? '요청을 확인하는 중입니다.' : '관리자 승인 요청'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="mt-4 rounded-md border border-red-300/25 bg-red-300/10 px-3 py-2 text-sm text-red-200" role="alert">{error}</p> : null}
    </section>
  );
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

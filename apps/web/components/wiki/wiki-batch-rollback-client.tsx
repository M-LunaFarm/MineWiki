'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, Search, ShieldAlert, Undo2 } from 'lucide-react';
import {
  executeWikiBatchRollback,
  fetchWikiAdminUsers,
  previewWikiBatchRollback,
  type WikiAdminUserSummary,
  type WikiBatchRollbackExecution,
  type WikiBatchRollbackPreview,
} from '../../lib/wiki-api';
import { useAuth } from '../providers/auth-context';

const WINDOWS = [
  [60, '최근 1시간'], [180, '최근 3시간'], [360, '최근 6시간'], [1440, '최근 24시간'],
] as const;

const REASONS: Record<string, string> = {
  newer_non_target_revision: '대상 사용자 뒤에 정상 기여가 있어 자동 복구하지 않습니다.',
  no_safe_base: '되돌아갈 이전 공개판이 없어 수동 검토가 필요합니다.',
  too_many_affected_revisions: '연속된 대상 판이 100개를 넘어 수동 검토가 필요합니다.',
  deleted_page: '삭제된 문서는 자동 복구하지 않습니다.',
  no_current_revision: '현재 공개판이 없습니다.',
  current_not_public: '현재판 상태가 일관되지 않아 수동 검토가 필요합니다.',
  current_changed: '미리보기 이후 현재판이 변경되어 건너뛰었습니다.',
  safe_base_changed: '안전 기준판이 변경되어 건너뛰었습니다.',
};

export function WikiBatchRollbackClient({
  initialTargetProfileId,
  initialQuery,
}: {
  readonly initialTargetProfileId: string;
  readonly initialQuery: string;
}) {
  const { account, loading: authLoading } = useAuth();
  const [query, setQuery] = useState(initialQuery);
  const [users, setUsers] = useState<WikiAdminUserSummary[]>([]);
  const [target, setTarget] = useState<WikiAdminUserSummary | null>(null);
  const [sinceMinutes, setSinceMinutes] = useState(60);
  const [preview, setPreview] = useState<WikiBatchRollbackPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [execution, setExecution] = useState<WikiBatchRollbackExecution | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!account) { setLoading(false); return; }
    void searchUsers(initialQuery, initialTargetProfileId);
    // Initial query parameters only seed the first request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, authLoading]);

  async function searchUsers(search: string, preferredId = '') {
    setLoading(true); setError(null);
    try {
      const rows = await fetchWikiAdminUsers(search);
      setUsers(rows);
      if (preferredId) setTarget(rows.find((user) => user.id === preferredId) ?? null);
    } catch (caught) { setError(message(caught)); } finally { setLoading(false); }
  }

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    await searchUsers(query);
  }

  function chooseTarget(user: WikiAdminUserSummary) {
    setTarget(user); setPreview(null); setExecution(null); setSelected(new Set());
    setReason(''); setConfirmation(''); setError(null);
  }

  async function runPreview() {
    if (!target) return;
    setWorking(true); setError(null); setExecution(null);
    try {
      const next = await previewWikiBatchRollback({ targetProfileId: target.id, sinceMinutes, limit: 25 });
      setPreview(next);
      setTarget((current) => current ? { ...current, status: next.target.status } : current);
      setSelected(new Set(next.candidates.filter((candidate) => candidate.action === 'rollback' && candidate.expectedCurrentRevisionId).map((candidate) => candidate.pageId)));
    } catch (caught) { setError(message(caught)); } finally { setWorking(false); }
  }

  function toggle(pageId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(pageId)) next.delete(pageId); else next.add(pageId);
      return next;
    });
  }

  async function execute(event: FormEvent) {
    event.preventDefault();
    if (!preview || !target) return;
    const candidates = preview.candidates
      .filter((candidate) => selected.has(candidate.pageId) && candidate.expectedCurrentRevisionId)
      .flatMap((candidate) => candidate.expectedCurrentRevisionId
        ? [{ pageId: candidate.pageId, expectedCurrentRevisionId: candidate.expectedCurrentRevisionId }]
        : []);
    setWorking(true); setError(null);
    try {
      setExecution(await executeWikiBatchRollback({
        targetProfileId: target.id, sinceMinutes, reason,
        confirmUsername: confirmation, candidates,
      }));
    } catch (caught) { setError(message(caught)); } finally { setWorking(false); }
  }

  if (authLoading || loading) return <div className="flex min-h-[40vh] items-center justify-center"><Loader2 className="size-6 animate-spin text-emerald-300" /></div>;
  if (!account) return <section className="border border-white/10 p-6"><h1 className="text-2xl font-semibold text-white">로그인이 필요합니다</h1><Link href="/login?returnTo=/admin/wiki/batch-rollback" className="btn-primary mt-5">로그인</Link></section>;

  const executable = preview?.candidates.filter((candidate) => selected.has(candidate.pageId) && candidate.action === 'rollback') ?? [];
  const canExecute = target?.status === 'blocked' && executable.length > 0 && reason.trim().length >= 5 && confirmation === target.username && !working;

  return <div className="space-y-6">
    <header className="border border-white/10 bg-white/[0.03] p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div><p className="flex items-center gap-2 text-sm font-semibold text-amber-200"><ShieldAlert className="size-4" /> Wiki Incident Response</p><h1 className="mt-2 text-2xl font-semibold text-white">일괄 훼손 복구</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">현재판부터 연속된 대상 사용자의 판만 복구합니다. 정상 사용자의 중간·후속 기여는 자동으로 제거하지 않습니다.</p></div><AdminNav /></div>
    </header>
    {error ? <p role="alert" className="flex gap-2 border border-red-300/30 bg-red-500/10 p-4 text-sm text-red-100"><AlertTriangle className="size-4 flex-none" />{error}</p> : null}

    <section className="space-y-4 border border-white/10 bg-[#111821] p-5">
      <div><h2 className="font-semibold text-white">1. 대상 사용자 선택</h2><p className="mt-1 text-xs text-slate-500">실행 전 사용자의 위키 기여 상태가 차단되어 있어야 합니다.</p></div>
      <form onSubmit={submitSearch} className="flex flex-col gap-2 sm:flex-row"><input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={64} placeholder="사용자명 또는 표시 이름" className="min-h-11 min-w-0 flex-1 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white" /><button className="btn-secondary min-h-11"><Search className="size-4" />검색</button></form>
      <div className="grid gap-2 md:grid-cols-2">{users.map((user) => <button key={user.id} type="button" onClick={() => chooseTarget(user)} className={`min-h-16 border p-3 text-left transition ${target?.id === user.id ? 'border-emerald-300/50 bg-emerald-400/10' : 'border-white/10 hover:border-white/25'}`}><span className="flex flex-wrap items-center gap-2"><strong className="text-white">{user.displayName}</strong><span className={`chip ${user.status === 'blocked' ? 'border-red-300/30 text-red-200' : 'chip-muted'}`}>{user.status}</span></span><span className="mt-1 block break-all text-xs text-slate-500">@{user.username} · #{user.id}</span></button>)}</div>
    </section>

    {target ? <section className="space-y-4 border border-white/10 bg-[#111821] p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="font-semibold text-white">2. 안전 미리보기</h2><p className="mt-1 text-sm text-slate-400"><strong className="text-white">@{target.username}</strong> 사용자의 최근 기여를 서버에서 다시 계산합니다.</p></div><label className="text-xs font-semibold text-slate-400">조회 범위<select value={sinceMinutes} onChange={(event) => { setSinceMinutes(Number(event.target.value)); setPreview(null); setExecution(null); }} className="mt-2 min-h-11 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white sm:w-44">{WINDOWS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <button type="button" onClick={() => void runPreview()} disabled={working} className="btn-secondary min-h-11 w-full sm:w-auto">{working ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}미리보기 생성</button>
    </section> : null}

    {preview ? <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold text-white">3. 문서별 복구 계획</h2><p className="mt-1 text-xs text-slate-500">자동 복구 가능한 문서만 기본 선택됩니다.</p></div><span className="chip chip-muted">선택 {selected.size} / {preview.candidates.length}</span></div>{preview.candidates.map((candidate) => {
      const selectable = candidate.action === 'rollback' && Boolean(candidate.expectedCurrentRevisionId);
      return <article key={candidate.pageId} className={`border p-4 ${selectable ? 'border-white/10 bg-[#111821]' : 'border-amber-300/25 bg-amber-300/5'}`}><div className="flex items-start gap-3">{selectable ? <input type="checkbox" checked={selected.has(candidate.pageId)} onChange={() => toggle(candidate.pageId)} aria-label={`${candidate.title} 복구 선택`} className="mt-1 size-5" /> : <AlertTriangle className="mt-0.5 size-5 flex-none text-amber-300" />}<div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-white">{candidate.title}</strong>{candidate.routePath ? <Link href={candidate.routePath} target="_blank" className="text-slate-400 hover:text-white" aria-label="문서 열기"><ExternalLink className="size-4" /></Link> : null}<span className={`chip ${selectable ? 'chip-accent' : 'chip-muted'}`}>{selectable ? `${candidate.affectedRevisionIds.length}개 판 복구` : '수동 검토'}</span></div><p className="mt-2 text-sm leading-6 text-slate-400">{selectable ? `r#${candidate.rollbackToRevisionId} 기준판으로 새 복구판을 만듭니다.` : reasonLabel(candidate.skipReason)}</p><p className="mt-2 break-all text-xs text-slate-600">문서 #{candidate.pageId} · 현재판 #{candidate.expectedCurrentRevisionId ?? '-'}</p></div></div></article>;
    })}{preview.candidates.length === 0 ? <p className="border border-dashed border-white/15 p-8 text-center text-sm text-slate-500">선택한 범위에 대상 사용자의 공개 기여가 없습니다.</p> : null}</section> : null}

    {preview ? <form onSubmit={execute} className="space-y-4 border border-red-300/25 bg-red-500/5 p-5"><div><h2 className="font-semibold text-white">4. 명시적으로 확인하고 실행</h2><p className="mt-1 text-sm text-slate-400">페이지별 독립 트랜잭션으로 처리하며, 미리보기 이후 바뀐 문서는 자동으로 건너뜁니다.</p></div>{target?.status !== 'blocked' ? <p className="flex gap-2 border border-amber-300/25 bg-amber-300/5 p-3 text-sm text-amber-100"><AlertTriangle className="size-4 flex-none" />대상 사용자가 차단 상태가 아닙니다. <Link href={`/admin/wiki/users?q=${encodeURIComponent(target?.username ?? '')}`} className="underline">사용자 차단 화면</Link>에서 먼저 차단하세요.</p> : null}<label className="block text-xs font-semibold text-slate-400">운영 사유<textarea value={reason} onChange={(event) => setReason(event.target.value)} required minLength={5} maxLength={1000} rows={4} className="mt-2 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" placeholder="사고 범위와 복구 근거를 5자 이상 기록하세요" /></label><label className="block text-xs font-semibold text-slate-400">대상 사용자명 재입력<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white" placeholder={target?.username ?? ''} autoComplete="off" /></label><button disabled={!canExecute} className="btn-primary min-h-11 w-full sm:w-auto"><Undo2 className="size-4" />선택한 {executable.length}개 문서 복구</button></form> : null}

    {execution ? <section className="space-y-3"><h2 className="font-semibold text-white">실행 결과</h2>{execution.results.map((result) => <article key={result.pageId} className="flex items-start gap-3 border border-white/10 p-4">{result.status === 'rolled_back' ? <CheckCircle2 className="size-5 flex-none text-emerald-300" /> : <AlertTriangle className="size-5 flex-none text-amber-300" />}<div><p className="font-semibold text-white">문서 #{result.pageId} · {statusLabel(result.status)}</p><p className="mt-1 text-sm text-slate-400">{result.reason ? reasonLabel(result.reason) : `새 복구판 #${result.newRevisionId}`}</p></div></article>)}</section> : null}
  </div>;
}

function AdminNav() { return <nav className="flex flex-wrap gap-2"><Link href="/admin/wiki" className="chip chip-muted">최근 변경</Link><Link href="/admin/wiki/pages" className="chip chip-muted">문서</Link><Link href="/admin/wiki/acl" className="chip chip-muted">ACL</Link><Link href="/admin/wiki/users" className="chip chip-muted">사용자 차단</Link><span className="chip chip-accent">일괄 복구</span></nav>; }
function reasonLabel(reason: string | null) { return reason ? REASONS[reason] ?? reason : '수동 검토가 필요합니다.'; }
function statusLabel(status: WikiBatchRollbackExecution['results'][number]['status']) { return status === 'rolled_back' ? '복구 완료' : status === 'skipped' ? '건너뜀' : '실패'; }
function message(error: unknown) { return error instanceof Error ? error.message : '일괄 훼손 복구 요청에 실패했습니다.'; }

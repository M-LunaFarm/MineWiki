'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, Eye, EyeOff, Loader2, RotateCcw } from 'lucide-react';
import {
  fetchWikiAdminPageRevisions,
  fetchWikiAdminRevision,
  rollbackWikiAdminPage,
  updateWikiAdminRevisionEditSummary,
  updateWikiAdminRevisionVisibility,
  type WikiAdminRevisionDetail,
  type WikiAdminRevisionPage,
  type WikiAdminRevisionSummary
} from '../../lib/wiki-api';
import { buildCategoryWikiToolPath, buildServerWikiToolPath, buildStandardWikiToolPath, buildWikiRevisionPath } from '../../lib/wiki-routes.mjs';

export function WikiAdminRevisionList({ pageId }: { readonly pageId: string }) {
  const [data, setData] = useState<WikiAdminRevisionPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchWikiAdminPageRevisions(pageId)
      .then(setData)
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setLoading(false));
  }, [pageId]);

  async function loadMore() {
    if (!data?.nextCursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const next = await fetchWikiAdminPageRevisions(pageId, { cursor: data.nextCursor });
      setData({ ...next, items: [...data.items, ...next.items] });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading) return <Loading />;
  if (!data) return <ErrorNotice message={error ?? '판 목록을 불러오지 못했습니다.'} />;
  const routePath = data.page.routePath;
  return (
    <main className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <header className="rounded-lg border border-white/10 bg-white/[0.03] p-5">
        <Link href="/admin/wiki/pages" className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-emerald-200">
          <ArrowLeft className="h-4 w-4" /> 문서 관리
        </Link>
        <h1 className="mt-4 text-2xl font-semibold text-white">{data.page.displayTitle} 판 관리</h1>
        <p className="mt-2 text-sm text-slate-400">숨긴 판을 포함한 전체 기록입니다. 현재 판을 숨기면 직전 공개 판으로 자동 전환됩니다.</p>
        {routePath ? (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <Link href={routePath} className="btn-secondary min-h-11 w-full sm:w-auto">현재 문서</Link>
            <Link href={historyPath(routePath)} className="btn-secondary min-h-11 w-full sm:w-auto">공개 역사</Link>
          </div>
        ) : null}
      </header>
      {error ? <ErrorNotice message={error} /> : null}
      <section className="grid gap-3 md:hidden">
        {data.items.map((revision) => <RevisionCard key={revision.id} revision={revision} routePath={routePath} />)}
      </section>
      <section className="hidden overflow-x-auto rounded-lg border border-white/10 bg-[#111821] md:block">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-white/10 text-xs uppercase text-slate-500"><tr>
            <th className="px-4 py-3">판</th><th className="px-4 py-3">상태</th><th className="px-4 py-3">편집자</th><th className="px-4 py-3">요약</th><th className="px-4 py-3">시간</th>
          </tr></thead>
          <tbody className="divide-y divide-white/10 text-slate-300">
            {data.items.map((revision) => (
              <tr key={revision.id}>
                <td className="px-4 py-3"><Link className="font-semibold text-emerald-200 hover:text-emerald-100" href={adminRevisionHref(revision.id, routePath)}>r{revision.revisionNo}</Link>{revision.isCurrent ? <span className="ml-2 chip chip-accent">현재</span> : null}</td>
                <td className="px-4 py-3"><div className="flex flex-wrap gap-2"><Visibility value={revision.visibility} /><SummaryVisibility hidden={revision.editSummaryHidden} /></div></td>
                <td className="px-4 py-3">{revision.createdByName}</td>
                <td className="max-w-sm truncate px-4 py-3">{revision.editSummary || '요약 없음'}</td>
                <td className="whitespace-nowrap px-4 py-3">{formatDate(revision.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {data.items.length === 0 ? <p className="rounded-lg border border-white/10 p-6 text-center text-slate-400">저장된 판이 없습니다.</p> : null}
      {data.nextCursor ? <button type="button" disabled={loadingMore} onClick={() => void loadMore()} className="btn-secondary min-h-11 w-full">{loadingMore ? '불러오는 중…' : '이전 판 더 보기'}</button> : null}
    </main>
  );
}

export function WikiAdminRevisionDetailConsole({ revisionId }: { readonly revisionId: string }) {
  const [revision, setRevision] = useState<WikiAdminRevisionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [summaryReason, setSummaryReason] = useState('');
  const [summaryConfirmed, setSummaryConfirmed] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [working, setWorking] = useState<'visibility' | 'summary' | 'rollback' | null>(null);

  const load = useCallback(async () => {
    setRevision(await fetchWikiAdminRevision(revisionId));
  }, [revisionId]);
  useEffect(() => { void load().catch((cause) => setError(errorMessage(cause))); }, [load]);
  if (!revision) return error ? <ErrorNotice message={error} /> : <Loading />;
  const routePath = revision.page.routePath;
  const requiredConfirmation = `r${revision.revisionNo}`;
  const reasonValid = reason.trim().length >= 5;
  const summaryReasonValid = summaryReason.trim().length >= 5 && summaryReason.trim().length <= 500;

  async function changeVisibility() {
    if (!reasonValid) return;
    setWorking('visibility'); setError(null);
    try {
      await updateWikiAdminRevisionVisibility({ revisionId, visibility: revision.visibility === 'public' ? 'hidden' : 'public', reason: reason.trim() });
      await load(); setReason('');
    } catch (cause) { setError(errorMessage(cause)); } finally { setWorking(null); }
  }
  async function changeEditSummaryVisibility() {
    if (!summaryReasonValid || !summaryConfirmed) return;
    setWorking('summary'); setError(null);
    try {
      await updateWikiAdminRevisionEditSummary({
        revisionId,
        hidden: !revision.editSummaryHidden,
        expectedVersion: revision.editSummaryModerationVersion,
        reason: summaryReason.trim()
      });
      await load(); setSummaryReason(''); setSummaryConfirmed(false);
    } catch (cause) { setError(errorMessage(cause)); } finally { setWorking(null); }
  }
  async function rollback() {
    if (!reasonValid || confirmText !== requiredConfirmation) return;
    setWorking('rollback'); setError(null);
    try {
      const result = await rollbackWikiAdminPage({ pageId: revision.pageId, revisionId, reason: reason.trim() });
      window.location.assign(adminRevisionHref(result.revisionId, routePath));
    } catch (cause) { setError(errorMessage(cause)); setWorking(null); }
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <header className="rounded-lg border border-white/10 bg-white/[0.03] p-5">
        <Link href={adminPageRevisionsHref(revision.pageId, routePath)} className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-emerald-200"><ArrowLeft className="h-4 w-4" /> 판 목록</Link>
        <div className="mt-4 flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold text-white">{revision.page.displayTitle} r{revision.revisionNo}</h1>{revision.isCurrent ? <span className="chip chip-accent">현재</span> : null}<Visibility value={revision.visibility} /><SummaryVisibility hidden={revision.editSummaryHidden} /></div>
        <p className="mt-2 text-sm text-slate-400">{revision.createdByName} · {formatDate(revision.createdAt)} · {formatBytes(revision.contentSize)}</p>
        <p className="mt-1 text-sm text-slate-300"><span className="font-semibold text-slate-200">원본 편집 요약 (관리자 전용):</span> {revision.editSummary || '편집 요약 없음'}</p>
        {routePath ? <div className="mt-4 flex flex-col gap-2 sm:flex-row">{revision.visibility === 'public' ? <Link href={buildWikiRevisionPath(revision.id, routePath)} className="btn-secondary min-h-11 w-full sm:w-auto">공개 판 화면</Link> : null}<Link href={routePath} className="btn-secondary min-h-11 w-full sm:w-auto">현재 문서</Link></div> : null}
      </header>
      {error ? <ErrorNotice message={error} /> : null}
      <section className="rounded-lg border border-amber-300/20 bg-amber-500/[0.05] p-5" aria-labelledby="edit-summary-moderation-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="edit-summary-moderation-title" className="text-lg font-semibold text-white">편집 요약 공개 설정</h2>
            <p id="edit-summary-moderation-help" className="mt-1 text-sm text-slate-400">판 내용과 공개 상태는 그대로 두고 편집 요약만 숨기거나 복원합니다. 사유는 5~500자로 감사 기록에 보존됩니다.</p>
          </div>
          <SummaryVisibility hidden={revision.editSummaryHidden} />
        </div>
        {revision.editSummaryModeration ? (
          <dl className="mt-4 grid gap-2 rounded-md border border-white/10 bg-black/10 p-3 text-sm sm:grid-cols-[9rem_1fr]">
            <dt className="text-slate-500">마지막 조치</dt><dd className="text-slate-200">{revision.editSummaryModeration.action === 'hidden' ? '요약 숨김' : '요약 복원'}</dd>
            <dt className="text-slate-500">처리자</dt><dd className="text-slate-200">{revision.editSummaryModeration.moderatorName} (#{revision.editSummaryModeration.moderatorProfileId})</dd>
            <dt className="text-slate-500">처리 시각</dt><dd className="text-slate-200">{formatDate(revision.editSummaryModeration.moderatedAt)}</dd>
            <dt className="text-slate-500">사유</dt><dd className="break-words text-slate-200">{revision.editSummaryModeration.reason}</dd>
          </dl>
        ) : null}
        <label htmlFor="edit-summary-moderation-reason" className="mt-4 block text-sm font-semibold text-slate-200">요약 공개 설정 사유</label>
        <textarea id="edit-summary-moderation-reason" value={summaryReason} onChange={(event) => setSummaryReason(event.target.value)} maxLength={500} rows={3} aria-describedby="edit-summary-moderation-help" className="mt-2 w-full rounded-md border border-white/10 bg-[#0d131b] p-3 font-normal text-white outline-none focus:border-emerald-300/50" />
        <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-white/10 bg-black/10 px-3 text-sm text-slate-200">
          <input type="checkbox" checked={summaryConfirmed} onChange={(event) => setSummaryConfirmed(event.target.checked)} className="size-4 accent-emerald-400" />
          r{revision.revisionNo}의 편집 요약만 {revision.editSummaryHidden ? '복원' : '숨김'} 처리함을 확인합니다.
        </label>
        <button type="button" disabled={!summaryReasonValid || !summaryConfirmed || working !== null} onClick={() => void changeEditSummaryVisibility()} aria-describedby="edit-summary-moderation-help" className="btn-secondary mt-3 min-h-11 w-full sm:w-auto">
          {working === 'summary' ? <Loader2 className="h-4 w-4 animate-spin" /> : revision.editSummaryHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          {revision.editSummaryHidden ? '편집 요약 복원' : '편집 요약 숨김'}
        </button>
      </section>
      <section className="rounded-lg border border-white/10 bg-[#111821] p-4"><h2 className="mb-3 text-sm font-semibold text-white">원문</h2><pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">{revision.contentRaw}</pre></section>
      <section className="rounded-lg border border-amber-300/20 bg-amber-500/[0.05] p-5">
        <h2 className="text-lg font-semibold text-white">관리 작업</h2>
        <p className="mt-1 text-sm text-slate-400">감사 기록에 남을 사유를 5자 이상 입력하세요. 같은 사유가 숨김과 롤백에 사용됩니다.</p>
        <label className="mt-4 block text-sm font-semibold text-slate-200">사유<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={3} className="mt-2 w-full rounded-md border border-white/10 bg-[#0d131b] p-3 font-normal text-white outline-none focus:border-emerald-300/50" /></label>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <button type="button" disabled={!reasonValid || working !== null} onClick={() => void changeVisibility()} className="btn-secondary min-h-11 w-full">{working === 'visibility' ? <Loader2 className="h-4 w-4 animate-spin" /> : revision.visibility === 'public' ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}{revision.visibility === 'public' ? '이 판 숨기기' : '공개로 복원'}</button>
          <div className="rounded-md border border-red-300/20 bg-red-500/[0.06] p-3">
            <label className="text-sm font-semibold text-red-100">롤백 확인<input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} placeholder={`${requiredConfirmation} 입력`} className="mt-2 h-11 w-full rounded-md border border-white/10 bg-[#0d131b] px-3 font-normal text-white outline-none focus:border-red-300/50" /></label>
            {revision.visibility !== 'public' ? <p className="mt-2 text-xs text-red-100">숨긴 판은 공개로 복원한 뒤 롤백할 수 있습니다.</p> : null}
            <button type="button" disabled={revision.visibility !== 'public' || !reasonValid || confirmText !== requiredConfirmation || working !== null} onClick={() => void rollback()} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-red-500 px-4 text-sm font-semibold text-white disabled:opacity-40"><RotateCcw className="h-4 w-4" />{working === 'rollback' ? '롤백 중…' : `${requiredConfirmation} 내용으로 롤백`}</button>
          </div>
        </div>
      </section>
    </main>
  );
}

function RevisionCard({ revision, routePath }: { revision: WikiAdminRevisionSummary; routePath?: string }) {
  return <Link href={adminRevisionHref(revision.id, routePath)} className="rounded-lg border border-white/10 bg-[#111821] p-4"><div className="flex items-center justify-between gap-3"><span className="font-semibold text-emerald-200">r{revision.revisionNo}</span><div className="flex flex-wrap gap-2">{revision.isCurrent ? <span className="chip chip-accent">현재</span> : null}<Visibility value={revision.visibility} /><SummaryVisibility hidden={revision.editSummaryHidden} /></div></div><p className="mt-3 line-clamp-2 text-sm text-slate-200">{revision.editSummary || '요약 없음'}</p><p className="mt-2 text-xs text-slate-500">{revision.createdByName} · {formatDate(revision.createdAt)} · {formatBytes(revision.contentSize)}</p></Link>;
}
function Visibility({ value }: { value: string }) { return <span className={value === 'public' ? 'chip chip-muted' : 'chip border-red-300/30 bg-red-500/10 text-red-100'}>{value}</span>; }
function SummaryVisibility({ hidden }: { hidden: boolean }) { return <span className={hidden ? 'chip border-amber-300/30 bg-amber-500/10 text-amber-100' : 'chip chip-muted'}>{hidden ? '편집 요약 숨김' : '편집 요약 공개'}</span>; }
function Loading() { return <div className="flex min-h-[40vh] items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-emerald-300" /></div>; }
function ErrorNotice({ message }: { message: string }) { return <div className="mx-auto flex max-w-5xl gap-3 rounded-lg border border-red-300/30 bg-red-500/10 p-4 text-sm text-red-100"><AlertTriangle className="h-4 w-4 flex-none" /><p>{message}</p></div>; }
function adminPageRevisionsHref(pageId: string, routePath?: string) { const base = `/admin/wiki/pages/${encodeURIComponent(pageId)}/revisions`; return routePath ? `${base}?returnTo=${encodeURIComponent(routePath)}` : base; }
function adminRevisionHref(revisionId: string, routePath?: string) { const base = `/admin/wiki/revisions/${encodeURIComponent(revisionId)}`; return routePath ? `${base}?returnTo=${encodeURIComponent(routePath)}` : base; }
function historyPath(routePath: string) { if (routePath.startsWith('/server/')) return buildServerWikiToolPath(routePath, 'history'); if (routePath.startsWith('/wiki/category/')) return buildCategoryWikiToolPath(routePath, 'history'); return buildStandardWikiToolPath(routePath, 'history'); }
function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : '판 관리 작업을 완료하지 못했습니다.'; }
function formatBytes(value: number) { return new Intl.NumberFormat('ko-KR').format(value) + ' bytes'; }
function formatDate(value: string) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)); }

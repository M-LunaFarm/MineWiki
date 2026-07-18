'use client';

import { ArrowLeft, CheckCircle2, ClipboardCheck, FilePenLine, Loader2, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { csrfHeaders } from '../../lib/csrf';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import { MfaStepUpDialog } from '../auth/mfa-step-up-dialog';

type CandidateKind = 'added' | 'updated' | 'moved' | 'removed' | 'unchanged';

interface QueueItem {
  readonly candidateId: string;
  readonly candidateToken: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly siteSlug: string | null;
  readonly submittedAt: string;
  readonly submissionReason: string;
  readonly counts: Readonly<Record<CandidateKind, number>>;
  readonly requiredApprovals: number;
}

interface CandidatePage {
  readonly pageId: string;
  readonly kind: CandidateKind;
  readonly contentChanged: boolean;
  readonly metadataChanged: boolean;
  readonly diffPath: string | null;
  readonly previewPath: null;
  readonly before: CandidateIdentity | null;
  readonly after: CandidateIdentity | null;
}

interface CandidateIdentity {
  readonly revisionId: string;
  readonly displayTitle: string;
  readonly title: string;
  readonly localPath: string;
  readonly routePath: string;
}

interface ReviewDetail extends QueueItem {
  readonly manifest: {
    readonly totalPageCount: number;
    readonly presentation: {
      readonly navigationChanged: boolean;
      readonly contentSettingsChanged: boolean;
      readonly layoutChanged: boolean;
      readonly linkGraphChanged: boolean;
    };
  };
  readonly review: {
    readonly approved: boolean;
    readonly reviewerAvailable: boolean;
    readonly canApprove: boolean;
    readonly viewerApproved: boolean;
    readonly approvals: readonly { readonly reviewerProfileId: string; readonly approvedAt: string }[];
  };
}

export function ServerWikiReleaseReviewQueueClient() {
  const baseUrl = normalizeApiBaseUrl();
  const [items, setItems] = useState<readonly QueueItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(nextCursor?: string, append = false) {
    append ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: '20' });
      if (nextCursor) query.set('cursor', nextCursor);
      const response = await fetch(`${baseUrl}/v1/wiki/release-reviews?${query.toString()}`, {
        credentials: 'include', cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? '릴리스 검토 큐를 불러오지 못했습니다.');
      const page = body as { readonly items: readonly QueueItem[]; readonly nextCursor: string | null };
      setItems((current) => append ? [...current, ...page.items] : page.items);
      setCursor(page.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '릴리스 검토 큐를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  useEffect(() => { void load(); }, [baseUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <LoadingCard label="릴리스 검토 큐 불러오는 중" />;
  if (error) return <ErrorCard message={error} onRetry={() => void load()} />;
  if (items.length === 0) return <section className="surface-flat p-8 text-center"><ShieldCheck className="mx-auto size-9 text-emerald-300" /><h2 className="mt-4 font-semibold text-white">대기 중인 릴리스 검토가 없습니다</h2><p className="mt-2 text-sm text-slate-400">reviewer 역할이 있는 서버에서 새 후보가 제출되면 여기에 표시됩니다.</p></section>;

  return <div className="space-y-4">
    <ul className="grid gap-4">
      {items.map((item) => <li key={item.candidateId}><Link href={`/wiki/release-reviews/${item.candidateId}`} className="surface-flat block p-5 transition hover:border-emerald-300/30">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0"><p className="flex items-center gap-2 text-xs font-semibold text-emerald-300"><Server className="size-4" />{item.serverName}</p><h2 className="mt-2 truncate text-lg font-bold text-white">릴리스 후보 #{item.candidateId}</h2><p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-400">{item.submissionReason}</p></div>
          <span className="shrink-0 text-xs text-slate-500">{new Date(item.submittedAt).toLocaleString('ko-KR')}</span>
        </div>
        <CandidateCounts counts={item.counts} />
      </Link></li>)}
    </ul>
    {cursor ? <button type="button" disabled={loadingMore} onClick={() => void load(cursor, true)} className="btn-secondary min-h-11 w-full">{loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}더 불러오기</button> : null}
  </div>;
}

export function ServerWikiReleaseReviewDetailClient({ candidateId }: { readonly candidateId: string }) {
  const baseUrl = normalizeApiBaseUrl();
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<boolean | null>(null);
  const [pages, setPages] = useState<readonly CandidatePage[]>([]);
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [pageFilter, setPageFilter] = useState<PageFilter>('changed');
  const [pageLoading, setPageLoading] = useState(true);
  const [pageLoadingMore, setPageLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`${baseUrl}/v1/wiki/release-reviews/${encodeURIComponent(candidateId)}`, { credentials: 'include', cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? '릴리스 후보를 불러오지 못했습니다.');
      setDetail(body as ReviewDetail);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '릴리스 후보를 불러오지 못했습니다.');
    } finally { setLoading(false); }
  }

  async function loadPages(filter: PageFilter, nextCursor?: string, append = false) {
    append ? setPageLoadingMore(true) : setPageLoading(true);
    setPageError(null);
    try {
      const query = new URLSearchParams({ kinds: filterKinds(filter), limit: '50' });
      if (nextCursor) query.set('cursor', nextCursor);
      const response = await fetch(`${baseUrl}/v1/wiki/release-reviews/${encodeURIComponent(candidateId)}/pages?${query.toString()}`, {
        credentials: 'include', cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const failure = new Error(body.message ?? '릴리스 후보 문서를 불러오지 못했습니다.');
        if (response.status === 404) {
          setDetail(null);
          setError(failure.message);
        }
        throw failure;
      }
      const result = body as { readonly items: readonly CandidatePage[]; readonly nextCursor: string | null };
      setPages((current) => append ? [...current, ...result.items] : result.items);
      setPageCursor(result.nextCursor);
    } catch (caught) {
      setPageError(caught instanceof Error ? caught.message : '릴리스 후보 문서를 불러오지 못했습니다.');
    } finally {
      setPageLoading(false);
      setPageLoadingMore(false);
    }
  }

  useEffect(() => {
    setDetail(null); setPages([]); setPageCursor(null); setPageFilter('changed'); setPageError(null);
    void load();
    void loadPages('changed');
  }, [baseUrl, candidateId]); // eslint-disable-line react-hooks/exhaustive-deps

  function selectFilter(filter: PageFilter) {
    if (filter === pageFilter || pageLoading) return;
    setPageFilter(filter); setPages([]); setPageCursor(null);
    void loadPages(filter);
  }

  async function changeApproval(approve: boolean) {
    if (!detail || saving) return;
    setSaving(true); setError(null); setMessage(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${encodeURIComponent(detail.serverId)}/wiki-publication/approval`, {
        method: approve ? 'POST' : 'DELETE', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({ candidateId: detail.candidateId, candidateToken: detail.candidateToken }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const failure = new Error(body.message ?? '승인 상태를 변경하지 못했습니다.');
        if (response.status === 404) setDetail(null);
        throw failure;
      }
      setDetail((current) => current ? { ...current, review: body as ReviewDetail['review'] } : current);
      setMessage(approve ? '이 릴리스 후보를 승인했습니다.' : '내 승인을 취소했습니다.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '승인 상태를 변경하지 못했습니다.');
    } finally { setSaving(false); }
  }

  if (loading) return <LoadingCard label="릴리스 후보 불러오는 중" />;
  if (error && !detail) return <ErrorCard message={error} onRetry={() => void load()} />;
  if (!detail) return null;
  return <div className="space-y-5">
    <Link href="/wiki/release-reviews" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-slate-300 hover:text-white"><ArrowLeft className="size-4" />릴리스 검토 큐</Link>
    <section className="surface-flat overflow-hidden">
      <header className="border-b border-white/10 p-5"><p className="text-xs font-semibold text-emerald-300">{detail.serverName}</p><h1 className="mt-2 text-2xl font-bold text-white">릴리스 후보 #{detail.candidateId}</h1><p className="mt-3 text-sm leading-6 text-slate-400">{detail.submissionReason}</p><CandidateCounts counts={detail.counts} /></header>
      <div className="flex flex-col gap-3 border-b border-white/10 p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold text-white">독립 검토 {detail.review.approved ? '승인 완료' : '대기 중'}</p><p className="mt-1 text-xs text-slate-400">승인은 이 후보 ID와 저장된 manifest에만 적용됩니다.</p></div><button type="button" disabled={saving || !detail.review.canApprove} onClick={() => setPendingApproval(!detail.review.viewerApproved)} className="btn-primary min-h-11">{saving ? <Loader2 className="size-4 animate-spin" /> : <ClipboardCheck className="size-4" />}{detail.review.viewerApproved ? '내 승인 취소' : '후보 승인'}</button></div>
      {message ? <p className="border-b border-white/10 px-5 py-3 text-sm text-emerald-200" role="status">{message}</p> : null}
      {error ? <p className="border-b border-white/10 px-5 py-3 text-sm text-red-200" role="alert">{error}</p> : null}
      <div className="flex flex-wrap gap-2 border-b border-white/10 p-5" aria-label="문서 변경 종류 필터">
        {pageFilters.map((filter) => <button key={filter} type="button" aria-pressed={pageFilter === filter} disabled={pageLoading} onClick={() => selectFilter(filter)} className={pageFilter === filter ? 'chip chip-accent' : 'chip chip-muted'}>{filterLabel(filter)}</button>)}
      </div>
      {pageLoading ? <div className="grid min-h-32 place-items-center"><Loader2 className="size-5 animate-spin text-emerald-300" aria-label="후보 문서 불러오는 중" /></div> : null}
      {!pageLoading && pageError ? <div className="p-5 text-sm text-red-200" role="alert"><p>{pageError}</p><button type="button" onClick={() => void loadPages(pageFilter)} className="btn-secondary mt-3 min-h-11"><RefreshCw className="size-4" />문서 다시 시도</button></div> : null}
      {!pageLoading && !pageError ? <ul className="divide-y divide-white/10">
        {pages.map((page) => { const identity = page.after ?? page.before; return <li key={page.pageId} className="p-5"><div className="flex items-start justify-between gap-4"><div className="min-w-0"><p className="flex items-center gap-2 font-semibold text-white"><FilePenLine className="size-4 shrink-0 text-sky-300" />{identity?.displayTitle ?? identity?.title ?? `문서 ${page.pageId}`}</p><p className="mt-1 break-all text-xs text-slate-500">{page.before && page.after && page.before.localPath !== page.after.localPath ? `${page.before.localPath} → ${page.after.localPath}` : identity?.localPath}</p></div><span className="shrink-0 text-xs font-semibold text-slate-400">{kindLabel(page.kind)}</span></div>{page.diffPath ? <Link href={page.diffPath} className="mt-3 inline-flex min-h-11 items-center text-xs font-semibold text-emerald-300">본문 변경 비교</Link> : null}</li>; })}
      </ul> : null}
      {!pageLoading && !pageError && pages.length === 0 ? <p className="p-6 text-sm text-slate-400"><CheckCircle2 className="mr-2 inline size-4" />이 필터에 해당하는 문서가 없습니다.</p> : null}
      {!pageLoading && !pageError && pageCursor ? <div className="border-t border-white/10 p-5"><button type="button" disabled={pageLoadingMore} onClick={() => void loadPages(pageFilter, pageCursor, true)} className="btn-secondary min-h-11 w-full">{pageLoadingMore ? <Loader2 className="size-4 animate-spin" /> : null}문서 더 불러오기</button></div> : null}
    </section>
    <MfaStepUpDialog open={pendingApproval !== null} purpose="wiki_release_review" onClose={() => setPendingApproval(null)} onSuccess={async () => { const approve = pendingApproval; setPendingApproval(null); if (approve !== null) await changeApproval(approve); }} />
  </div>;
}

function CandidateCounts({ counts }: { readonly counts: QueueItem['counts'] }) {
  return <div className="mt-4 grid grid-cols-4 gap-2">{(['added', 'updated', 'moved', 'removed'] as const).map((kind) => <div key={kind} className="rounded-lg bg-white/[0.03] p-2 text-center"><p className="font-bold text-white">{counts[kind].toLocaleString('ko-KR')}</p><p className="text-[10px] text-slate-500">{kindLabel(kind)}</p></div>)}</div>;
}

function kindLabel(kind: CandidateKind) { return ({ added: '추가', updated: '수정', moved: '이동', removed: '삭제', unchanged: '동일' } as const)[kind]; }
type PageFilter = 'changed' | CandidateKind;
const pageFilters: readonly PageFilter[] = ['changed', 'added', 'updated', 'moved', 'removed', 'unchanged'];
function filterKinds(filter: PageFilter) { return filter === 'changed' ? 'added,updated,moved,removed' : filter; }
function filterLabel(filter: PageFilter) { return filter === 'changed' ? '변경 전체' : kindLabel(filter); }
function LoadingCard({ label }: { readonly label: string }) { return <section className="surface-flat grid min-h-40 place-items-center"><Loader2 className="size-6 animate-spin text-emerald-300" aria-label={label} /></section>; }
function ErrorCard({ message, onRetry }: { readonly message: string; readonly onRetry: () => void }) { return <section className="surface-flat p-6 text-sm text-red-200" role="alert"><p>{message}</p><button type="button" onClick={onRetry} className="btn-secondary mt-4 min-h-11"><RefreshCw className="size-4" />다시 시도</button></section>; }

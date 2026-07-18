'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { fetchWikiPageLifecycleEvents, fetchWikiRevisions, type WikiPageLifecycleEventListResponse, type WikiRevisionListResponse } from '../../lib/wiki-api';
import { buildWikiDiffPath, buildWikiRevisionPath } from '../../lib/wiki-routes.mjs';
import { WikiRevertButton } from './wiki-revert-button';
import { WikiReportButton } from './wiki-report-button';
import { WikiEditSummary } from './wiki-edit-summary';

type Revision = WikiRevisionListResponse['items'][number];
type LifecycleEvent = WikiPageLifecycleEventListResponse['items'][number];
type SelectionKind = 'older' | 'newer';

export function WikiHistoryListClient({ pageId, currentRevisionId, routePath, initial, initialLifecycle }: {
  readonly pageId: string;
  readonly currentRevisionId: string;
  readonly routePath: string;
  readonly initial: WikiRevisionListResponse;
  readonly initialLifecycle: WikiPageLifecycleEventListResponse;
}) {
  const [revisions, setRevisions] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lifecycleEvents, setLifecycleEvents] = useState(initialLifecycle.items);
  const [lifecycleCursor, setLifecycleCursor] = useState(initialLifecycle.nextCursor);
  const [lifecycleLoading, setLifecycleLoading] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [olderId, setOlderId] = useState(initial.items[1]?.id ?? null);
  const [newerId, setNewerId] = useState(initial.items[0]?.id ?? null);
  const older = revisions.find((revision) => revision.id === olderId) ?? null;
  const newer = revisions.find((revision) => revision.id === newerId) ?? null;
  const canCompare = Boolean(older && newer && older.revisionNo < newer.revisionNo);

  function select(kind: SelectionKind, revision: Revision) {
    if (kind === 'older') {
      setOlderId(revision.id);
      if (newer && revision.revisionNo >= newer.revisionNo) setNewerId(null);
    } else {
      setNewerId(revision.id);
      if (older && revision.revisionNo <= older.revisionNo) setOlderId(null);
    }
  }

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetchWikiRevisions(pageId, cursor);
      setRevisions((current) => [...current, ...response.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setCursor(response.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '이전 기록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  async function loadMoreLifecycle() {
    if (!lifecycleCursor) return;
    setLifecycleLoading(true);
    setLifecycleError(null);
    try {
      const response = await fetchWikiPageLifecycleEvents(pageId, lifecycleCursor);
      setLifecycleEvents((current) => [...current, ...response.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setLifecycleCursor(response.nextCursor);
    } catch (caught) {
      setLifecycleError(caught instanceof Error ? caught.message : '이전 수명주기 기록을 불러오지 못했습니다.');
    } finally {
      setLifecycleLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      {lifecycleEvents.length > 0 ? (
        <section className="space-y-3" aria-labelledby="wiki-lifecycle-heading">
          <div>
            <h2 id="wiki-lifecycle-heading" className="text-lg font-semibold text-white">문서 수명주기</h2>
            <p className="mt-1 text-sm text-slate-400">이동·삭제·복구 기록입니다. 내용 판 비교와 되돌리기는 아래 판 목록에서만 할 수 있습니다.</p>
          </div>
          {lifecycleError ? <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{lifecycleError}</p> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {lifecycleEvents.map((event) => <LifecycleCard key={event.id} event={event} />)}
          </div>
          {lifecycleCursor ? <button type="button" disabled={lifecycleLoading} onClick={() => void loadMoreLifecycle()} className="btn-secondary min-h-11 w-full sm:w-auto">{lifecycleLoading ? <Loader2 className="size-4 animate-spin" /> : null} 이전 수명주기 더 보기</button> : null}
        </section>
      ) : null}
      <section className="surface-flat flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between" aria-label="판 비교 선택">
        <div>
          <h2 className="font-semibold text-white">두 판 비교</h2>
          <p className="mt-1 text-sm text-slate-400">
            {older ? `rev ${older.revisionNo}` : '이전 판 선택'} <ArrowRight className="mx-1 inline size-4" aria-hidden="true" /> {newer ? `rev ${newer.revisionNo}` : '새 판 선택'}
          </p>
          {!canCompare && (older || newer) ? <p className="mt-1 text-xs text-amber-200">이전 판보다 번호가 큰 새 판을 선택해 주세요.</p> : null}
        </div>
        {canCompare && older && newer ? (
          <Link href={buildWikiDiffPath(older.id, newer.id, routePath)} className="btn-primary min-h-11 w-full sm:w-auto">선택한 두 판 비교</Link>
        ) : (
          <button type="button" disabled className="btn-primary min-h-11 w-full opacity-50 sm:w-auto">선택한 두 판 비교</button>
        )}
      </section>
      {error ? <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{error}</p> : null}
      <section className="space-y-3 sm:hidden">
        {revisions.map((revision, index) => (
          <HistoryCard key={revision.id} revision={revision} previous={revisions[index + 1]} pageId={pageId} currentRevisionId={currentRevisionId} routePath={routePath} olderId={olderId} newerId={newerId} onSelect={select} />
        ))}
      </section>
      <section className="hidden overflow-x-auto border border-white/10 bg-[#111821] sm:block">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-white/10 text-xs uppercase text-slate-500"><tr><th className="px-3 py-3 text-center">이전</th><th className="px-3 py-3 text-center">새 판</th><th className="px-4 py-3">판</th><th className="px-4 py-3">요약</th><th className="px-4 py-3">편집자</th><th className="px-4 py-3">시간</th><th className="px-4 py-3">작업</th></tr></thead>
          <tbody className="divide-y divide-white/10 text-slate-300">
            {revisions.map((revision, index) => (
              <tr key={revision.id}>
                <td className="px-3 py-2"><RevisionChoice revision={revision} kind="older" selected={olderId === revision.id} onSelect={select} suffix="desktop" /></td>
                <td className="px-3 py-2"><RevisionChoice revision={revision} kind="newer" selected={newerId === revision.id} onSelect={select} suffix="desktop" /></td>
                <td className="px-4 py-3 font-semibold text-white">rev {revision.revisionNo}<SizeDelta revision={revision} /></td>
                <td className="px-4 py-3">{revision.isMinor ? <span className="chip chip-muted mr-2">minor</span> : null}<WikiEditSummary summary={revision.editSummary} hidden={revision.editSummaryHidden} /></td>
                <td className="px-4 py-3"><Editor revision={revision} /></td>
                <td className="px-4 py-3">{formatDate(revision.createdAt)}</td>
                <td className="px-4 py-3"><Actions revision={revision} previous={revisions[index + 1]} pageId={pageId} currentRevisionId={currentRevisionId} routePath={routePath} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {cursor ? <button type="button" disabled={loading} onClick={() => void loadMore()} className="btn-secondary min-h-11 w-full sm:w-auto">{loading ? <Loader2 className="size-4 animate-spin" /> : null} 이전 기록 더 보기</button> : null}
    </div>
  );
}

function LifecycleCard({ event }: { event: LifecycleEvent }) {
  const label = event.eventType === 'move' ? '문서 이동' : event.eventType === 'delete' ? '문서 삭제' : '문서 복구';
  return <article className="border border-white/10 bg-[#111821] p-4"><div className="flex items-center justify-between gap-3"><strong className="text-white">{label}</strong><time className="text-xs text-slate-500">{formatDate(event.createdAt)}</time></div>{event.eventType === 'move' ? <p className="mt-3 break-words text-sm text-slate-300"><LifecycleIdentity identity={event.source} fallback="비공개 경로" /> <ArrowRight className="mx-1 inline size-4" aria-hidden="true" /> <LifecycleIdentity identity={event.destination} fallback="비공개 경로" /></p> : <p className="mt-3 break-words text-sm text-slate-300"><LifecycleIdentity identity={event.source ?? event.destination} fallback="문서 경로 비공개" /></p>}{event.identityRedacted ? <p className="mt-2 text-xs text-amber-200">접근 권한이 없는 이전 경로 정보는 숨겼습니다.</p> : null}{event.reason ? <p className="mt-2 break-words text-sm text-slate-400">사유: {event.reason}</p> : null}<p className="mt-3 text-xs text-slate-500">처리자 <LifecycleActor event={event} /></p></article>;
}

function LifecycleIdentity({ identity, fallback }: { identity: LifecycleEvent['source']; fallback: string }) {
  return identity ? <>{identity.namespace}:{identity.title}</> : <>{fallback}</>;
}

function LifecycleActor({ event }: { event: LifecycleEvent }) {
  if (!event.actorProfileId) return <>unknown</>;
  return <Link href={event.actorUsername ? `/user/${encodeURIComponent(event.actorUsername)}` : `/wiki/contributions/${event.actorProfileId}`} className="hover:text-emerald-200">{event.actorName ?? event.actorProfileId}</Link>;
}

function HistoryCard({ revision, previous, pageId, currentRevisionId, routePath, olderId, newerId, onSelect }: { revision: Revision; previous?: Revision; pageId: string; currentRevisionId: string; routePath: string; olderId: string | null; newerId: string | null; onSelect: (kind: SelectionKind, revision: Revision) => void }) {
  return <article className="border border-white/10 bg-[#111821] p-4"><div className="flex items-center justify-between gap-3"><strong className="text-white">rev {revision.revisionNo}</strong><time className="text-xs text-slate-500">{formatDate(revision.createdAt)}</time></div><SizeDelta revision={revision} /><fieldset className="mt-3 flex gap-4"><legend className="sr-only">rev {revision.revisionNo} 비교 위치</legend><RevisionChoice revision={revision} kind="older" selected={olderId === revision.id} onSelect={onSelect} suffix="mobile" /><RevisionChoice revision={revision} kind="newer" selected={newerId === revision.id} onSelect={onSelect} suffix="mobile" /></fieldset><p className="mt-3 break-words text-sm text-slate-300"><WikiEditSummary summary={revision.editSummary} hidden={revision.editSummaryHidden} /></p><p className="mt-2 text-xs text-slate-500">편집자 <Editor revision={revision} />{revision.isMinor ? ' · minor' : ''}</p><div className="mt-4"><Actions revision={revision} previous={previous} pageId={pageId} currentRevisionId={currentRevisionId} routePath={routePath} /></div></article>;
}

function RevisionChoice({ revision, kind, selected, onSelect, suffix }: { revision: Revision; kind: SelectionKind; selected: boolean; onSelect: (kind: SelectionKind, revision: Revision) => void; suffix: string }) {
  const label = kind === 'older' ? '이전 판' : '새 판';
  const id = `${kind}-${revision.id}-${suffix}`;
  return <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center justify-center gap-2 text-xs text-slate-400"><input id={id} type="radio" name={`${kind}-${suffix}`} checked={selected} onChange={() => onSelect(kind, revision)} className="size-4 accent-emerald-400" /><span className={suffix === 'desktop' ? 'sr-only' : ''}>{label}</span></label>;
}

function SizeDelta({ revision }: { revision: Revision }) {
  const delta = revision.sizeDelta;
  if (delta === null) return <span className="mt-1 block text-xs text-slate-500">{formatBytes(revision.contentSize)}</span>;
  return <span className={`mt-1 block text-xs ${delta > 0 ? 'text-emerald-300' : delta < 0 ? 'text-red-300' : 'text-slate-500'}`}>{formatBytes(revision.contentSize)} · {delta > 0 ? '+' : ''}{delta} B</span>;
}

function Editor({ revision }: { revision: Revision }) { return revision.createdBy ? <Link href={revision.createdByUsername ? `/user/${encodeURIComponent(revision.createdByUsername)}` : `/wiki/contributions/${revision.createdBy}`} className="hover:text-emerald-200">{revision.createdByName ?? revision.createdBy}</Link> : <>unknown</>; }
function Actions({ revision, previous, pageId, currentRevisionId, routePath }: { revision: Revision; previous?: Revision; pageId: string; currentRevisionId: string; routePath: string }) { const previousId = previous?.id ?? revision.previousPublicRevisionId; return <div className="flex flex-wrap gap-2"><Link href={buildWikiRevisionPath(revision.id, routePath)} className="chip chip-accent min-h-11 px-3">보기</Link>{previousId ? <Link href={buildWikiDiffPath(previousId, revision.id, routePath)} className="chip chip-muted min-h-11 px-3">이전 판과 비교</Link> : null}<WikiReportButton targetType="revision" targetId={revision.id} returnTo={routePath} />{revision.id !== currentRevisionId ? <WikiRevertButton pageId={pageId} revisionId={revision.id} revisionNo={revision.revisionNo} currentRevisionId={currentRevisionId} routePath={routePath} /> : null}</div>; }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`; }
function formatDate(value: string) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)); }

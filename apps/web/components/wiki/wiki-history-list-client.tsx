'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchWikiRevisions, type WikiRevisionListResponse } from '../../lib/wiki-api';
import { buildWikiDiffPath, buildWikiRevisionPath } from '../../lib/wiki-routes.mjs';
import { WikiRevertButton } from './wiki-revert-button';

export function WikiHistoryListClient({ pageId, currentRevisionId, routePath, initial }: {
  readonly pageId: string; readonly currentRevisionId: string; readonly routePath: string; readonly initial: WikiRevisionListResponse;
}) {
  const [revisions, setRevisions] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function loadMore() {
    if (!cursor) return;
    setLoading(true); setError(null);
    try {
      const response = await fetchWikiRevisions(pageId, cursor);
      setRevisions((current) => [...current, ...response.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setCursor(response.nextCursor);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '이전 기록을 불러오지 못했습니다.'); } finally { setLoading(false); }
  }
  return <div className="space-y-4">
    {error ? <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{error}</p> : null}
    <section className="space-y-3 sm:hidden">{revisions.map((revision, index) => <HistoryCard key={revision.id} revision={revision} previous={revisions[index + 1]} pageId={pageId} currentRevisionId={currentRevisionId} routePath={routePath} />)}</section>
    <section className="hidden overflow-x-auto border border-white/10 bg-[#111821] sm:block"><table className="min-w-full text-left text-sm"><thead className="border-b border-white/10 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">판</th><th className="px-4 py-3">요약</th><th className="px-4 py-3">편집자</th><th className="px-4 py-3">시간</th><th className="px-4 py-3">작업</th></tr></thead><tbody className="divide-y divide-white/10 text-slate-300">{revisions.map((revision, index) => <tr key={revision.id}><td className="px-4 py-3 font-semibold text-white">rev {revision.revisionNo}</td><td className="px-4 py-3">{revision.isMinor ? <span className="chip chip-muted mr-2">minor</span> : null}{revision.editSummary ?? '요약 없음'}</td><td className="px-4 py-3"><Editor revision={revision} /></td><td className="px-4 py-3">{formatDate(revision.createdAt)}</td><td className="px-4 py-3"><Actions revision={revision} previous={revisions[index + 1]} pageId={pageId} currentRevisionId={currentRevisionId} routePath={routePath} /></td></tr>)}</tbody></table></section>
    {cursor ? <button type="button" disabled={loading} onClick={() => void loadMore()} className="btn-secondary min-h-11 w-full sm:w-auto">{loading ? <Loader2 className="size-4 animate-spin" /> : null} 이전 기록 더 보기</button> : null}
  </div>;
}

type Revision = WikiRevisionListResponse['items'][number];
function HistoryCard({ revision, previous, ...props }: { revision: Revision; previous?: Revision; pageId: string; currentRevisionId: string; routePath: string }) { return <article className="border border-white/10 bg-[#111821] p-4"><div className="flex items-center justify-between gap-3"><strong className="text-white">rev {revision.revisionNo}</strong><time className="text-xs text-slate-500">{formatDate(revision.createdAt)}</time></div><p className="mt-3 break-words text-sm text-slate-300">{revision.editSummary ?? '요약 없음'}</p><p className="mt-2 text-xs text-slate-500">편집자 <Editor revision={revision} />{revision.isMinor ? ' · minor' : ''}</p><div className="mt-4"><Actions revision={revision} previous={previous} {...props} /></div></article>; }
function Editor({ revision }: { revision: Revision }) { return revision.createdBy ? <Link href={`/wiki/contributions/${revision.createdBy}`} className="hover:text-emerald-200">{revision.createdByName ?? revision.createdBy}</Link> : <>unknown</>; }
function Actions({ revision, previous, pageId, currentRevisionId, routePath }: { revision: Revision; previous?: Revision; pageId: string; currentRevisionId: string; routePath: string }) { return <div className="flex flex-wrap gap-2"><Link href={buildWikiRevisionPath(revision.id, routePath)} className="chip chip-accent">보기</Link>{previous ? <Link href={buildWikiDiffPath(previous.id, revision.id, routePath)} className="chip chip-muted">diff</Link> : null}{revision.id !== currentRevisionId ? <WikiRevertButton pageId={pageId} revisionId={revision.id} revisionNo={revision.revisionNo} currentRevisionId={currentRevisionId} routePath={routePath} /> : null}</div>; }
function formatDate(value: string) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)); }

'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Filter, Link2, Loader2 } from 'lucide-react';
import { fetchWikiBacklinks, type WikiBacklinkItem, type WikiBacklinkResponse, type WikiBacklinkType } from '../../lib/wiki-api';

const BACKLINK_TYPES: ReadonlyArray<{ readonly type: WikiBacklinkType; readonly label: string }> = [
  { type: 'link', label: '링크' },
  { type: 'file', label: '파일' },
  { type: 'include', label: '포함' },
  { type: 'redirect', label: '넘겨주기' },
];

export function WikiBacklinksClient({ pageId, returnTo }: { readonly pageId: string; readonly returnTo: string }) {
  const [items, setItems] = useState<WikiBacklinkItem[]>([]);
  const [prevCursor, setPrevCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [summary, setSummary] = useState<WikiBacklinkResponse['summary'] | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<WikiBacklinkType[]>(BACKLINK_TYPES.map((item) => item.type));
  const [selectedNamespace, setSelectedNamespace] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setItems([]);
    setPrevCursor(null);
    setCursor(null);
    void fetchWikiBacklinks(pageId, { types: selectedTypes, namespace: selectedNamespace })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setPrevCursor(result.prevCursor);
        setCursor(result.nextCursor);
        setSummary(result.summary);
        if (result.filters.namespace !== selectedNamespace) setSelectedNamespace(result.filters.namespace);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : '역링크를 불러오지 못했습니다.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [pageId, selectedNamespace, selectedTypes]);

  async function loadPage(targetCursor: string) {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchWikiBacklinks(pageId, { cursor: targetCursor, types: selectedTypes, namespace: selectedNamespace });
      setItems(result.items);
      setPrevCursor(result.prevCursor);
      setCursor(result.nextCursor);
      setSummary(result.summary);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '역링크를 더 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  function toggleType(type: WikiBacklinkType) {
    setSelectedTypes((current) => current.includes(type)
      ? current.length === 1 ? current : current.filter((item) => item !== type)
      : BACKLINK_TYPES.map((item) => item.type).filter((item) => current.includes(item) || item === type));
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <Link href={returnTo} className="hover:text-emerald-200">문서로 돌아가기</Link>
        <span>/</span>
        <span className="text-slate-200">역링크</span>
      </nav>
      <header className="border-b border-white/10 pb-6">
        <h1 className="flex items-center gap-3 text-3xl font-bold text-white"><Link2 className="size-7 text-emerald-300" /> 역링크</h1>
        <p className="mt-3 text-sm text-slate-400">이 문서를 링크하는 현재 문서 목록입니다.</p>
      </header>
      <section className="surface-flat space-y-4 p-4" aria-label="역링크 필터">
        <div className="flex items-center justify-between gap-4"><h2 className="flex items-center gap-2 text-sm font-semibold text-white"><Filter className="size-4 text-emerald-300" />유형과 이름공간</h2>{summary ? <p className="text-xs text-slate-400">{summary.complete ? `${summary.total.toLocaleString('ko-KR')}개` : `최근 ${summary.total.toLocaleString('ko-KR')}개 이상`}</p> : null}</div>
        <div className="flex flex-wrap gap-2" aria-label="역링크 유형">
          {BACKLINK_TYPES.map(({ type, label }) => { const count = summary?.typeCounts.find((item) => item.type === type)?.count ?? 0; const selected = selectedTypes.includes(type); return <button key={type} type="button" aria-pressed={selected} onClick={() => toggleType(type)} className={selected ? 'chip chip-accent min-h-11 px-3' : 'chip chip-muted min-h-11 px-3'}>{label}<span className="text-[11px] opacity-70">{count}</span></button>; })}
        </div>
        {summary && summary.namespaceCounts.length > 0 ? <div className="flex flex-wrap gap-2" aria-label="역링크 이름공간">{summary.namespaceCounts.map((item) => <button key={item.namespace} type="button" aria-pressed={selectedNamespace === item.namespace} onClick={() => setSelectedNamespace(item.namespace)} className={selectedNamespace === item.namespace ? 'chip chip-accent min-h-11 px-3' : 'chip chip-muted min-h-11 px-3'}>{item.namespace}<span className="text-[11px] opacity-70">{item.count}</span></button>)}</div> : null}
      </section>
      {items.length > 0 ? (
        <section className="divide-y divide-white/10 border border-white/10 bg-[#111821]">
          {items.map((item) => (
            <article key={item.id} className="p-4 sm:p-5">
              <Link href={item.routePath} className="font-semibold text-emerald-200 hover:underline">{item.displayTitle}</Link>
              <p className="mt-2 flex flex-wrap items-center gap-2 break-all text-xs text-slate-500"><span>{item.namespace}:{item.title}</span>{item.linkTypes.map((type) => <span key={type} className="chip chip-muted">{backlinkTypeLabel(type)}</span>)}</p>
            </article>
          ))}
        </section>
      ) : null}
      {!loading && items.length === 0 && !error ? <p className="border border-white/10 p-6 text-sm text-slate-400">이 문서를 링크하는 공개 문서가 없습니다.</p> : null}
      {error ? <p role="alert" className="text-sm text-red-200">{error}</p> : null}
      {loading ? <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 불러오는 중입니다.</p> : null}
      {(prevCursor || cursor) && !loading ? <nav className="flex flex-wrap gap-2" aria-label="역링크 페이지 이동">{prevCursor ? <button type="button" onClick={() => void loadPage(prevCursor)} className="btn-secondary">이전</button> : null}{cursor ? <button type="button" onClick={() => void loadPage(cursor)} className="btn-secondary">다음</button> : null}</nav> : null}
    </div>
  );
}

function backlinkTypeLabel(value: string): string {
  if (value === 'file') return '파일';
  if (value === 'include') return '포함';
  if (value === 'redirect') return '넘겨주기';
  if (value === 'category') return '분류';
  return '링크';
}

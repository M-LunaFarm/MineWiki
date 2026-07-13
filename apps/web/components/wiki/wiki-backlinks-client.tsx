'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { fetchWikiBacklinks, type WikiBacklinkItem } from '../../lib/wiki-api';

export function WikiBacklinksClient({ pageId, returnTo }: { readonly pageId: string; readonly returnTo: string }) {
  const [items, setItems] = useState<WikiBacklinkItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchWikiBacklinks(pageId)
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setCursor(result.nextCursor);
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
  }, [pageId]);

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchWikiBacklinks(pageId, cursor);
      setItems((current) => [...current, ...result.items]);
      setCursor(result.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '역링크를 더 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
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
      {items.length > 0 ? (
        <section className="divide-y divide-white/10 border border-white/10 bg-[#111821]">
          {items.map((item) => (
            <article key={item.id} className="p-4 sm:p-5">
              <Link href={item.routePath} className="font-semibold text-emerald-200 hover:underline">{item.displayTitle}</Link>
              <p className="mt-2 break-all text-xs text-slate-500">{item.namespace}:{item.title}</p>
            </article>
          ))}
        </section>
      ) : null}
      {!loading && items.length === 0 && !error ? <p className="border border-white/10 p-6 text-sm text-slate-400">이 문서를 링크하는 공개 문서가 없습니다.</p> : null}
      {error ? <p role="alert" className="text-sm text-red-200">{error}</p> : null}
      {loading ? <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 불러오는 중입니다.</p> : null}
      {cursor && !loading ? <button type="button" onClick={() => void loadMore()} className="btn-secondary self-start">더 보기</button> : null}
    </div>
  );
}

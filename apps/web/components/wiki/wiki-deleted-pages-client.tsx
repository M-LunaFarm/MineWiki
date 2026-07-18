'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArchiveRestore, History, Loader2 } from 'lucide-react';
import { fetchWikiDeletedPages, type WikiDeletedPageSummary } from '../../lib/wiki-api';

export function WikiDeletedPagesClient() {
  const [pages, setPages] = useState<WikiDeletedPageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchWikiDeletedPages()
      .then((result) => { if (active) setPages(result); })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : '삭제 문서함을 불러오지 못했습니다.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400"><Link href="/recent" className="hover:text-emerald-200">최근 변경</Link><span>/</span><span className="text-slate-200">삭제 문서함</span></nav>
      <header className="border-b border-white/10 pb-6">
        <h1 className="flex items-center gap-3 text-3xl font-bold text-white"><ArchiveRestore className="size-7 text-emerald-300" /> 삭제 문서함</h1>
        <p className="mt-3 text-sm text-slate-400">직접 만들었거나 관리 권한이 있는 공간에서 삭제된 문서를 복구합니다.</p>
      </header>
      {error ? <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{error}</p> : null}
      {loading ? <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 불러오는 중입니다.</p> : null}
      {!loading && pages.length === 0 ? <p className="border border-white/10 p-6 text-sm text-slate-400">복구할 수 있는 삭제 문서가 없습니다.</p> : null}
      {pages.length > 0 ? (
        <section className="divide-y divide-white/10 border border-white/10 bg-[#111821]">
          {pages.map((page) => (
            <article key={page.id} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
              <div className="min-w-0"><h2 className="truncate font-semibold text-white">{page.displayTitle}</h2><p className="mt-2 break-all text-xs text-slate-500">{page.namespace}:{page.title}</p></div>
              <Link href={`/wiki/deleted/${encodeURIComponent(page.id)}`} className="btn-secondary inline-flex shrink-0 items-center gap-2 self-start sm:self-auto">
                <History className="size-4" /> 이력 검토 및 복구
              </Link>
            </article>
          ))}
        </section>
      ) : null}
    </main>
  );
}

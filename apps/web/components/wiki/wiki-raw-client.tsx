'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchWikiRaw, type WikiRevisionResponse } from '../../lib/wiki-api';

export function WikiRawClient({ pageId, returnTo }: { readonly pageId: string; readonly returnTo: string }) {
  const [revision, setRevision] = useState<WikiRevisionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchWikiRaw(pageId)
      .then((result) => {
        if (active) setRevision(result);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : '원문을 불러오지 못했습니다.');
      });
    return () => {
      active = false;
    };
  }, [pageId]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <Link href={returnTo} className="hover:text-emerald-200">문서로 돌아가기</Link>
        <span>/</span>
        <span className="text-slate-200">원문</span>
      </nav>
      <header className="border-b border-white/10 pb-6">
        <h1 className="text-3xl font-bold text-white">문서 원문</h1>
        <p className="mt-3 text-sm text-slate-400">page {pageId}{revision ? ` · rev ${revision.revisionNo}` : ''}</p>
      </header>
      {error ? <section role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{error}</section> : null}
      {!revision && !error ? <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 원문을 불러오는 중입니다.</div> : null}
      {revision ? (
        <section className="border border-white/10 bg-[#111821] p-4">
          <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">{revision.contentRaw}</pre>
        </section>
      ) : null}
    </div>
  );
}

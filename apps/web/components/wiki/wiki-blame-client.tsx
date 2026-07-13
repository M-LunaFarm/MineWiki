'use client';

import Link from 'next/link';
import { GitCommitHorizontal, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchWikiBlame, type WikiBlameResponse } from '../../lib/wiki-api';

export function WikiBlameClient({ pageId, returnTo }: { readonly pageId: string; readonly returnTo: string }) {
  const [data, setData] = useState<WikiBlameResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchWikiBlame(pageId)
      .then((result) => { if (active) setData(result); })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : '행별 기여 기록을 불러오지 못했습니다.'); });
    return () => { active = false; };
  }, [pageId]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400"><Link href={returnTo} className="hover:text-emerald-200">문서로 돌아가기</Link><span>/</span><span className="text-slate-200">blame</span></nav>
      <header className="border-b border-white/10 pb-6"><h1 className="flex items-center gap-3 text-3xl font-bold text-white"><GitCommitHorizontal className="size-7 text-emerald-300" /> 행별 기여 기록</h1><p className="mt-3 text-sm text-slate-400">현재 원문의 각 행이 마지막으로 변경된 리비전과 작성자를 추적합니다.</p></header>
      {error ? <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{error}</p> : null}
      {!data && !error ? <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 리비전 기록을 분석하는 중입니다.</p> : null}
      {data ? <>
        <div className="flex flex-wrap gap-2 text-xs"><span className="chip chip-muted">현재 rev {data.revisionNo}</span><span className="chip chip-muted">리비전 {data.revisionCount}</span><span className="chip chip-muted">원문 {data.lineCount.toLocaleString('ko-KR')}행</span></div>
        {data.truncatedHistory || data.truncatedLines ? <p className="border border-amber-300/20 bg-amber-300/10 p-4 text-sm text-amber-100">성능 보호를 위해 {data.truncatedHistory ? '최근 500개 리비전' : ''}{data.truncatedHistory && data.truncatedLines ? '과 ' : ''}{data.truncatedLines ? '앞 5,000행' : ''}을 분석했습니다.</p> : null}
        <section className="overflow-hidden border border-white/10 bg-[#0d1219] font-mono text-xs">
          {data.lines.map((line, index) => {
            const previous = data.lines[index - 1];
            const showSource = !previous || previous.revisionId !== line.revisionId;
            return <div key={line.lineNo} className="grid min-w-0 border-b border-white/[0.045] last:border-b-0 md:grid-cols-[12rem_4rem_minmax(0,1fr)]">
              <div className={`min-w-0 border-b border-white/[0.045] px-3 py-2 text-slate-500 md:border-b-0 md:border-r ${showSource ? 'bg-white/[0.025]' : ''}`}>{showSource ? <><Link href={`/wiki/revision/${line.revisionId}`} className="font-semibold text-emerald-300 hover:underline">r{line.revisionNo}</Link><span className="ml-2">{line.createdByName}</span><time className="mt-1 block text-[10px]">{formatDate(line.createdAt)}</time></> : <span className="sr-only">같은 리비전</span>}</div>
              <div className="hidden select-none border-r border-white/[0.045] px-3 py-2 text-right text-slate-600 md:block">{line.lineNo}</div>
              <pre className="min-w-0 overflow-x-auto whitespace-pre px-3 py-2 text-slate-200"><span className="mr-3 select-none text-slate-600 md:hidden">{line.lineNo}</span>{line.content || ' '}</pre>
            </div>;
          })}
        </section>
      </> : null}
    </div>
  );
}

function formatDate(value: string) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)); }

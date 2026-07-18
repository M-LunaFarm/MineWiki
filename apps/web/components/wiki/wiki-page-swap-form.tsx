'use client';

import { ArrowLeftRight, Loader2, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { fetchWikiSwapCandidates, swapWikiPages, type WikiSwapCandidate } from '../../lib/wiki-api';
import { buildWikiPagePath } from '../../lib/wiki-routes.mjs';

export function WikiPageSwapForm(props: {
  readonly pageId: string;
  readonly title: string;
  readonly currentRevisionId: string;
}) {
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<WikiSwapCandidate[]>([]);
  const [selected, setSelected] = useState<WikiSwapCandidate | null>(null);
  const [reason, setReason] = useState('');
  const [sourceConfirmation, setSourceConfirmation] = useState('');
  const [targetConfirmation, setTargetConfirmation] = useState('');
  const [working, setWorking] = useState<'search' | 'swap' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    setWorking('search');
    setMessage(null);
    setSelected(null);
    try {
      const result = await fetchWikiSwapCandidates(props.pageId, query.trim());
      setCandidates(result.items);
      if (result.items.length === 0) setMessage('교환 가능한 같은 위키의 일반 문서를 찾지 못했습니다.');
    } catch (error) {
      setCandidates([]);
      setMessage(error instanceof Error ? error.message : '교환 대상을 찾지 못했습니다.');
    } finally {
      setWorking(null);
    }
  }

  async function swap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || sourceConfirmation !== props.title || targetConfirmation !== selected.title) return;
    setWorking('swap');
    setMessage(null);
    try {
      const result = await swapWikiPages({
        pageId: props.pageId,
        targetPageId: selected.pageId,
        expectedSourceRevisionId: props.currentRevisionId,
        expectedTargetRevisionId: selected.currentRevisionId,
        reason: reason.trim(),
        sourceTitleConfirmation: sourceConfirmation,
        targetTitleConfirmation: targetConfirmation,
      });
      window.location.assign(buildWikiPagePath(result.source.namespace, result.source.slug));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '문서 제목을 교환하지 못했습니다. 입력 내용은 유지됩니다.');
      setWorking(null);
    }
  }

  const ready = selected !== null
    && reason.trim().length >= 5
    && sourceConfirmation === props.title
    && targetConfirmation === selected.title;

  return (
    <section className="mt-5 border-t border-white/10 pt-4" aria-labelledby="wiki-page-swap-title">
      <h3 id="wiki-page-swap-title" className="flex items-center gap-2 text-sm font-semibold text-slate-200"><ArrowLeftRight className="size-4" />두 문서 제목 교환</h3>
      <p className="mt-2 text-xs leading-5 text-slate-500">같은 위키·네임스페이스의 하위 문서가 없는 일반 문서끼리 제목과 경로를 원자적으로 맞바꿉니다. 내용·역사·토론·ACL은 각 문서 ID에 그대로 남습니다.</p>
      <form onSubmit={search} className="mt-4 flex flex-col gap-2 sm:flex-row">
        <label className="min-w-0 flex-1 text-xs font-semibold text-slate-400">교환할 문서 검색
          <input value={query} onChange={(event) => setQuery(event.target.value)} minLength={2} maxLength={100} required placeholder="문서 제목 2자 이상" className="mt-1.5 min-h-11 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-emerald-400/50" />
        </label>
        <button type="submit" disabled={working !== null || query.trim().length < 2} className="chip chip-muted mt-auto inline-flex min-h-11 w-full items-center justify-center gap-2 px-4 disabled:opacity-50 sm:w-auto">{working === 'search' ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}검색</button>
      </form>

      {candidates.length > 0 ? <fieldset className="mt-3 space-y-2"><legend className="sr-only">교환 대상 선택</legend>{candidates.map((candidate) => <label key={candidate.pageId} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm ${selected?.pageId === candidate.pageId ? 'border-emerald-300/40 bg-emerald-300/10 text-white' : 'border-white/10 text-slate-300 hover:border-white/20'}`}><input type="radio" name="wiki-swap-target" checked={selected?.pageId === candidate.pageId} onChange={() => { setSelected(candidate); setTargetConfirmation(''); }} /><span className="min-w-0"><strong className="block truncate">{candidate.displayTitle}</strong><span className="block truncate text-xs text-slate-500">{candidate.title}</span></span></label>)}</fieldset> : null}

      {selected ? <form onSubmit={swap} className="mt-4 space-y-3 rounded-lg border border-amber-300/20 bg-amber-400/[0.05] p-4">
        <p className="text-sm font-semibold text-amber-100"><span className="break-all">{props.title}</span> <ArrowLeftRight className="mx-1 inline size-4" /> <span className="break-all">{selected.title}</span></p>
        <label className="block text-xs font-semibold text-slate-400">교환 사유
          <input value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={255} required placeholder="5자 이상 입력" className="mt-1.5 min-h-11 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-amber-300/50" />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-semibold text-slate-400">현재 제목 확인: {props.title}
            <input value={sourceConfirmation} onChange={(event) => setSourceConfirmation(event.target.value)} required className="mt-1.5 min-h-11 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-amber-300/50" />
          </label>
          <label className="block text-xs font-semibold text-slate-400">대상 제목 확인: {selected.title}
            <input value={targetConfirmation} onChange={(event) => setTargetConfirmation(event.target.value)} required className="mt-1.5 min-h-11 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-amber-300/50" />
          </label>
        </div>
        <button type="submit" disabled={!ready || working !== null} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full border border-amber-300/35 px-4 text-sm font-semibold text-amber-100 hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto">{working === 'swap' ? <Loader2 className="size-4 animate-spin" /> : <ArrowLeftRight className="size-4" />}제목 교환</button>
      </form> : null}
      {message ? <p role="alert" className="mt-3 text-xs leading-5 text-amber-200">{message}</p> : null}
    </section>
  );
}

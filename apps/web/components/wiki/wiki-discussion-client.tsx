'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, MessageSquarePlus, MessagesSquare } from 'lucide-react';
import {
  addWikiThreadComment,
  createWikiThread,
  fetchWikiThread,
  fetchWikiThreads,
  setWikiThreadStatus,
  type WikiThreadDetail,
  type WikiThreadSummary
} from '../../lib/wiki-api';
import { useAuth } from '../providers/auth-context';

export function WikiDiscussionClient({ pageId, returnTo }: { readonly pageId: string; readonly returnTo: string }) {
  const { account } = useAuth();
  const [threads, setThreads] = useState<WikiThreadSummary[]>([]);
  const [selected, setSelected] = useState<WikiThreadDetail | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchWikiThreads(pageId)
      .then((result) => { if (active) setThreads(result); })
      .catch((caught) => { if (active) setError(message(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [pageId]);

  async function open(thread: WikiThreadSummary) {
    setLoading(true); setError(null);
    try { setSelected(await fetchWikiThread(thread.id)); } catch (caught) { setError(message(caught)); } finally { setLoading(false); }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setWorking(true); setError(null);
    try {
      const thread = await createWikiThread({ pageId, title, content });
      setThreads((current) => [thread, ...current]); setSelected(thread); setTitle(''); setContent('');
    } catch (caught) { setError(message(caught)); } finally { setWorking(false); }
  }

  async function reply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return; setWorking(true); setError(null);
    try {
      const thread = await addWikiThreadComment({ threadId: selected.id, content: comment });
      setSelected(thread); setComment('');
      setThreads((current) => current.map((item) => item.id === thread.id ? thread : item));
    } catch (caught) { setError(message(caught)); } finally { setWorking(false); }
  }

  async function toggleStatus() {
    if (!selected) return; setWorking(true); setError(null);
    try {
      const thread = await setWikiThreadStatus({ threadId: selected.id, status: selected.status === 'open' ? 'closed' : 'open' });
      setSelected(thread); setThreads((current) => current.map((item) => item.id === thread.id ? thread : item));
    } catch (caught) { setError(message(caught)); } finally { setWorking(false); }
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400"><Link href={returnTo} className="hover:text-emerald-200">문서로 돌아가기</Link><span>/</span><span className="text-slate-200">토론</span></nav>
      <header className="border-b border-white/10 pb-6"><h1 className="flex items-center gap-3 text-3xl font-bold text-white"><MessagesSquare className="size-7 text-emerald-300" /> 문서 토론</h1><p className="mt-3 text-sm text-slate-400">문서 내용과 편집 방향을 공개적으로 논의합니다.</p></header>
      {error ? <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{error}</p> : null}
      <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className="space-y-4">
          {account ? <details className="border border-white/10 bg-[#111821] p-4"><summary className="cursor-pointer font-semibold text-white">새 토론</summary><form onSubmit={create} className="mt-4 space-y-3"><input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={255} placeholder="토론 제목" aria-label="토론 제목" className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" /><textarea value={content} onChange={(event) => setContent(event.target.value)} required maxLength={10000} rows={5} placeholder="첫 의견" aria-label="첫 의견" className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" /><button disabled={working} className="btn-primary inline-flex items-center gap-2"><MessageSquarePlus className="size-4" /> 토론 만들기</button></form></details> : <p className="text-sm text-slate-500"><Link href={`/login?returnTo=${encodeURIComponent(locationPath(pageId, returnTo))}`} className="text-emerald-300">로그인</Link>하면 토론에 참여할 수 있습니다.</p>}
          <section className="divide-y divide-white/10 border border-white/10 bg-[#111821]">
            {threads.map((thread) => <button key={thread.id} type="button" onClick={() => void open(thread)} className={`block w-full p-4 text-left transition hover:bg-white/[0.03] ${selected?.id === thread.id ? 'bg-emerald-400/10' : ''}`}><span className="font-semibold text-white">{thread.title}</span><span className="mt-2 block text-xs text-slate-500">{thread.status} · 댓글 {thread.commentCount}</span></button>)}
            {!loading && threads.length === 0 ? <p className="p-4 text-sm text-slate-500">아직 토론이 없습니다.</p> : null}
          </section>
        </aside>
        <section className="min-w-0">
          {loading ? <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 불러오는 중입니다.</p> : null}
          {selected ? <div className="space-y-4"><div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-4"><div><h2 className="text-2xl font-bold text-white">{selected.title}</h2><p className="mt-2 text-xs text-slate-500">{selected.createdByName} · {selected.status}</p></div>{account ? <button type="button" disabled={working} onClick={() => void toggleStatus()} className="chip chip-muted">{selected.status === 'open' ? '토론 닫기' : '다시 열기'}</button> : null}</div>{selected.comments.map((item) => <article key={item.id} className="border border-white/10 bg-[#111821] p-4"><div className="flex justify-between gap-3 text-xs text-slate-500"><Link href={`/wiki/contributions/${item.createdBy}`} className="hover:text-emerald-200">{item.createdByName}</Link><time>{formatDate(item.createdAt)}</time></div><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">{item.content ?? '삭제된 댓글입니다.'}</p></article>)}{account && selected.status === 'open' ? <form onSubmit={reply} className="space-y-3"><textarea value={comment} onChange={(event) => setComment(event.target.value)} required maxLength={10000} rows={5} placeholder="댓글 작성" aria-label="토론 댓글" className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" /><button disabled={working} className="btn-primary">댓글 등록</button></form> : null}</div> : !loading ? <p className="border border-white/10 p-6 text-sm text-slate-400">왼쪽에서 토론을 선택하세요.</p> : null}
        </section>
      </div>
    </main>
  );
}

function message(error: unknown) { return error instanceof Error ? error.message : '토론 요청에 실패했습니다.'; }
function formatDate(value: string) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)); }
function locationPath(pageId: string, returnTo: string) { return `/wiki/discuss/${encodeURIComponent(pageId)}?returnTo=${encodeURIComponent(returnTo)}`; }

'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Bell, BellOff, Loader2, MessageSquarePlus, MessagesSquare, Trash2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import {
  addWikiThreadComment,
  createWikiThread,
  deleteWikiThreadComment,
  fetchWikiThread,
  fetchWikiThreads,
  setWikiThreadStatus,
  setWikiThreadSubscription,
  type WikiThreadDetail,
  type WikiThreadSummary
} from '../../lib/wiki-api';
import { useAuth } from '../providers/auth-context';

export function WikiDiscussionClient({ pageId, returnTo }: { readonly pageId: string; readonly returnTo: string }) {
  const { account } = useAuth();
  const searchParams = useSearchParams();
  const requestedThreadId = searchParams.get('thread');
  const requestedCommentId = searchParams.get('comment');
  const [threads, setThreads] = useState<WikiThreadSummary[]>([]);
  const [selected, setSelected] = useState<WikiThreadDetail | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prependAnchor = useRef<{ id: string; top: number } | null>(null);

  useEffect(() => {
    let active = true;
    void fetchWikiThreads(pageId)
      .then(async (result) => {
        if (!active) return;
        setThreads(result);
        if (requestedThreadId) {
          const detail = await fetchWikiThread(requestedThreadId, undefined, requestedCommentId ?? undefined);
          if (!active) return;
          if (detail.pageId !== pageId) throw new Error('이 문서의 토론이 아닙니다.');
          setSelected(detail);
        }
      })
      .catch((caught) => { if (active) setError(message(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [pageId, requestedCommentId, requestedThreadId]);

  useEffect(() => {
    if (!selected || !requestedCommentId) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`comment-${requestedCommentId}`);
      target?.scrollIntoView({ block: 'center' });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [requestedCommentId, selected]);

  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    if (!anchor) return;
    prependAnchor.current = null;
    const target = document.getElementById(`comment-${anchor.id}`);
    if (target) window.scrollBy({ top: target.getBoundingClientRect().top - anchor.top });
  }, [selected?.comments]);

  async function open(thread: WikiThreadSummary) {
    setLoading(true); setError(null);
    try {
      setSelected(await fetchWikiThread(thread.id));
      setThreadInUrl(thread.id);
    } catch (caught) { setError(message(caught)); } finally { setLoading(false); }
  }

  function closeThread() {
    setSelected(null);
    setThreadInUrl(null);
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

  async function toggleSubscription() {
    if (!selected) return;
    setWorking(true); setError(null);
    try {
      const result = await setWikiThreadSubscription(selected.id, !selected.subscribed);
      setSelected((current) => current ? { ...current, subscribed: result.subscribed } : current);
    } catch (caught) { setError(message(caught)); } finally { setWorking(false); }
  }

  async function removeComment(commentId: string) {
    if (!selected || !window.confirm('이 댓글을 삭제하시겠습니까?')) return;
    setWorking(true); setError(null);
    try {
      const thread = await deleteWikiThreadComment({ threadId: selected.id, commentId });
      setSelected(thread); setThreads((current) => current.map((item) => item.id === thread.id ? thread : item));
    } catch (caught) { setError(message(caught)); } finally { setWorking(false); }
  }

  async function loadOlderComments() {
    if (!selected?.nextCommentCursor) return;
    setLoadingOlder(true); setError(null);
    try {
      const first = selected.comments[0];
      const element = first ? document.getElementById(`comment-${first.id}`) : null;
      if (first && element) prependAnchor.current = { id: first.id, top: element.getBoundingClientRect().top };
      const older = await fetchWikiThread(selected.id, selected.nextCommentCursor);
      setSelected((current) => current?.id === older.id ? {
        ...current,
        comments: [...older.comments, ...current.comments.filter((comment) => !older.comments.some((item) => item.id === comment.id))],
        nextCommentCursor: older.nextCommentCursor
      } : current);
    } catch (caught) { setError(message(caught)); } finally { setLoadingOlder(false); }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400"><Link href={returnTo} className="hover:text-emerald-200">문서로 돌아가기</Link><span>/</span><span className="text-slate-200">토론</span></nav>
      <header className="border-b border-white/10 pb-6"><h1 className="flex items-center gap-3 text-3xl font-bold text-white"><MessagesSquare className="size-7 text-emerald-300" /> 문서 토론</h1><p className="mt-3 text-sm text-slate-400">문서 내용과 편집 방향을 공개적으로 논의합니다.</p></header>
      {error ? <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{error}</p> : null}
      <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className={`space-y-4 ${selected ? 'hidden lg:block' : ''}`}>
          {account ? <details className="border border-white/10 bg-[#111821] p-4"><summary className="cursor-pointer font-semibold text-white">새 토론</summary><form onSubmit={create} className="mt-4 space-y-3"><input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={255} placeholder="토론 제목" aria-label="토론 제목" className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" /><textarea value={content} onChange={(event) => setContent(event.target.value)} required maxLength={10000} rows={5} placeholder="첫 의견" aria-label="첫 의견" className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" /><button disabled={working} className="btn-primary inline-flex items-center gap-2"><MessageSquarePlus className="size-4" /> 토론 만들기</button></form></details> : <p className="text-sm text-slate-500"><Link href={`/login?returnTo=${encodeURIComponent(locationPath(pageId, returnTo))}`} className="text-emerald-300">로그인</Link>하면 토론에 참여할 수 있습니다.</p>}
          <section className="divide-y divide-white/10 border border-white/10 bg-[#111821]">
            {threads.map((thread) => <button key={thread.id} type="button" onClick={() => void open(thread)} className={`block w-full p-4 text-left transition hover:bg-white/[0.03] ${selected?.id === thread.id ? 'bg-emerald-400/10' : ''}`}><span className="font-semibold text-white">{thread.title}</span><span className="mt-2 block text-xs text-slate-500">{thread.status} · 댓글 {thread.commentCount}</span></button>)}
            {!loading && threads.length === 0 ? <p className="p-4 text-sm text-slate-500">아직 토론이 없습니다.</p> : null}
          </section>
        </aside>
        <section className={`min-w-0 ${selected ? '' : 'hidden lg:block'}`}>
          {loading ? <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 불러오는 중입니다.</p> : null}
          {selected ? <div className="space-y-4"><button type="button" onClick={closeThread} className="inline-flex min-h-11 items-center gap-2 text-sm text-slate-300 lg:hidden"><ArrowLeft className="size-4" /> 토론 목록</button><div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-4"><div className="min-w-0"><h2 className="break-words text-2xl font-bold text-white">{selected.title}</h2><p className="mt-2 text-xs text-slate-500">{selected.createdByName} · {selected.status} · 댓글 {selected.commentCount.toLocaleString('ko-KR')}개</p></div><div className="flex flex-wrap gap-2">{account ? <button type="button" disabled={working} onClick={() => void toggleSubscription()} className="chip chip-muted inline-flex min-h-11 items-center gap-2">{selected.subscribed ? <BellOff className="size-4" /> : <Bell className="size-4" />}{selected.subscribed ? '알림 끄기' : '알림 받기'}</button> : null}{selected.canModerate ? <button type="button" disabled={working} onClick={() => void toggleStatus()} className="chip chip-muted min-h-11">{selected.status === 'open' ? '토론 닫기' : '다시 열기'}</button> : null}</div></div>{selected.nextCommentCursor ? <button type="button" disabled={loadingOlder} onClick={() => void loadOlderComments()} className="chip chip-muted mx-auto flex min-h-11 items-center gap-2">{loadingOlder ? <Loader2 className="size-4 animate-spin" /> : null} 이전 댓글 더 보기</button> : null}{selected.comments.map((item) => <article id={`comment-${item.id}`} tabIndex={-1} data-highlighted={item.id === requestedCommentId || undefined} key={item.id} className="border border-white/10 bg-[#111821] p-4 outline-none data-[highlighted=true]:border-emerald-300/60 data-[highlighted=true]:bg-emerald-300/10"><div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500"><Link href={`/wiki/contributions/${item.createdBy}`} className="hover:text-emerald-200">{item.createdByName}</Link><span className="flex items-center gap-3"><time>{formatDate(item.createdAt)}</time>{item.canDelete ? <button type="button" disabled={working} onClick={() => void removeComment(item.id)} className="inline-flex min-h-11 items-center gap-1 text-slate-500 hover:text-red-200"><Trash2 className="size-3.5" /> 삭제</button> : null}</span></div><p className="mt-3 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 text-slate-200">{item.content ?? '삭제된 댓글입니다.'}</p></article>)}{selected.canReply ? <form onSubmit={reply} className="space-y-3"><textarea value={comment} onChange={(event) => setComment(event.target.value)} required maxLength={10000} rows={5} placeholder="댓글 작성" aria-label="토론 댓글" className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" /><button disabled={working} className="btn-primary w-full sm:w-auto">댓글 등록</button></form> : null}</div> : !loading ? <p className="border border-white/10 p-6 text-sm text-slate-400">왼쪽에서 토론을 선택하세요.</p> : null}
        </section>
      </div>
    </div>
  );
}

function message(error: unknown) { return error instanceof Error ? error.message : '토론 요청에 실패했습니다.'; }
function formatDate(value: string) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)); }
function locationPath(pageId: string, returnTo: string) { return `/wiki/discuss/${encodeURIComponent(pageId)}?returnTo=${encodeURIComponent(returnTo)}`; }
function setThreadInUrl(threadId: string | null) {
  const url = new URL(window.location.href);
  if (threadId) url.searchParams.set('thread', threadId); else url.searchParams.delete('thread');
  url.searchParams.delete('comment');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

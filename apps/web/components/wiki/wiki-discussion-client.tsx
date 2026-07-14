'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Bell, BellOff, Code2, FileInput, Loader2, MessageSquarePlus, MessagesSquare, Pencil, Pin, Search, Trash2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import {
  addWikiThreadComment,
  createWikiThread,
  deleteWikiThreadComment,
  deleteWikiThread,
  fetchWikiThread,
  fetchWikiThreadCommentRaw,
  fetchWikiThreads,
  moveWikiThread,
  searchWiki,
  setWikiThreadStatus,
  setWikiThreadSubscription,
  setWikiThreadPinnedComment,
  updateWikiThreadTopic,
  type WikiThreadDetail,
  type WikiSearchResult,
  type WikiThreadSummary
} from '../../lib/wiki-api';
import { useAuth } from '../providers/auth-context';
import { buildServerWikiToolPath } from '../../lib/wiki-routes.mjs';

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
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [moveQuery, setMoveQuery] = useState('');
  const [moveResults, setMoveResults] = useState<WikiSearchResult[]>([]);
  const [movePageId, setMovePageId] = useState('');
  const [moveTarget, setMoveTarget] = useState<WikiSearchResult | null>(null);
  const [moveReason, setMoveReason] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [rawComment, setRawComment] = useState<{ id: string; content: string } | null>(null);
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

  async function saveTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return;
    setWorking(true); setError(null);
    try {
      const thread = await updateWikiThreadTopic(selected.id, topicDraft);
      setSelected(thread); setThreads((current) => current.map((item) => item.id === thread.id ? thread : item)); setEditingTopic(false);
    } catch (caught) { setError(message(caught)); } finally { setWorking(false); }
  }

  async function togglePinnedComment(commentId: string) {
    if (!selected) return;
    setWorking(true); setError(null);
    try { setSelected(await setWikiThreadPinnedComment(selected.id, selected.pinnedCommentId === commentId ? null : commentId)); }
    catch (caught) { setError(message(caught)); } finally { setWorking(false); }
  }

  async function removeComment(commentId: string) {
    if (!selected || !window.confirm('이 댓글을 삭제하시겠습니까?')) return;
    setWorking(true); setError(null);
    try {
      const thread = await deleteWikiThreadComment({ threadId: selected.id, commentId });
      setSelected(thread); setThreads((current) => current.map((item) => item.id === thread.id ? thread : item));
    } catch (caught) { setError(message(caught)); } finally { setWorking(false); }
  }

  async function showRawComment(commentId: string) {
    if (!selected) return;
    if (rawComment?.id === commentId) { setRawComment(null); return; }
    setWorking(true); setError(null);
    try { setRawComment({ id: commentId, content: await fetchWikiThreadCommentRaw(selected.id, commentId) }); }
    catch (caught) { setError(message(caught)); }
    finally { setWorking(false); }
  }

  async function searchMoveTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!moveQuery.trim()) return;
    setWorking(true); setError(null);
    try {
      const result = await searchWiki({ q: moveQuery.trim(), limit: 10 });
      setMoveResults(result.items.filter((item) => item.pageId !== pageId));
    } catch (caught) { setError(message(caught)); }
    finally { setWorking(false); }
  }

  async function moveSelectedThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !movePageId) return;
    setWorking(true); setError(null);
    try {
      const moved = await moveWikiThread({ threadId: selected.id, pageId: movePageId, reason: moveReason.trim() || undefined });
      setThreads((current) => current.filter((item) => item.id !== moved.id));
      const target = moveTarget;
      if (target) window.location.assign(discussionHref(target, moved.id));
      else window.location.assign(`/wiki/discuss/${encodeURIComponent(movePageId)}?thread=${encodeURIComponent(moved.id)}`);
    } catch (caught) { setError(message(caught)); setWorking(false); }
  }

  async function removeSelectedThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || deleteConfirmation !== selected.title) {
      setError(`확인란에 “${selected?.title ?? ''}”을 정확히 입력해 주세요.`);
      return;
    }
    if (!window.confirm('이 토론 전체를 삭제할까요? 목록에서는 즉시 숨겨지고 감사 기록은 유지됩니다.')) return;
    setWorking(true); setError(null);
    try {
      await deleteWikiThread(selected.id, deleteReason);
      setThreads((current) => current.filter((item) => item.id !== selected.id));
      setSelected(null); setThreadInUrl(null); setDeleteReason(''); setDeleteConfirmation('');
    } catch (caught) { setError(message(caught)); }
    finally { setWorking(false); }
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
          {selected ? <div className="space-y-4"><button type="button" onClick={closeThread} className="inline-flex min-h-11 items-center gap-2 text-sm text-slate-300 lg:hidden"><ArrowLeft className="size-4" /> 토론 목록</button><div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-4"><div className="min-w-0 flex-1">{editingTopic ? <form onSubmit={saveTopic} className="flex flex-col gap-2 sm:flex-row"><input value={topicDraft} onChange={(event) => setTopicDraft(event.target.value)} required maxLength={255} aria-label="토론 제목" className="min-h-11 min-w-0 flex-1 rounded-md border border-white/10 bg-black/20 px-3 text-white" /><button disabled={working} className="btn-primary min-h-11">저장</button><button type="button" onClick={() => setEditingTopic(false)} className="btn-secondary min-h-11">취소</button></form> : <h2 className="break-words text-2xl font-bold text-white">{selected.title}</h2>}<p className="mt-2 text-xs text-slate-500">{selected.createdByName} · {selected.status} · 댓글 {selected.commentCount.toLocaleString('ko-KR')}개</p></div><div className="flex flex-wrap gap-2">{account ? <button type="button" disabled={working} onClick={() => void toggleSubscription()} className="chip chip-muted inline-flex min-h-11 items-center gap-2">{selected.subscribed ? <BellOff className="size-4" /> : <Bell className="size-4" />}{selected.subscribed ? '알림 끄기' : '알림 받기'}</button> : null}{selected.canModerate && !editingTopic ? <button type="button" onClick={() => { setTopicDraft(selected.title); setEditingTopic(true); }} className="chip chip-muted inline-flex min-h-11 items-center gap-2"><Pencil className="size-4" /> 제목 변경</button> : null}{selected.canModerate ? <button type="button" disabled={working} onClick={() => void toggleStatus()} className="chip chip-muted min-h-11">{selected.status === 'open' ? '토론 닫기' : '다시 열기'}</button> : null}</div></div>{selected.canManagePage ? <details className="surface-flat p-4"><summary className="cursor-pointer text-sm font-semibold text-slate-200">토론 관리</summary><div className="mt-4 grid gap-5 xl:grid-cols-2"><div><h3 className="flex items-center gap-2 text-sm font-semibold text-white"><FileInput className="size-4 text-emerald-300" /> 다른 문서로 이동</h3><form onSubmit={searchMoveTarget} className="mt-3 flex gap-2"><input value={moveQuery} onChange={(event) => setMoveQuery(event.target.value)} required placeholder="대상 문서 검색" aria-label="대상 문서 검색" className="min-h-11 min-w-0 flex-1 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white" /><button disabled={working} className="btn-secondary min-h-11 gap-2"><Search className="size-4" /> 검색</button></form>{moveResults.length > 0 ? <div className="mt-2 max-h-48 overflow-y-auto border border-white/10">{moveResults.map((result) => <button key={result.pageId} type="button" onClick={() => { setMovePageId(result.pageId); setMoveTarget(result); }} className={`block w-full border-b border-white/10 px-3 py-2 text-left text-sm last:border-0 ${movePageId === result.pageId ? 'bg-emerald-300/10 text-emerald-200' : 'text-slate-300 hover:bg-white/[0.04]'}`}><span className="block font-semibold">{result.displayTitle}</span><span className="mt-1 block truncate text-xs text-slate-500">{result.routePath} · #{result.pageId}</span></button>)}</div> : null}<form onSubmit={moveSelectedThread} className="mt-3 space-y-2"><input value={movePageId} onChange={(event) => { setMovePageId(event.target.value); setMoveTarget(null); }} pattern="[0-9]+" inputMode="numeric" required placeholder="대상 문서 ID" aria-label="대상 문서 ID" className="min-h-11 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white" /><input value={moveReason} onChange={(event) => setMoveReason(event.target.value)} maxLength={1000} placeholder="이동 사유" aria-label="이동 사유" className="min-h-11 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white" /><button disabled={working || !movePageId} className="btn-primary min-h-11 gap-2"><FileInput className="size-4" /> 토론 이동</button></form></div><form onSubmit={removeSelectedThread} className="border-t border-red-300/15 pt-5 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0"><h3 className="flex items-center gap-2 text-sm font-semibold text-red-200"><Trash2 className="size-4" /> 토론 전체 삭제</h3><p className="mt-2 text-xs leading-5 text-slate-500">댓글을 포함한 토론을 공개 목록에서 숨기고 변경 기록을 남깁니다.</p><input value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} required maxLength={1000} placeholder="삭제 사유" aria-label="토론 삭제 사유" className="mt-3 min-h-11 w-full rounded-md border border-red-300/20 bg-black/20 px-3 text-sm text-white" /><input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} required placeholder={selected.title} aria-label="토론 제목 확인" className="mt-2 min-h-11 w-full rounded-md border border-red-300/20 bg-black/20 px-3 text-sm text-white" /><button disabled={working} className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-md border border-red-300/30 px-4 text-sm font-semibold text-red-200 hover:bg-red-300/10"><Trash2 className="size-4" /> 전체 삭제</button></form></div></details> : null}{selected.nextCommentCursor ? <button type="button" disabled={loadingOlder} onClick={() => void loadOlderComments()} className="chip chip-muted mx-auto flex min-h-11 items-center gap-2">{loadingOlder ? <Loader2 className="size-4 animate-spin" /> : null} 이전 댓글 더 보기</button> : null}{selected.comments.map((item) => <article id={`comment-${item.id}`} tabIndex={-1} data-highlighted={item.id === requestedCommentId || undefined} key={item.id} className={`border bg-[#111821] p-4 outline-none data-[highlighted=true]:border-emerald-300/60 data-[highlighted=true]:bg-emerald-300/10 ${item.pinned ? 'border-amber-300/50' : 'border-white/10'}`}><div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500"><span className="flex items-center gap-2">{item.pinned ? <span className="inline-flex items-center gap-1 text-amber-200"><Pin className="size-3.5" /> 고정됨</span> : null}<Link href={`/wiki/contributions/${item.createdBy}`} className="hover:text-emerald-200">{item.createdByName}</Link></span><span className="flex flex-wrap items-center gap-3"><time>{formatDate(item.createdAt)}</time>{item.status !== 'deleted' ? <button type="button" disabled={working} onClick={() => void showRawComment(item.id)} className="inline-flex min-h-11 items-center gap-1 hover:text-emerald-200"><Code2 className="size-3.5" /> {rawComment?.id === item.id ? '원문 닫기' : '원문'}</button> : null}{selected.canModerate && item.status !== 'deleted' ? <button type="button" disabled={working} onClick={() => void togglePinnedComment(item.id)} className="inline-flex min-h-11 items-center gap-1 hover:text-amber-200"><Pin className="size-3.5" /> {item.pinned ? '고정 해제' : '고정'}</button> : null}{item.canDelete ? <button type="button" disabled={working} onClick={() => void removeComment(item.id)} className="inline-flex min-h-11 items-center gap-1 text-slate-500 hover:text-red-200"><Trash2 className="size-3.5" /> 삭제</button> : null}</span></div><p className="mt-3 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 text-slate-200">{item.content ?? '삭제된 댓글입니다.'}</p>{rawComment?.id === item.id ? <pre className="mt-3 overflow-x-auto whitespace-pre-wrap border-t border-white/10 pt-3 text-xs leading-5 text-slate-400">{rawComment.content}</pre> : null}</article>)}{selected.canReply ? <form onSubmit={reply} className="space-y-3"><textarea value={comment} onChange={(event) => setComment(event.target.value)} required maxLength={10000} rows={5} placeholder="댓글 작성" aria-label="토론 댓글" className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" /><button disabled={working} className="btn-primary w-full sm:w-auto">댓글 등록</button></form> : null}</div> : !loading ? <p className="border border-white/10 p-6 text-sm text-slate-400">왼쪽에서 토론을 선택하세요.</p> : null}
        </section>
      </div>
    </div>
  );
}

function message(error: unknown) { return error instanceof Error ? error.message : '토론 요청에 실패했습니다.'; }
function formatDate(value: string) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)); }
function locationPath(pageId: string, returnTo: string) { return `/wiki/discuss/${encodeURIComponent(pageId)}?returnTo=${encodeURIComponent(returnTo)}`; }
function discussionHref(target: WikiSearchResult, threadId: string) {
  return target.routePath.startsWith('/server/')
    ? `${buildServerWikiToolPath(target.routePath, 'discuss')}?thread=${encodeURIComponent(threadId)}`
    : `/wiki/discuss/${encodeURIComponent(target.pageId)}?returnTo=${encodeURIComponent(target.routePath)}&thread=${encodeURIComponent(threadId)}`;
}
function setThreadInUrl(threadId: string | null) {
  const url = new URL(window.location.href);
  if (threadId) url.searchParams.set('thread', threadId); else url.searchParams.delete('thread');
  url.searchParams.delete('comment');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

'use client';

import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, BarChart3, Bell, BellOff, Code2, Eye, EyeOff, FileInput, History, Loader2, MessageSquarePlus, MessagesSquare, Pause, Pencil, Pin, Plus, Reply, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { addWikiThreadComment, closeWikiDiscussionPoll, createWikiThread, deleteWikiThreadComment, deleteWikiThread, fetchWikiDiscussionPermissions, fetchWikiThread, fetchWikiThreadCommentRaw, fetchWikiThreads, moveWikiThread, searchWiki, setWikiThreadStatus, setWikiThreadSubscription, setWikiThreadPinnedComment, setWikiThreadCommentVisibility, updateWikiThreadTopic, voteWikiDiscussionPoll, wikiDiscussionEventsUrl, WikiApiError, type WikiDiscussionPollDetail, type WikiDiscussionPollInput, type WikiDiscussionPollResultsVisibility, type WikiDiscussionStatus, type WikiDiscussionStatusCounts, type WikiDiscussionStatusFilter, type WikiThreadDetail, type WikiThreadListResponse, type WikiSearchResult, type WikiThreadSummary } from '../../lib/wiki-api';
import { useAuth } from '../providers/auth-context';
import { buildServerWikiToolPath } from '../../lib/wiki-routes.mjs';
import { countWikiDiscussionStatuses, WIKI_DISCUSSION_STATUS_FILTERS, wikiDiscussionFilterCount, wikiDiscussionMatchesStatusFilter, wikiDiscussionStatusClass, wikiDiscussionStatusLabel } from '../../lib/wiki-discussion-status.mjs';

export function WikiDiscussionClient({ pageId, returnTo }: { readonly pageId: string; readonly returnTo: string }) {
  const { account } = useAuth();
  const searchParams = useSearchParams();
  const requestedThreadId = searchParams.get('thread');
  const requestedCommentId = searchParams.get('comment');
  const [threads, setThreads] = useState<WikiThreadSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState<WikiDiscussionStatusFilter>('all');
  const [statusCounts, setStatusCounts] = useState<WikiDiscussionStatusCounts>({ total: 0, open: 0, paused: 0, closed: 0 });
  const [nextThreadCursor, setNextThreadCursor] = useState<string | null>(null);
  const [canCreateThread, setCanCreateThread] = useState(false);
  const [selected, setSelected] = useState<WikiThreadDetail | null>(null);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(requestedCommentId);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [comment, setComment] = useState('');
  const [createPollEnabled, setCreatePollEnabled] = useState(false);
  const [createPollDraft, setCreatePollDraft] = useState<PollDraft>(emptyPollDraft);
  const [replyPollEnabled, setReplyPollEnabled] = useState(false);
  const [replyPollDraft, setReplyPollDraft] = useState<PollDraft>(emptyPollDraft);
  const [pollChoices, setPollChoices] = useState<Record<string, string>>({});
  const [pollAnnouncement, setPollAnnouncement] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [loadingMoreThreads, setLoadingMoreThreads] = useState(false);
  const [liveState, setLiveState] = useState<'idle' | 'connecting' | 'connected' | 'reconnecting'>('idle');
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
  const [rawComment, setRawComment] = useState<{
    id: string;
    content: string;
  } | null>(null);
  const [moderation, setModeration] = useState<{
    commentId: string;
    status: 'normal' | 'hidden';
  } | null>(null);
  const [moderationReason, setModerationReason] = useState('');
  const prependAnchor = useRef<{ id: string; top: number } | null>(null);
  const replyTextarea = useRef<HTMLTextAreaElement | null>(null);

  function mentionAuthor(username: string) {
    const mention = `@${username} `;
    setComment((current) => current.length === 0 ? mention : `${current.replace(/\s*$/u, '')}\n${mention}`);
    requestAnimationFrame(() => {
      replyTextarea.current?.focus();
      replyTextarea.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  const applyThreadResult = useCallback((result: WikiThreadListResponse) => {
    const compatibleItems = result.statusCounts
      ? result.items
      : result.items.filter((thread) => wikiDiscussionMatchesStatusFilter(thread.status, statusFilter));
    setThreads(compatibleItems);
    setNextThreadCursor(result.nextCursor);
    setStatusCounts(result.statusCounts ?? countWikiDiscussionStatuses(result.items));
  }, [statusFilter]);

  async function refreshThreadList() {
    applyThreadResult(await fetchWikiThreads(pageId, undefined, statusFilter));
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void Promise.all([fetchWikiThreads(pageId, undefined, statusFilter), fetchWikiDiscussionPermissions(pageId)])
      .then(async ([result, permissions]) => {
        if (!active) return;
        applyThreadResult(result);
        setCanCreateThread(permissions.canCreateThread);
        if (requestedThreadId) {
          const detail = await fetchWikiThread(requestedThreadId, undefined, requestedCommentId ?? undefined);
          if (!active) return;
          if (detail.pageId !== pageId) throw new Error('이 문서의 토론이 아닙니다.');
          setSelected(detail);
          setActiveCommentId(requestedCommentId);
        }
      })
      .catch((caught) => {
        if (active) setError(message(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [applyThreadResult, pageId, requestedCommentId, requestedThreadId, statusFilter]);

  useEffect(() => {
    const threadId = selected?.id;
    if (!threadId || typeof EventSource === 'undefined') {
      setLiveState('idle');
      return;
    }
    let active = true;
    let refreshRunning = false;
    let refreshPending = false;
    setLiveState('connecting');

    const refreshFromLiveEvent = async () => {
      if (refreshRunning) {
        refreshPending = true;
        return;
      }
      refreshRunning = true;
      try {
        do {
          refreshPending = false;
          const [detail, list] = await Promise.all([
            fetchWikiThread(threadId),
            fetchWikiThreads(pageId, undefined, statusFilter),
          ]);
          if (!active) return;
          applyThreadResult(list);
          if (detail.pageId !== pageId) {
            setSelected(null);
            setThreadInUrl(null);
            setError('토론이 다른 문서로 이동되어 목록을 새로 불러왔습니다.');
            return;
          }
          setSelected((current) => (current?.id === threadId ? detail : current));
        } while (active && refreshPending);
      } catch (caught) {
        if (!active) return;
        if (caught instanceof WikiApiError && caught.statusCode === 404) {
          setSelected(null);
          setThreads((current) => current.filter((thread) => thread.id !== threadId));
          setThreadInUrl(null);
          setError('이 토론을 더 이상 열람할 수 없거나 삭제되었습니다.');
        } else {
          setError(message(caught));
        }
      } finally {
        refreshRunning = false;
      }
    };

    const source = new EventSource(wikiDiscussionEventsUrl(threadId), { withCredentials: true });
    const invalidate = () => void refreshFromLiveEvent();
    source.addEventListener('sync', invalidate);
    source.addEventListener('invalidate', invalidate);
    source.onopen = () => {
      if (active) setLiveState('connected');
    };
    source.onerror = () => {
      if (!active) return;
      setLiveState('reconnecting');
      void refreshFromLiveEvent();
    };
    return () => {
      active = false;
      refreshPending = false;
      source.close();
      setLiveState('idle');
    };
  }, [applyThreadResult, pageId, selected?.id, statusFilter]);

  useEffect(() => {
    if (!selected || !activeCommentId) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`comment-${activeCommentId}`);
      target?.scrollIntoView({ block: 'center' });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeCommentId, selected]);

  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    if (!anchor) return;
    prependAnchor.current = null;
    const target = document.getElementById(`comment-${anchor.id}`);
    if (target) window.scrollBy({ top: target.getBoundingClientRect().top - anchor.top });
  }, [selected?.comments]);

  async function open(thread: WikiThreadSummary, focusCommentId?: string) {
    setLoading(true);
    setError(null);
    setRawComment(null);
    setModeration(null);
    setModerationReason('');
    try {
      setSelected(await fetchWikiThread(thread.id, undefined, focusCommentId));
      setActiveCommentId(focusCommentId ?? null);
      setThreadInUrl(thread.id, focusCommentId);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setLoading(false);
    }
  }

  async function loadMoreThreads() {
    if (!nextThreadCursor) return;
    setLoadingMoreThreads(true);
    setError(null);
    try {
      const result = await fetchWikiThreads(pageId, nextThreadCursor, statusFilter);
      const compatibleItems = result.statusCounts
        ? result.items
        : result.items.filter((thread) => wikiDiscussionMatchesStatusFilter(thread.status, statusFilter));
      setThreads((current) => [...current, ...compatibleItems.filter((thread) => !current.some((item) => item.id === thread.id))]);
      setNextThreadCursor(result.nextCursor);
      if (result.statusCounts) setStatusCounts(result.statusCounts);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setLoadingMoreThreads(false);
    }
  }

  function closeThread() {
    setSelected(null);
    setRawComment(null);
    setModeration(null);
    setModerationReason('');
    setActiveCommentId(null);
    setThreadInUrl(null);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setError(null);
    try {
      const thread = await createWikiThread({
        pageId,
        title,
        content,
        poll: createPollEnabled ? toPollInput(createPollDraft) : undefined,
      });
      setSelected(thread);
      await refreshThreadList();
      setTitle('');
      setContent('');
      setCreatePollEnabled(false);
      setCreatePollDraft(emptyPollDraft());
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  }

  async function reply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setWorking(true);
    setError(null);
    try {
      const thread = await addWikiThreadComment({
        threadId: selected.id,
        content: comment,
        poll: replyPollEnabled ? toPollInput(replyPollDraft) : undefined,
      });
      setSelected(thread);
      setComment('');
      setReplyPollEnabled(false);
      setReplyPollDraft(emptyPollDraft());
      setThreads((current) => current.map((item) => (item.id === thread.id ? thread : item)));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  }

  async function castPollVote(poll: WikiDiscussionPollDetail) {
    if (!selected) return;
    const optionId = pollChoices[poll.id] ?? poll.selectedOptionId;
    if (!optionId) {
      setError('선택지를 하나 골라 주세요.');
      return;
    }
    setWorking(true);
    setError(null);
    setPollAnnouncement('');
    try {
      const thread = await voteWikiDiscussionPoll({ threadId: selected.id, pollId: poll.id, optionId });
      setSelected(thread);
      setPollAnnouncement('투표가 반영되었습니다. 선택은 마감 전까지 변경할 수 있습니다.');
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  }

  async function closePoll(poll: WikiDiscussionPollDetail) {
    if (!selected || !window.confirm('이 설문을 지금 마감할까요? 마감 후에는 다시 열 수 없습니다.')) return;
    setWorking(true);
    setError(null);
    setPollAnnouncement('');
    try {
      const thread = await closeWikiDiscussionPoll({ threadId: selected.id, pollId: poll.id });
      setSelected(thread);
      setPollAnnouncement('설문을 마감했습니다.');
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  }

  async function changeStatus(status: WikiDiscussionStatus) {
    if (!selected) return;
    setWorking(true);
    setError(null);
    try {
      const thread = await setWikiThreadStatus({
        threadId: selected.id,
        status,
      });
      setSelected(thread);
      await refreshThreadList();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  }

  async function toggleSubscription() {
    if (!selected) return;
    setWorking(true);
    setError(null);
    try {
      const result = await setWikiThreadSubscription(selected.id, !selected.subscribed);
      setSelected((current) => (current ? { ...current, subscribed: result.subscribed } : current));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  }

  async function saveTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setWorking(true);
    setError(null);
    try {
      const thread = await updateWikiThreadTopic(selected.id, topicDraft);
      setSelected(thread);
      setThreads((current) => current.map((item) => (item.id === thread.id ? thread : item)));
      setEditingTopic(false);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  }

  async function togglePinnedComment(commentId: string) {
    if (!selected) return;
    setWorking(true);
    setError(null);
    try {
      setSelected(await setWikiThreadPinnedComment(selected.id, selected.pinnedCommentId === commentId ? null : commentId));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  }

  async function removeComment(commentId: string) {
    if (!selected || !window.confirm('이 댓글을 삭제하시겠습니까?')) return;
    setWorking(true);
    setError(null);
    try {
      const thread = await deleteWikiThreadComment({
        threadId: selected.id,
        commentId,
      });
      setSelected(thread);
      setThreads((current) => current.map((item) => (item.id === thread.id ? thread : item)));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  }

  async function showRawComment(commentId: string) {
    if (!selected) return;
    if (rawComment?.id === commentId) {
      setRawComment(null);
      return;
    }
    setWorking(true);
    setError(null);
    try {
      setRawComment({
        id: commentId,
        content: await fetchWikiThreadCommentRaw(selected.id, commentId),
      });
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  }

  async function changeCommentVisibility(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !moderation) return;
    setWorking(true);
    setError(null);
    try {
      const thread = await setWikiThreadCommentVisibility({
        threadId: selected.id,
        commentId: moderation.commentId,
        status: moderation.status,
        reason: moderationReason,
      });
      setSelected(thread);
      setThreads((current) => current.map((item) => (item.id === thread.id ? thread : item)));
      if (rawComment?.id === moderation.commentId) setRawComment(null);
      setModeration(null);
      setModerationReason('');
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  }

  async function searchMoveTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!moveQuery.trim()) return;
    setWorking(true);
    setError(null);
    try {
      const result = await searchWiki({ q: moveQuery.trim(), limit: 10 });
      setMoveResults(result.items.filter((item) => item.pageId !== pageId));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  }

  async function moveSelectedThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !movePageId) return;
    setWorking(true);
    setError(null);
    try {
      const moved = await moveWikiThread({
        threadId: selected.id,
        pageId: movePageId,
        reason: moveReason.trim() || undefined,
      });
      setThreads((current) => current.filter((item) => item.id !== moved.id));
      const target = moveTarget;
      if (target) window.location.assign(discussionHref(target, moved.id));
      else window.location.assign(`/wiki/discuss/${encodeURIComponent(movePageId)}?thread=${encodeURIComponent(moved.id)}`);
    } catch (caught) {
      setError(message(caught));
      setWorking(false);
    }
  }

  async function removeSelectedThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || deleteConfirmation !== selected.title) {
      setError(`확인란에 “${selected?.title ?? ''}”을 정확히 입력해 주세요.`);
      return;
    }
    if (!window.confirm('이 토론 전체를 삭제할까요? 목록에서는 즉시 숨겨지고 감사 기록은 유지됩니다.')) return;
    setWorking(true);
    setError(null);
    try {
      await deleteWikiThread(selected.id, deleteReason);
      setSelected(null);
      setThreadInUrl(null);
      setDeleteReason('');
      setDeleteConfirmation('');
      await refreshThreadList();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  }

  async function loadOlderComments() {
    const cursor = selected?.olderCommentCursor ?? selected?.nextCommentCursor;
    if (!selected || !cursor) return;
    setLoadingOlder(true);
    setError(null);
    try {
      const first = selected.comments[0];
      const element = first ? document.getElementById(`comment-${first.id}`) : null;
      if (first && element)
        prependAnchor.current = {
          id: first.id,
          top: element.getBoundingClientRect().top,
        };
      const older = await fetchWikiThread(selected.id, cursor);
      setSelected((current) =>
        current?.id === older.id
          ? {
              ...current,
              comments: [...older.comments, ...current.comments.filter((comment) => !older.comments.some((item) => item.id === comment.id))],
              olderCommentCursor: older.olderCommentCursor,
              nextCommentCursor: older.nextCommentCursor,
            }
          : current,
      );
    } catch (caught) {
      setError(message(caught));
    } finally {
      setLoadingOlder(false);
    }
  }

  async function loadNewerComments() {
    if (!selected?.newerCommentCursor) return;
    setLoadingNewer(true);
    setError(null);
    try {
      const newer = await fetchWikiThread(selected.id, selected.newerCommentCursor, undefined, 'newer');
      setSelected((current) =>
        current?.id === newer.id
          ? {
              ...current,
              comments: [...current.comments, ...newer.comments.filter((comment) => !current.comments.some((item) => item.id === comment.id))],
              newerCommentCursor: newer.newerCommentCursor,
            }
          : current,
      );
    } catch (caught) {
      setError(message(caught));
    } finally {
      setLoadingNewer(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <Link href={returnTo} className="hover:text-emerald-200">
          문서로 돌아가기
        </Link>
        <span>/</span>
        <span className="text-slate-200">토론</span>
      </nav>
      <header className="border-b border-white/10 pb-6">
        <h1 className="flex items-center gap-3 text-3xl font-bold text-white">
          <MessagesSquare className="size-7 text-emerald-300" /> 문서 토론
        </h1>
        <p className="mt-3 text-sm text-slate-400">문서 내용과 편집 방향을 공개적으로 논의합니다.</p>
      </header>
      {error ? (
        <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">
          {error}
        </p>
      ) : null}
      <p className="sr-only" aria-live="polite">{pollAnnouncement}</p>
      <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className={`space-y-4 ${selected ? 'hidden lg:block' : ''}`}>
          {account && canCreateThread ? (
            <details className="border border-white/10 bg-[#111821] p-4">
              <summary className="cursor-pointer font-semibold text-white">새 토론</summary>
              <form onSubmit={create} className="mt-4 space-y-3">
                <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={255} placeholder="토론 제목" aria-label="토론 제목" className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" />
                <textarea value={content} onChange={(event) => setContent(event.target.value)} required maxLength={10000} rows={5} placeholder="첫 의견" aria-label="첫 의견" className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" />
                <PollComposer enabled={createPollEnabled} onEnabledChange={setCreatePollEnabled} draft={createPollDraft} onDraftChange={setCreatePollDraft} compact />
                <button disabled={working} className="btn-primary inline-flex items-center gap-2">
                  <MessageSquarePlus className="size-4" /> 토론 만들기
                </button>
              </form>
            </details>
          ) : account ? (
            <p className="border border-white/10 bg-[#111821] p-4 text-sm leading-6 text-slate-400">
              이 문서에서는 새 토론을 만들 수 없습니다. 기존 토론의 참여 권한은 각 토론의 ACL과 현재 상태에 따라 결정됩니다.
            </p>
          ) : (
            <p className="text-sm text-slate-500">
              <Link href={`/login?returnTo=${encodeURIComponent(locationPath(pageId, returnTo))}`} className="text-emerald-300">
                로그인
              </Link>
              하면 토론에 참여할 수 있습니다.
            </p>
          )}
          <nav aria-label="토론 상태 필터" className="overflow-x-auto border border-white/10 bg-[#111821] p-2">
            <div className="flex min-w-max gap-2">
              {WIKI_DISCUSSION_STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  aria-pressed={statusFilter === filter.value}
                  disabled={loading}
                  onClick={() => setStatusFilter(filter.value as WikiDiscussionStatusFilter)}
                  className={`chip min-h-11 gap-1.5 ${statusFilter === filter.value ? 'chip-accent' : 'chip-muted'}`}
                >
                  {filter.label}
                  <span aria-label={`${wikiDiscussionFilterCount(statusCounts, filter.value).toLocaleString('ko-KR')}개`}>
                    {wikiDiscussionFilterCount(statusCounts, filter.value).toLocaleString('ko-KR')}
                  </span>
                </button>
              ))}
            </div>
          </nav>
          <section className="divide-y divide-white/10 border border-white/10 bg-[#111821]">
            {threads.map((thread) => (
              <article key={thread.id} className={`transition hover:bg-white/[0.03] ${selected?.id === thread.id ? 'bg-emerald-400/10' : ''}`}>
                <button type="button" onClick={() => void open(thread)} className="block min-h-16 w-full p-4 text-left">
                  <span className="font-semibold text-white">{thread.title}</span>
                  <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className={`chip ${wikiDiscussionStatusClass(thread.status)}`}>{wikiDiscussionStatusLabel(thread.status)}</span>
                    <span>댓글 {thread.commentCount}</span>
                  </span>
                </button>
                {thread.preview && thread.preview.firstComment ? (
                  <div className="mx-3 mb-3 border border-white/[0.08] bg-black/10 text-xs">
                    {[thread.preview.firstComment].map((preview) => (
                      <button key={preview.id} type="button" onClick={() => void open(thread, preview.id)} className="block w-full p-3 text-left hover:bg-white/[0.035]">
                        <span className="font-semibold text-emerald-200">#{preview.id}</span>
                        <span className="ml-2 text-slate-500">{preview.createdByName} · {formatDate(preview.createdAt)}</span>
                        <span className="mt-1.5 line-clamp-3 break-words text-sm leading-5 text-slate-300">{previewText(preview.status, preview.contentPreview, preview.truncated)}</span>
                      </button>
                    ))}
                    {thread.preview.omittedCommentCount > 0 ? (
                      <button type="button" onClick={() => void open(thread)} className="block min-h-10 w-full border-y border-white/[0.08] px-3 text-left font-semibold text-slate-500 hover:bg-white/[0.035] hover:text-emerald-200">
                        중간 {thread.preview.omittedCommentCount.toLocaleString('ko-KR')}개 댓글 더 보기
                      </button>
                    ) : null}
                    {thread.preview.recentComments.map((preview) => (
                      <button key={preview.id} type="button" onClick={() => void open(thread, preview.id)} className="block w-full border-t border-white/[0.06] p-3 text-left first:border-t-0 hover:bg-white/[0.035]">
                        <span className="font-semibold text-emerald-200">#{preview.id}</span>
                        <span className="ml-2 text-slate-500">{preview.createdByName} · {formatDate(preview.createdAt)}</span>
                        <span className="mt-1.5 line-clamp-3 break-words text-sm leading-5 text-slate-300">{previewText(preview.status, preview.contentPreview, preview.truncated)}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
            {!loading && threads.length === 0 ? <p className="p-4 text-sm text-slate-500">{statusCounts.total > 0 ? '선택한 상태의 토론이 없습니다.' : '아직 토론이 없습니다.'}</p> : null}
            {nextThreadCursor ? (
              <button type="button" disabled={loadingMoreThreads} onClick={() => void loadMoreThreads()} className="flex min-h-12 w-full items-center justify-center gap-2 p-3 text-sm font-semibold text-emerald-200 hover:bg-white/[0.03]">
                {loadingMoreThreads ? <Loader2 className="size-4 animate-spin" /> : null} 더 오래된 토론 보기
              </button>
            ) : null}
          </section>
        </aside>
        <section className={`min-w-0 ${selected ? '' : 'hidden lg:block'}`}>
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 className="size-4 animate-spin" /> 불러오는 중입니다.
            </p>
          ) : null}
          {selected ? (
            <div className="space-y-4">
              <button type="button" onClick={closeThread} className="inline-flex min-h-11 items-center gap-2 text-sm text-slate-300 lg:hidden">
                <ArrowLeft className="size-4" /> 토론 목록
              </button>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-4">
                <div className="min-w-0 flex-1">
                  {editingTopic ? (
                    <form onSubmit={saveTopic} className="flex flex-col gap-2 sm:flex-row">
                      <input value={topicDraft} onChange={(event) => setTopicDraft(event.target.value)} required maxLength={255} aria-label="토론 제목" className="min-h-11 min-w-0 flex-1 rounded-md border border-white/10 bg-black/20 px-3 text-white" />
                      <button disabled={working} className="btn-primary min-h-11">
                        저장
                      </button>
                      <button type="button" onClick={() => setEditingTopic(false)} className="btn-secondary min-h-11">
                        취소
                      </button>
                    </form>
                  ) : (
                    <h2 className="break-words text-2xl font-bold text-white">{selected.title}</h2>
                  )}
                  <p className="mt-2 text-xs text-slate-500">
                    {selected.createdByName} · {wikiDiscussionStatusLabel(selected.status)} · 댓글 {selected.commentCount.toLocaleString('ko-KR')}개
                    <span className="ml-2 inline-flex items-center gap-1.5" role="status">
                      <span aria-hidden="true" className={`size-1.5 rounded-full ${liveState === 'connected' ? 'bg-emerald-300' : 'bg-amber-300'}`} />
                      {liveState === 'connected' ? '실시간 연결됨' : liveState === 'reconnecting' ? '실시간 재연결 중' : '실시간 연결 중'}
                    </span>
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {account ? (
                    <button type="button" disabled={working} onClick={() => void toggleSubscription()} className="chip chip-muted inline-flex min-h-11 items-center gap-2">
                      {selected.subscribed ? <BellOff className="size-4" /> : <Bell className="size-4" />}
                      {selected.subscribed ? '알림 끄기' : '알림 받기'}
                    </button>
                  ) : null}
                  {selected.canModerate && !editingTopic ? (
                    <button
                      type="button"
                      onClick={() => {
                        setTopicDraft(selected.title);
                        setEditingTopic(true);
                      }}
                      className="chip chip-muted inline-flex min-h-11 items-center gap-2"
                    >
                      <Pencil className="size-4" /> 제목 변경
                    </button>
                  ) : null}
                  {selected.canManageAcl ? <Link href={`/wiki/discussions/${encodeURIComponent(selected.id)}/acl?returnTo=${encodeURIComponent(selectedThreadPath(pageId, returnTo, selected.id))}`} className="chip chip-muted inline-flex min-h-11 items-center gap-2">
                    <ShieldCheck className="size-3.5" /> 토론 ACL
                  </Link> : null}
                  {selected.canManagePage ? (
                    <>
                      {selected.status !== 'open' ? <button type="button" disabled={working} onClick={() => void changeStatus('open')} className="chip chip-muted min-h-11">다시 열기</button> : null}
                      {selected.status !== 'paused' ? <button type="button" disabled={working} onClick={() => void changeStatus('paused')} className="chip min-h-11 border-amber-300/30 bg-amber-300/10 text-amber-100"><Pause className="size-3.5" /> 일시 중지</button> : null}
                      {selected.status !== 'closed' ? <button type="button" disabled={working} onClick={() => void changeStatus('closed')} className="chip chip-muted min-h-11">토론 닫기</button> : null}
                    </>
                  ) : selected.canModerate && (selected.status === 'open' || selected.status === 'closed') ? (
                    <button type="button" disabled={working} onClick={() => void changeStatus(selected.status === 'open' ? 'closed' : 'open')} className="chip chip-muted min-h-11">
                      {selected.status === 'open' ? '토론 닫기' : '다시 열기'}
                    </button>
                  ) : null}
                </div>
              </div>
              {selected.status === 'paused' ? (
                <div role="status" className="flex items-start gap-3 border border-amber-300/25 bg-amber-300/[0.06] p-4 text-sm leading-6 text-amber-100">
                  <Pause className="mt-1 size-4 shrink-0" />
                  <p>문서 관리자가 토론을 일시 중지했습니다. 기존 댓글과 설문 결과는 읽을 수 있지만 새 댓글과 투표는 재개될 때까지 받지 않습니다.</p>
                </div>
              ) : selected.status === 'closed' ? (
                <p role="status" className="border border-white/10 bg-white/[0.025] p-4 text-sm leading-6 text-slate-400">닫힌 토론입니다. 기존 내용은 계속 읽을 수 있습니다.</p>
              ) : null}
              {selected.canManagePage ? (
                <details className="surface-flat p-4">
                  <summary className="cursor-pointer text-sm font-semibold text-slate-200">토론 관리</summary>
                  <div className="mt-4 grid gap-5 xl:grid-cols-2">
                    <div>
                      <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
                        <FileInput className="size-4 text-emerald-300" /> 다른 문서로 이동
                      </h3>
                      <form onSubmit={searchMoveTarget} className="mt-3 flex gap-2">
                        <input value={moveQuery} onChange={(event) => setMoveQuery(event.target.value)} required placeholder="대상 문서 검색" aria-label="대상 문서 검색" className="min-h-11 min-w-0 flex-1 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white" />
                        <button disabled={working} className="btn-secondary min-h-11 gap-2">
                          <Search className="size-4" /> 검색
                        </button>
                      </form>
                      {moveResults.length > 0 ? (
                        <div className="mt-2 max-h-48 overflow-y-auto border border-white/10">
                          {moveResults.map((result) => (
                            <button
                              key={result.pageId}
                              type="button"
                              onClick={() => {
                                setMovePageId(result.pageId);
                                setMoveTarget(result);
                              }}
                              className={`block w-full border-b border-white/10 px-3 py-2 text-left text-sm last:border-0 ${movePageId === result.pageId ? 'bg-emerald-300/10 text-emerald-200' : 'text-slate-300 hover:bg-white/[0.04]'}`}
                            >
                              <span className="block font-semibold">{result.displayTitle}</span>
                              <span className="mt-1 block truncate text-xs text-slate-500">
                                {result.routePath} · #{result.pageId}
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                      <form onSubmit={moveSelectedThread} className="mt-3 space-y-2">
                        <input
                          value={movePageId}
                          onChange={(event) => {
                            setMovePageId(event.target.value);
                            setMoveTarget(null);
                          }}
                          pattern="[0-9]+"
                          inputMode="numeric"
                          required
                          placeholder="대상 문서 ID"
                          aria-label="대상 문서 ID"
                          className="min-h-11 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
                        />
                        <input value={moveReason} onChange={(event) => setMoveReason(event.target.value)} maxLength={1000} placeholder="이동 사유" aria-label="이동 사유" className="min-h-11 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white" />
                        <button disabled={working || !movePageId} className="btn-primary min-h-11 gap-2">
                          <FileInput className="size-4" /> 토론 이동
                        </button>
                      </form>
                    </div>
                    <form onSubmit={removeSelectedThread} className="border-t border-red-300/15 pt-5 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
                      <h3 className="flex items-center gap-2 text-sm font-semibold text-red-200">
                        <Trash2 className="size-4" /> 토론 전체 삭제
                      </h3>
                      <p className="mt-2 text-xs leading-5 text-slate-500">댓글을 포함한 토론을 공개 목록에서 숨기고 변경 기록을 남깁니다.</p>
                      <input value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} required maxLength={1000} placeholder="삭제 사유" aria-label="토론 삭제 사유" className="mt-3 min-h-11 w-full rounded-md border border-red-300/20 bg-black/20 px-3 text-sm text-white" />
                      <input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} required placeholder={selected.title} aria-label="토론 제목 확인" className="mt-2 min-h-11 w-full rounded-md border border-red-300/20 bg-black/20 px-3 text-sm text-white" />
                      <button disabled={working} className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-md border border-red-300/30 px-4 text-sm font-semibold text-red-200 hover:bg-red-300/10">
                        <Trash2 className="size-4" /> 전체 삭제
                      </button>
                    </form>
                  </div>
                </details>
              ) : null}
              {(selected.olderCommentCursor ?? selected.nextCommentCursor) ? (
                <button type="button" disabled={loadingOlder} onClick={() => void loadOlderComments()} className="chip chip-muted mx-auto flex min-h-11 items-center gap-2">
                  {loadingOlder ? <Loader2 className="size-4 animate-spin" /> : null} 이전 댓글 더 보기
                </button>
              ) : null}
              {selected.moderationHistoryTruncated ? (
                <p role="status" className="border border-amber-300/20 bg-amber-300/[0.04] px-4 py-3 text-xs leading-5 text-amber-100">
                  최근 조정 기록 500건만 표시합니다. 전체 감사 기록은 서버에 계속 보존됩니다.
                </p>
              ) : null}
              {selected.comments.map((item) => item.entryType === 'system' && item.systemEvent ? (
                <article id={`comment-${item.id}`} tabIndex={-1} data-highlighted={item.id === requestedCommentId || undefined} key={item.id} className="border-l-2 border-emerald-300/35 bg-emerald-300/[0.035] px-4 py-3 outline-none data-[highlighted=true]:border-emerald-300 data-[highlighted=true]:bg-emerald-300/10 sm:px-5">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="flex min-w-0 items-start gap-2 text-sm leading-6 text-slate-300">
                      <History aria-hidden="true" className="mt-1 size-4 shrink-0 text-emerald-300" />
                      <span className="[overflow-wrap:anywhere]">{discussionSystemEventLabel(item.systemEvent)}</span>
                    </p>
                    <p className="flex shrink-0 flex-wrap items-center gap-x-2 text-xs text-slate-500">
                      <Link href={userDocumentHref(item.createdByUsername, item.createdBy)} className="hover:text-emerald-200">{item.createdByName}</Link>
                      <time>{formatDate(item.createdAt)}</time>
                    </p>
                  </div>
                </article>
              ) : (
                <article id={`comment-${item.id}`} tabIndex={-1} data-highlighted={item.id === requestedCommentId || undefined} key={item.id} className={`border p-4 outline-none data-[highlighted=true]:border-emerald-300/60 data-[highlighted=true]:bg-emerald-300/10 ${item.status === 'hidden' ? 'border-amber-300/30 bg-amber-300/[0.04]' : item.pinned ? 'border-amber-300/50 bg-[#111821]' : 'border-white/10 bg-[#111821]'}`}>
                  <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
                    <span className="flex items-center gap-2">
                      {item.pinned ? (
                        <span className="inline-flex items-center gap-1 text-amber-200">
                          <Pin className="size-3.5" /> 고정됨
                        </span>
                      ) : null}
                      <Link href={userDocumentHref(item.createdByUsername, item.createdBy)} className="hover:text-emerald-200">
                        {item.createdByName}
                      </Link>
                      {selected.canReply && item.createdByUsername ? (
                        <button type="button" onClick={() => mentionAuthor(item.createdByUsername!)} className="inline-flex min-h-11 items-center gap-1 hover:text-emerald-200" aria-label={`${item.createdByName}님에게 답글`}>
                          <Reply className="size-3.5" /> 답글
                        </button>
                      ) : null}
                    </span>
                    <span className="flex flex-wrap items-center gap-3">
                      <time>{formatDate(item.createdAt)}</time>
                      {item.status === 'normal' || item.canChangeVisibility ? (
                        <button type="button" disabled={working} onClick={() => void showRawComment(item.id)} className="inline-flex min-h-11 items-center gap-1 hover:text-emerald-200">
                          <Code2 className="size-3.5" /> {rawComment?.id === item.id ? '원문 닫기' : '원문'}
                        </button>
                      ) : null}
                      {selected.canModerate && item.status === 'normal' ? (
                        <button type="button" disabled={working} onClick={() => void togglePinnedComment(item.id)} className="inline-flex min-h-11 items-center gap-1 hover:text-amber-200">
                          <Pin className="size-3.5" /> {item.pinned ? '고정 해제' : '고정'}
                        </button>
                      ) : null}
                      {item.canChangeVisibility ? (
                        <button
                          type="button"
                          disabled={working}
                          aria-expanded={moderation?.commentId === item.id}
                          onClick={() => {
                            setModeration({
                              commentId: item.id,
                              status: item.status === 'hidden' ? 'normal' : 'hidden',
                            });
                            setModerationReason('');
                          }}
                          className={`inline-flex min-h-11 items-center gap-1 ${item.status === 'hidden' ? 'text-emerald-300 hover:text-emerald-200' : 'text-slate-500 hover:text-amber-200'}`}
                        >
                          {item.status === 'hidden' ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                          {item.status === 'hidden' ? '복구' : '숨기기'}
                        </button>
                      ) : null}
                      {item.canDelete ? (
                        <button type="button" disabled={working} onClick={() => void removeComment(item.id)} className="inline-flex min-h-11 items-center gap-1 text-slate-500 hover:text-red-200">
                          <Trash2 className="size-3.5" /> 삭제
                        </button>
                      ) : null}
                    </span>
                  </div>
                  <p className="mt-3 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 text-slate-200">
                    {item.content ? <DiscussionCommentContent content={item.content} mentions={item.mentions ?? []} /> : (item.status === 'hidden' ? '관리자에 의해 숨겨진 댓글입니다.' : '삭제된 댓글입니다.')}
                  </p>
                  {item.poll ? (
                    <DiscussionPollCard
                      poll={item.poll}
                      selectedOptionId={pollChoices[item.poll.id] ?? item.poll.selectedOptionId}
                      working={working}
                      onSelect={(optionId) => setPollChoices((current) => ({ ...current, [item.poll!.id]: optionId }))}
                      onVote={() => void castPollVote(item.poll!)}
                      onClose={() => void closePoll(item.poll!)}
                    />
                  ) : null}
                  {rawComment?.id === item.id ? <pre className="mt-3 overflow-x-auto whitespace-pre-wrap border-t border-white/10 pt-3 text-xs leading-5 text-slate-400">{rawComment.content}</pre> : null}
                  {(item.moderationHistory?.length ?? 0) > 0 ? (
                    <details className="mt-4 border-t border-amber-300/20 pt-4">
                      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs font-semibold text-amber-100 marker:content-none">
                        <History className="size-4" /> 조정 기록 {item.moderationHistory?.length ?? 0}건
                      </summary>
                      <ol className="mt-2 space-y-2" aria-label={`댓글 ${item.id} 조정 기록`}>
                        {item.moderationHistory?.map((entry) => (
                          <li key={entry.id} className="border-l-2 border-amber-300/25 pl-3 text-xs leading-5 text-slate-400">
                            <div className="flex flex-wrap items-center gap-x-2">
                              <span className={entry.action === 'hide' ? 'font-semibold text-amber-200' : 'font-semibold text-emerald-200'}>
                                {entry.action === 'hide' ? '숨김' : '복구'}
                              </span>
                              <Link href={`/wiki/contributions/${entry.actorProfileId}`} className="hover:text-emerald-200">
                                {entry.actorProfileName}
                              </Link>
                              <time>{formatDate(entry.createdAt)}</time>
                            </div>
                            <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-slate-300">{entry.reason}</p>
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}
                  {moderation?.commentId === item.id ? (
                    <form onSubmit={changeCommentVisibility} className="mt-4 border-t border-amber-300/20 pt-4">
                      <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-100">
                        {moderation.status === 'hidden' ? <EyeOff className="size-4" /> : <Eye className="size-4 text-emerald-300" />}
                        댓글 {moderation.status === 'hidden' ? '숨기기' : '복구'}
                      </h3>
                      <p className="mt-2 text-xs leading-5 text-slate-400">{moderation.status === 'hidden' ? '공개 화면에서는 내용을 가리지만 원문은 보존됩니다.' : '보존된 원문을 다시 공개합니다.'} 처리 사유와 담당자는 감사 기록에 남습니다.</p>
                      <textarea value={moderationReason} onChange={(event) => setModerationReason(event.target.value)} required minLength={3} maxLength={1000} rows={3} placeholder="처리 사유를 3자 이상 입력하세요." aria-label="댓글 공개 상태 변경 사유" className="mt-3 w-full rounded-md border border-amber-300/20 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-slate-600" />
                      <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <button
                          type="button"
                          disabled={working}
                          onClick={() => {
                            setModeration(null);
                            setModerationReason('');
                          }}
                          className="btn-secondary min-h-11 w-full sm:w-auto"
                        >
                          취소
                        </button>
                        <button disabled={working || moderationReason.trim().length < 3} className="btn-primary min-h-11 w-full sm:w-auto">
                          {working ? '처리 중…' : moderation.status === 'hidden' ? '댓글 숨기기' : '댓글 복구'}
                        </button>
                      </div>
                    </form>
                  ) : null}
                </article>
              ))}
              {selected.newerCommentCursor ? (
                <button type="button" disabled={loadingNewer} onClick={() => void loadNewerComments()} className="chip chip-muted mx-auto flex min-h-11 items-center gap-2">
                  {loadingNewer ? <Loader2 className="size-4 animate-spin" /> : null} 다음 댓글 더 보기
                </button>
              ) : null}
              {selected.canReply ? (
                <form onSubmit={reply} className="space-y-3">
                  <textarea ref={replyTextarea} value={comment} onChange={(event) => setComment(event.target.value)} required maxLength={10000} rows={5} placeholder="댓글 작성 · @사용자명으로 멘션" aria-label="토론 댓글" className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" />
                  <PollComposer enabled={replyPollEnabled} onEnabledChange={setReplyPollEnabled} draft={replyPollDraft} onDraftChange={setReplyPollDraft} />
                  <button disabled={working} className="btn-primary w-full sm:w-auto">
                    댓글 등록
                  </button>
                </form>
              ) : null}
            </div>
          ) : !loading ? (
            <p className="border border-white/10 p-6 text-sm text-slate-400">왼쪽에서 토론을 선택하세요.</p>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function DiscussionCommentContent({
  content,
  mentions,
}: {
  readonly content: string;
  readonly mentions: WikiThreadDetail['comments'][number]['mentions'];
}) {
  const valid = [...mentions]
    .filter((mention) => Number.isInteger(mention.start) && Number.isInteger(mention.end) && mention.start >= 0 && mention.end <= content.length && mention.start < mention.end && content.slice(mention.start, mention.end).toLocaleLowerCase('en-US') === `@${mention.username}`.toLocaleLowerCase('en-US'))
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .filter((mention, index, all) => index === 0 || mention.start >= all[index - 1]!.end);
  if (valid.length === 0) return content;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const mention of valid) {
    if (mention.start > cursor) parts.push(content.slice(cursor, mention.start));
    parts.push(
      <Link key={`${mention.start}:${mention.end}:${mention.profileId}`} href={`/user/${encodeURIComponent(mention.username)}`} className="font-semibold text-emerald-300 underline decoration-emerald-300/30 underline-offset-2 hover:text-emerald-200">
        {content.slice(mention.start, mention.end)}
      </Link>
    );
    cursor = mention.end;
  }
  if (cursor < content.length) parts.push(content.slice(cursor));
  return parts;
}

function userDocumentHref(username: string | null, profileId: string): string {
  return username ? `/user/${encodeURIComponent(username)}` : `/wiki/contributions/${profileId}`;
}

type PollDraft = {
  readonly question: string;
  readonly options: readonly string[];
  readonly resultsVisibility: WikiDiscussionPollResultsVisibility;
  readonly closesAt: string;
};

function emptyPollDraft(): PollDraft {
  return { question: '', options: ['', ''], resultsVisibility: 'after_vote', closesAt: '' };
}

function toPollInput(draft: PollDraft): WikiDiscussionPollInput {
  let closesAt: string | null = null;
  if (draft.closesAt) {
    const parsed = new Date(draft.closesAt);
    if (Number.isNaN(parsed.getTime())) throw new Error('설문 마감 시간을 확인해 주세요.');
    closesAt = parsed.toISOString();
  }
  return {
    question: draft.question,
    options: draft.options,
    resultsVisibility: draft.resultsVisibility,
    closesAt,
  };
}

function PollComposer({
  enabled,
  onEnabledChange,
  draft,
  onDraftChange,
  compact = false,
}: {
  readonly enabled: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly draft: PollDraft;
  readonly onDraftChange: (draft: PollDraft) => void;
  readonly compact?: boolean;
}) {
  if (!enabled) {
    return (
      <button type="button" onClick={() => onEnabledChange(true)} className="chip chip-muted inline-flex min-h-11 items-center gap-2">
        <BarChart3 className="size-4" /> 설문 추가
      </button>
    );
  }
  return (
    <section aria-label="댓글 설문 만들기" className="space-y-3 border border-emerald-300/20 bg-emerald-300/[0.035] p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-emerald-100">
          <BarChart3 className="size-4" /> 댓글 설문
        </h3>
        <button type="button" onClick={() => onEnabledChange(false)} className="inline-flex min-h-11 items-center gap-1 text-xs text-slate-400 hover:text-red-200">
          <X className="size-3.5" /> 제거
        </button>
      </div>
      <input
        value={draft.question}
        onChange={(event) => onDraftChange({ ...draft, question: event.target.value })}
        required
        maxLength={255}
        placeholder="설문 질문"
        aria-label="설문 질문"
        className="min-h-11 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
      />
      <div className="space-y-2">
        {draft.options.map((option, index) => (
          <div key={index} className="flex gap-2">
            <input
              value={option}
              onChange={(event) => onDraftChange({ ...draft, options: draft.options.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })}
              required
              maxLength={120}
              placeholder={`선택지 ${index + 1}`}
              aria-label={`설문 선택지 ${index + 1}`}
              className="min-h-11 min-w-0 flex-1 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
            />
            {draft.options.length > 2 ? (
              <button type="button" onClick={() => onDraftChange({ ...draft, options: draft.options.filter((_, itemIndex) => itemIndex !== index) })} aria-label={`선택지 ${index + 1} 삭제`} className="min-h-11 px-3 text-slate-500 hover:text-red-200">
                <X className="size-4" />
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {draft.options.length < 10 ? (
        <button type="button" onClick={() => onDraftChange({ ...draft, options: [...draft.options, ''] })} className="inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-emerald-200">
          <Plus className="size-3.5" /> 선택지 추가
        </button>
      ) : null}
      <div className={`grid gap-3 ${compact ? '' : 'sm:grid-cols-2'}`}>
        <label className="text-xs text-slate-400">
          결과 공개
          <select value={draft.resultsVisibility} onChange={(event) => onDraftChange({ ...draft, resultsVisibility: event.target.value as WikiDiscussionPollResultsVisibility })} className="mt-1 min-h-11 w-full rounded-md border border-white/10 bg-[#111821] px-3 text-sm text-white">
            <option value="after_vote">투표한 뒤 공개</option>
            <option value="always">항상 공개</option>
            <option value="closed">마감 뒤 공개</option>
          </select>
        </label>
        <label className="text-xs text-slate-400">
          자동 마감 (선택)
          <input type="datetime-local" value={draft.closesAt} onChange={(event) => onDraftChange({ ...draft, closesAt: event.target.value })} className="mt-1 min-h-11 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white" />
        </label>
      </div>
      <p className="text-xs leading-5 text-slate-500">단일 선택·투표자 비공개 방식입니다. 마감 전에는 선택을 변경할 수 있습니다.</p>
    </section>
  );
}

function DiscussionPollCard({
  poll,
  selectedOptionId,
  working,
  onSelect,
  onVote,
  onClose,
}: {
  readonly poll: WikiDiscussionPollDetail;
  readonly selectedOptionId: string | null;
  readonly working: boolean;
  readonly onSelect: (optionId: string) => void;
  readonly onVote: () => void;
  readonly onClose: () => void;
}) {
  const total = poll.totalVoteCount ?? 0;
  return (
    <section aria-labelledby={`poll-question-${poll.id}`} className="mt-4 border border-emerald-300/25 bg-black/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 id={`poll-question-${poll.id}`} className="flex items-center gap-2 pr-2 font-semibold text-white">
          <BarChart3 className="size-4 text-emerald-300" /> {poll.question}
        </h3>
        <span className={`chip ${poll.status === 'open' ? 'chip-success' : 'chip-muted'}`}>{poll.status === 'open' ? '진행 중' : '마감'}</span>
      </div>
      <div className="mt-4 space-y-2">
        {poll.options.map((option) => {
          const checked = selectedOptionId === option.id;
          const percentage = poll.resultsVisible && total > 0 ? Math.round(((option.voteCount ?? 0) / total) * 100) : 0;
          return (
            <label key={option.id} className={`relative block overflow-hidden border p-3 ${checked ? 'border-emerald-300/60 bg-emerald-300/10' : 'border-white/10 bg-white/[0.02]'} ${poll.canVote ? 'cursor-pointer' : ''}`}>
              {poll.resultsVisible ? <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-emerald-300/[0.08]" style={{ width: `${percentage}%` }} /> : null}
              <span className="relative flex min-w-0 items-center gap-3">
                <input type="radio" name={`poll-${poll.id}`} value={option.id} checked={checked} disabled={!poll.canVote || working} onChange={() => onSelect(option.id)} className="size-4 accent-emerald-400" />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere] text-sm text-slate-200">{option.label}</span>
                {poll.resultsVisible ? <span className="shrink-0 text-xs text-slate-400">{option.voteCount ?? 0}표 · {percentage}%</span> : null}
              </span>
            </label>
          );
        })}
      </div>
      <div className="mt-4 flex flex-col gap-3 border-t border-white/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs leading-5 text-slate-500">
          <p>투표자 비공개{poll.resultsVisible ? ` · 총 ${total}표` : ' · 결과는 아직 공개되지 않았습니다.'}</p>
          {poll.privilegedResults ? <p className="text-amber-200">문서 관리 권한으로 비공개 결과를 확인 중입니다.</p> : null}
          {poll.closesAt ? <p>자동 마감 {formatDate(poll.closesAt)}</p> : null}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          {poll.canClose ? <button type="button" disabled={working} onClick={onClose} className="btn-secondary min-h-11 w-full sm:w-auto">설문 마감</button> : null}
          {poll.canVote ? <button type="button" disabled={working || !selectedOptionId} onClick={onVote} className="btn-primary min-h-11 w-full sm:w-auto">{poll.selectedOptionId ? '선택 변경' : '투표하기'}</button> : null}
        </div>
      </div>
    </section>
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : '토론 요청에 실패했습니다.';
}
function discussionSystemEventLabel(event: NonNullable<WikiThreadDetail['comments'][number]['systemEvent']>): string {
  const protectedValue = '비공개 대상';
  const before = event.beforeRedacted ? protectedValue : event.before;
  const after = event.afterRedacted ? protectedValue : event.after;
  if (event.type === 'status_change') {
    const status = (value: string | null) => ({ open: '열림', paused: '일시 중지', closed: '닫힘' } as Record<string, string>)[value ?? ''] ?? '알 수 없음';
    return `토론 상태를 ${status(before)}에서 ${status(after)}으로 변경했습니다.`;
  }
  if (event.type === 'topic_change') return `주제를 “${before ?? '이전 주제'}”에서 “${after ?? '새 주제'}”으로 변경했습니다.`;
  if (event.type === 'page_move') return `토론 문서를 “${before ?? protectedValue}”에서 “${after ?? protectedValue}”으로 이동했습니다.`;
  if (!before && after) return `${after} 댓글을 고정했습니다.`;
  if (before && !after) return `${before} 댓글의 고정을 해제했습니다.`;
  return `고정 댓글을 ${before ?? protectedValue}에서 ${after ?? protectedValue}으로 변경했습니다.`;
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(new Date(value));
}
function locationPath(pageId: string, returnTo: string) {
  return `/wiki/discuss/${encodeURIComponent(pageId)}?returnTo=${encodeURIComponent(returnTo)}`;
}
function selectedThreadPath(pageId: string, returnTo: string, threadId: string) {
  return `${locationPath(pageId, returnTo)}&thread=${encodeURIComponent(threadId)}`;
}
function discussionHref(target: WikiSearchResult, threadId: string) {
  return target.routePath.startsWith('/server/') ? `${buildServerWikiToolPath(target.routePath, 'discuss')}?thread=${encodeURIComponent(threadId)}` : `/wiki/discuss/${encodeURIComponent(target.pageId)}?returnTo=${encodeURIComponent(target.routePath)}&thread=${encodeURIComponent(threadId)}`;
}
function setThreadInUrl(threadId: string | null, commentId?: string) {
  const url = new URL(window.location.href);
  if (threadId) url.searchParams.set('thread', threadId);
  else url.searchParams.delete('thread');
  if (threadId && commentId) url.searchParams.set('comment', commentId);
  else url.searchParams.delete('comment');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function previewText(status: string, content: string | null, truncated: boolean): string {
  if (status === 'deleted') return '삭제된 댓글입니다.';
  if (status === 'hidden' && content === null) return '숨겨진 댓글입니다.';
  if (!content) return '내용이 없는 댓글입니다.';
  return `${content}${truncated ? '…' : ''}`;
}

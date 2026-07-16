'use client';

import { Bell, CheckCheck, GitCommitHorizontal, Loader2, MailOpen, MessageSquareText, PenLine, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchWikiNotifications,
  markAllWikiNotificationsRead,
  markWikiNotificationRead,
  markWikiNotificationUnread,
  type WikiNotificationItem,
  type WikiNotificationState
} from '../../lib/wiki-api';
import { useAuth } from '../providers/auth-context';
import { WikiPushControl } from './wiki-push-control';

export function WikiNotificationsClient() {
  const { account, loading: authLoading } = useAuth();
  const [items, setItems] = useState<WikiNotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<WikiNotificationState>('all');
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!account) { setLoading(false); setInitialized(true); return; }
    setLoading(true); setError(null); setItems([]); setCursor(null);
    try {
      const result = await fetchWikiNotifications(undefined, filter);
      if (requestId !== requestIdRef.current) return;
      setItems(result.items); setUnreadCount(result.unreadCount); setCursor(result.nextCursor);
    } catch (caught) {
      if (requestId === requestIdRef.current) setError(caught instanceof Error ? caught.message : '알림을 불러오지 못했습니다.');
    } finally {
      if (requestId === requestIdRef.current) { setLoading(false); setInitialized(true); }
    }
  }, [account, filter]);

  useEffect(() => { void load(); }, [load]);

  function opened(item: WikiNotificationItem) {
    if (item.read) return;
    setItems((current) => filter === 'unread' ? current.filter((candidate) => candidate.id !== item.id) : current.map((candidate) => candidate.id === item.id ? { ...candidate, read: true } : candidate));
    setUnreadCount((current) => Math.max(0, current - 1));
    notifyCountChanged();
    void markWikiNotificationRead(item.id).catch(() => {});
  }

  async function markRead(item: WikiNotificationItem) {
    setWorking(true); setError(null);
    try {
      await markWikiNotificationRead(item.id);
      setItems((current) => filter === 'unread' ? current.filter((candidate) => candidate.id !== item.id) : current.map((candidate) => candidate.id === item.id ? { ...candidate, read: true } : candidate));
      setUnreadCount((current) => Math.max(0, current - 1));
      notifyCountChanged();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '알림을 읽음 처리하지 못했습니다.'); }
    finally { setWorking(false); }
  }

  async function markAll() {
    const throughId = items[0]?.id;
    if (!throughId) return;
    setWorking(true); setError(null);
    try {
      await markAllWikiNotificationsRead(throughId);
      setItems((current) => current.map((item) => ({ ...item, read: true })));
      setUnreadCount(0);
      notifyCountChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '알림을 읽음 처리하지 못했습니다.');
    } finally { setWorking(false); }
  }

  async function markUnread(item: WikiNotificationItem) {
    setWorking(true); setError(null);
    try {
      await markWikiNotificationUnread(item.id);
      setItems((current) => filter === 'read' ? current.filter((candidate) => candidate.id !== item.id) : current.map((candidate) => candidate.id === item.id ? { ...candidate, read: false } : candidate));
      setUnreadCount((current) => current + 1);
      notifyCountChanged();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '알림을 읽지 않음으로 되돌리지 못했습니다.'); }
    finally { setWorking(false); }
  }

  async function loadMore() {
    if (!cursor) return;
    setWorking(true); setError(null);
    try {
      const result = await fetchWikiNotifications(cursor, filter);
      setItems((current) => [...current, ...result.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setUnreadCount(result.unreadCount); setCursor(result.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '다음 알림을 불러오지 못했습니다.');
    } finally { setWorking(false); }
  }

  if (authLoading || (loading && !initialized)) return <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 알림을 불러오는 중입니다.</p>;
  if (!account) return <p className="text-sm text-slate-300"><Link href="/login?returnTo=%2Fwiki%2Fnotifications" className="text-emerald-300 hover:underline">로그인</Link>하면 관심 문서와 토론 활동 알림을 확인할 수 있습니다.</p>;

  return <div className="space-y-4">
    <WikiPushControl />
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-slate-400">읽지 않은 알림 <strong className="text-emerald-300">{unreadCount.toLocaleString('ko-KR')}</strong>개</p>
      <button type="button" disabled={working || loading || unreadCount === 0 || filter === 'read'} onClick={() => void markAll()} className="chip chip-muted inline-flex min-h-11 items-center gap-1.5 px-3 disabled:opacity-40"><CheckCheck className="size-4" /> 모두 읽음</button>
    </div>
    <div className="flex flex-wrap gap-2" aria-label="알림 상태 필터">{(['all', 'unread', 'read'] as const).map((state) => <button key={state} type="button" disabled={loading || working} onClick={() => setFilter(state)} className={`chip min-h-11 px-3 ${filter === state ? 'chip-accent' : 'chip-muted'}`}>{state === 'all' ? '전체' : state === 'unread' ? '읽지 않음' : '읽음'}</button>)}</div>
    {loading ? <p role="status" className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 알림을 업데이트하는 중입니다.</p> : null}
    {error && items.length > 0 ? <p role="alert" className="border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100">{error}</p> : null}
    {loading ? null : error && items.length === 0 ? <div role="alert" className="border border-red-300/30 bg-red-300/10 p-5 text-sm text-red-100"><p>{error}</p><button type="button" onClick={() => void load()} className="chip chip-muted mt-4 min-h-11 px-3">다시 시도</button></div> : items.length === 0 ? <div className="border border-dashed border-white/15 p-10 text-center"><Bell className="mx-auto size-7 text-slate-600" /><p className="mt-3 text-sm text-slate-400">{filter === 'all' ? '새 알림이 없습니다.' : filter === 'unread' ? '읽지 않은 알림이 없습니다.' : '읽은 알림이 없습니다.'}</p></div> : <ol className="divide-y divide-white/[0.07] border border-white/10 bg-[#0d1219]">
      {items.map((item) => <li key={item.id} className={`relative ${item.read ? 'bg-transparent' : 'bg-emerald-300/[0.045]'}`}>
        <Link href={item.href} onClick={() => opened(item)} className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-3 p-4 pb-16 text-left transition hover:bg-white/[0.035] sm:p-5 sm:pr-36">
          <span className={`mt-0.5 flex size-9 items-center justify-center rounded-full ${item.read ? 'bg-white/[0.05] text-slate-500' : 'bg-emerald-300/10 text-emerald-300'}`}>{notificationIcon(item.type)}</span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><strong className="truncate text-sm text-white">{item.title}</strong>{!item.read ? <span className="size-1.5 rounded-full bg-emerald-300" aria-label="읽지 않음" /> : null}</span>
            <span className="mt-1 block text-sm leading-6 text-slate-400">{item.actorName ? `${item.actorName} · ` : ''}{item.message ?? notificationLabel(item.type)}</span>
            <time className="mt-2 block text-xs text-slate-600">{formatDate(item.createdAt)}</time>
          </span>
        </Link>
        {item.read ? <button type="button" disabled={working} onClick={() => void markUnread(item)} className="chip chip-muted absolute bottom-3 right-3 inline-flex min-h-11 items-center gap-1.5"><RotateCcw className="size-3.5" /> 읽지 않음</button> : <button type="button" disabled={working} onClick={() => void markRead(item)} className="chip chip-muted absolute bottom-3 right-3 inline-flex min-h-11 items-center gap-1.5"><MailOpen className="size-3.5" /> 읽음</button>}
      </li>)}
    </ol>}
    {cursor ? <button type="button" disabled={working} onClick={() => void loadMore()} className="chip chip-muted mx-auto flex items-center gap-2">{working ? <Loader2 className="size-4 animate-spin" /> : null} 이전 알림 더 보기</button> : null}
  </div>;
}

function notificationIcon(type: string) {
  if (type === 'page_revision') return <GitCommitHorizontal className="size-4" />;
  if (type === 'discussion_reply' || type === 'discussion_mention') return <MessageSquareText className="size-4" />;
  return <PenLine className="size-4" />;
}

function notificationLabel(type: string) {
  if (type === 'page_revision') return '관심 문서가 변경되었습니다.';
  if (type === 'discussion_reply') return '참여한 토론에 새 댓글이 있습니다.';
  if (type === 'discussion_mention') return '토론 댓글에서 회원님을 언급했습니다.';
  return type === 'edit_request_accepted' ? '편집 요청이 승인되었습니다.' : '편집 요청이 반려되었습니다.';
}

function formatDate(value: string) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)); }
function notifyCountChanged() { window.dispatchEvent(new Event('wiki-notifications-changed')); }

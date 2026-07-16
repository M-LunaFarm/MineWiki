'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Ban, Loader2, RotateCcw, ShieldCheck } from 'lucide-react';
import {
  fetchWikiAdminUsers,
  fetchWikiUserBlockEvents,
  setWikiAdminUserBlocked,
  type WikiAdminUserSummary,
  type WikiUserBlockEventSummary
} from '../../lib/wiki-api';
import { useAuth } from '../providers/auth-context';
import { WikiProfileMergeAdmin } from './wiki-profile-merge-admin';

export function WikiUserAdmin() {
  const { account, loading: authLoading } = useAuth();
  const [users, setUsers] = useState<WikiAdminUserSummary[]>([]);
  const [events, setEvents] = useState<WikiUserBlockEventSummary[]>([]);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<{ user: WikiAdminUserSummary; blocked: boolean } | null>(null);
  const [reason, setReason] = useState('');
  const [publicReason, setPublicReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(search = '') {
    setLoading(true); setError(null);
    try {
      const [userRows, eventRows] = await Promise.all([fetchWikiAdminUsers(search), fetchWikiUserBlockEvents()]);
      setUsers(userRows); setEvents(eventRows);
    } catch (caught) { setError(message(caught)); } finally { setLoading(false); }
  }

  useEffect(() => {
    if (authLoading) return;
    if (!account) { setLoading(false); return; }
    void load();
  }, [account, authLoading]);

  async function search(event: FormEvent) { event.preventDefault(); await load(query); }

  async function confirmChange(event: FormEvent) {
    event.preventDefault();
    if (!pending) return;
    setWorking(true); setError(null);
    try {
      await setWikiAdminUserBlocked({ profileId: pending.user.id, blocked: pending.blocked, reason, publicReason });
      const [userRows, eventRows] = await Promise.all([fetchWikiAdminUsers(query), fetchWikiUserBlockEvents()]);
      setUsers(userRows); setEvents(eventRows);
      setPending(null); setReason(''); setPublicReason('');
    } catch (caught) { setError(message(caught)); } finally { setWorking(false); }
  }

  if (authLoading || loading) return <div className="flex min-h-[40vh] items-center justify-center"><Loader2 className="size-6 animate-spin text-emerald-300" /></div>;
  if (!account) return <section className="border border-white/10 p-6"><h1 className="text-2xl font-semibold text-white">로그인이 필요합니다</h1><Link href="/login?returnTo=/admin/wiki/users" className="btn-primary mt-5">로그인</Link></section>;

  return <div className="space-y-6">
    <header className="border border-white/10 bg-white/[0.03] p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div><p className="flex items-center gap-2 text-sm font-semibold text-emerald-200"><ShieldCheck className="size-4" /> Wiki Admin</p><h1 className="mt-2 text-2xl font-semibold text-white">사용자 기여 차단</h1><p className="mt-2 text-sm text-slate-400">계정 자체가 아니라 위키 편집·토론·문서 생성 권한만 차단합니다.</p></div><nav className="flex flex-wrap gap-2"><Link href="/admin/wiki" className="chip chip-muted">최근 변경</Link><Link href="/admin/wiki/pages" className="chip chip-muted">문서</Link><Link href="/admin/wiki/acl" className="chip chip-muted">ACL</Link><span className="chip chip-accent">사용자 차단</span><Link href="/admin/wiki/batch-rollback" className="chip chip-muted">일괄 복구</Link></nav></div>
    </header>
    <WikiProfileMergeAdmin />
    {error ? <p role="alert" className="flex gap-2 border border-red-300/30 bg-red-500/10 p-4 text-sm text-red-100"><AlertTriangle className="size-4 flex-none" /> {error}</p> : null}
    <form onSubmit={search} className="flex gap-2"><input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={64} placeholder="사용자명 또는 표시 이름" className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" /><button className="btn-secondary min-h-11">검색</button></form>
    <section className="grid gap-3">
      {users.map((user) => <article key={user.id} className="flex flex-col gap-4 border border-white/10 bg-[#111821] p-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Link href={`/user/${encodeURIComponent(user.username)}`} className="font-semibold text-white hover:text-emerald-200">{user.displayName}</Link><span className={`chip ${user.status === 'blocked' ? 'border-red-300/30 text-red-200' : 'chip-muted'}`}>{user.status}</span>{user.linkedProfileCount > 1 ? <span className="chip chip-muted">연결 프로필 {user.linkedProfileCount}개</span> : null}</div><p className="mt-1 break-all text-xs text-slate-500">@{user.username} · #{user.id}</p>{user.linkedProfileCount > 1 ? <p className="mt-1 text-xs text-amber-200">차단·해제는 동일 계정 그룹 전체에 적용됩니다.</p> : null}</div>{user.status === 'active' || user.status === 'blocked' ? <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">{user.status === 'blocked' ? <Link href={`/admin/wiki/batch-rollback?targetProfileId=${encodeURIComponent(user.id)}&username=${encodeURIComponent(user.username)}`} className="btn-primary min-h-11 w-full sm:w-auto"><RotateCcw className="size-4" /> 기여 복구</Link> : null}<button type="button" onClick={() => { setPending({ user, blocked: user.status === 'active' }); setReason(''); setPublicReason(''); }} className="btn-secondary min-h-11 w-full sm:w-auto">{user.status === 'active' ? <><Ban className="size-4" /> 차단</> : <><RotateCcw className="size-4" /> 해제</>}</button></div> : null}</article>)}
      {users.length === 0 ? <p className="border border-dashed border-white/15 p-8 text-center text-sm text-slate-500">검색 결과가 없습니다.</p> : null}
    </section>
    {pending ? <form onSubmit={confirmChange} className="border border-amber-300/30 bg-amber-300/5 p-5"><h2 className="font-semibold text-white">{pending.user.displayName} 사용자를 {pending.blocked ? '차단' : '해제'}합니다</h2><p className="mt-2 text-sm text-slate-400">내부 사유는 감사 기록에만 남고, 공개 사유만 차단 기록 페이지에 표시됩니다.</p>{pending.user.linkedProfileCount > 1 ? <p className="mt-2 text-sm font-medium text-amber-200">연결된 Wiki 프로필 {pending.user.linkedProfileCount}개에 함께 적용됩니다.</p> : null}<label className="mt-4 block text-xs font-semibold text-slate-300">내부 운영 사유<textarea value={reason} onChange={(event) => setReason(event.target.value)} required minLength={5} maxLength={1000} rows={4} placeholder="구체적인 내부 사유를 5자 이상 입력하세요" className="mt-2 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm font-normal text-white" /></label><label className="mt-4 block text-xs font-semibold text-slate-300">공개 사유 (선택)<textarea value={publicReason} onChange={(event) => setPublicReason(event.target.value)} minLength={5} maxLength={300} rows={3} placeholder="사용자와 방문자에게 공개할 사유" className="mt-2 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm font-normal text-white" /></label><div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={() => setPending(null)} className="btn-secondary min-h-11">취소</button><button disabled={working} className="btn-primary min-h-11">{working ? <Loader2 className="size-4 animate-spin" /> : null} 확인</button></div></form> : null}
    <section><h2 className="text-lg font-semibold text-white">최근 차단 이력</h2><div className="mt-3 grid gap-3">{events.map((event) => <article key={event.id} className="border border-white/10 p-4 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold text-white">{event.targetName} · {event.action === 'block' ? '차단' : '해제'}</p><time className="text-xs text-slate-500">{formatDate(event.createdAt)}</time></div><p className="mt-2 text-slate-300 [overflow-wrap:anywhere]">{event.reason}</p>{event.publicReason ? <p className="mt-2 text-xs text-emerald-200 [overflow-wrap:anywhere]">공개: {event.publicReason}</p> : null}<p className="mt-2 text-xs text-slate-500">{event.actorName} · {event.previousStatus} → {event.newStatus}</p></article>)}{events.length === 0 ? <p className="text-sm text-slate-500">아직 차단 이력이 없습니다.</p> : null}</div></section>
  </div>;
}

function message(error: unknown) { return error instanceof Error ? error.message : '사용자 차단 요청에 실패했습니다.'; }
function formatDate(value: string) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)); }

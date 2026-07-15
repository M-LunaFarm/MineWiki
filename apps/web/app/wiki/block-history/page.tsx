import Link from 'next/link';
import { Ban, RotateCcw, Search, ShieldCheck } from 'lucide-react';
import { fetchWikiBlockHistory } from '../../../lib/wiki-server-api';

interface PageProps {
  readonly searchParams: Promise<{ cursor?: string; action?: string; q?: string }>;
}

export const dynamic = 'force-dynamic';

export default async function WikiBlockHistoryPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const action = query.action === 'block' || query.action === 'unblock' ? query.action : undefined;
  const search = query.q?.trim().slice(0, 64) ?? '';
  const result = await fetchWikiBlockHistory({ cursor: query.cursor, action, query: search, limit: 50 });

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <Link href="/wiki/special" className="hover:text-emerald-200">특수 문서</Link><span>/</span><span className="text-slate-200">차단 기록</span>
      </nav>
      <header className="border-b border-white/10 pb-6">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.18em] text-emerald-300"><ShieldCheck className="size-4" /> Public moderation ledger</p>
        <h1 className="mt-3 text-3xl font-bold text-white">사용자 차단 기록</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">위키 기여 차단과 해제 이력을 공개합니다. 내부 감사 사유와 계정 정보는 노출하지 않습니다.</p>
      </header>
      <form action="/wiki/block-history" className="grid gap-3 border border-white/10 bg-[#111821] p-4 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
        <label className="text-xs font-semibold text-slate-400">대상 사용자<input name="q" defaultValue={search} maxLength={64} placeholder="사용자명 또는 표시 이름" className="mt-2 min-h-11 w-full rounded-md border border-white/10 bg-[#0d1219] px-3 text-sm text-white placeholder:text-slate-600" /></label>
        <label className="text-xs font-semibold text-slate-400">작업<select name="action" defaultValue={action ?? ''} className="mt-2 min-h-11 w-full rounded-md border border-white/10 bg-[#0d1219] px-3 text-sm text-white"><option value="">전체</option><option value="block">차단</option><option value="unblock">해제</option></select></label>
        <button className="btn-secondary min-h-11"><Search className="size-4" /> 조회</button>
      </form>
      <section className="divide-y divide-white/10 border border-white/10 bg-[#111821]" aria-live="polite">
        {result.items.map((event) => (
          <article key={event.id} className="p-4 sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`chip ${event.action === 'block' ? 'border-red-300/30 text-red-200' : 'border-emerald-300/30 text-emerald-200'}`}>{event.action === 'block' ? <Ban className="size-3.5" /> : <RotateCcw className="size-3.5" />}{event.action === 'block' ? '차단' : '해제'}</span>
                  <Link href={`/wiki/contributions/${event.target.profileId}`} className="break-words font-semibold text-white hover:text-emerald-200">{event.target.displayName}</Link>
                  {event.target.username ? <span className="break-all text-xs text-slate-500">@{event.target.username}</span> : null}
                </div>
                <p className="mt-3 break-words text-sm leading-6 text-slate-300">{event.publicReason ?? '운영 사유 비공개'}</p>
                <p className="mt-2 break-words text-xs text-slate-500">처리: {event.actor.displayName}</p>
              </div>
              <time dateTime={event.createdAt} className="shrink-0 text-xs text-slate-500">{formatDate(event.createdAt)}</time>
            </div>
          </article>
        ))}
        {result.items.length === 0 ? <p className="p-10 text-center text-sm text-slate-500">조건에 해당하는 공개 차단 기록이 없습니다.</p> : null}
      </section>
      {result.nextCursor ? <Link href={nextHref({ cursor: result.nextCursor, action, query: search })} className="btn-secondary min-h-11 self-start">이전 기록 더 보기</Link> : null}
    </main>
  );
}

function nextHref(input: { cursor: string; action?: 'block' | 'unblock'; query: string }): string {
  const params = new URLSearchParams({ cursor: input.cursor });
  if (input.action) params.set('action', input.action);
  if (input.query) params.set('q', input.query);
  return `/wiki/block-history?${params.toString()}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value));
}

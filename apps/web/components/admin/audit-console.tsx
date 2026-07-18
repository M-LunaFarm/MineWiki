'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Loader2, ShieldAlert } from 'lucide-react';
import { useAuth } from '../providers/auth-context';
import { fetchAuditEventPage, type AuditEvent, type AuditEventFilters } from '../../lib/audit-api';
import { AuditEventFilterForm } from './audit-event-filters';
import { AuditEventRow } from './audit-event-row';

const EMPTY_FILTERS: AuditEventFilters = {};

export function AuditConsole() {
  const { account, loading: authLoading } = useAuth();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [draft, setDraft] = useState<AuditEventFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<AuditEventFilters>(EMPTY_FILTERS);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!account) { setLoading(false); return; }
    let cancelled = false;
    void fetchAuditEventPage({ limit: 50 }).then((page) => {
      if (!cancelled) { setEvents(page.items); setNextCursor(page.nextCursor); }
    }).catch((problem) => {
      if (!cancelled) setError(problemText(problem));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [account, authLoading]);

  async function search(filters: AuditEventFilters) {
    setLoading(true); setError(null); setExpandedId(null);
    try {
      const page = await fetchAuditEventPage({ ...filters, limit: 50 });
      setEvents(page.items); setNextCursor(page.nextCursor); setApplied(filters);
    } catch (problem) { setError(problemText(problem)); }
    finally { setLoading(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void search(cleanFilters(draft));
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true); setError(null);
    try {
      const page = await fetchAuditEventPage({ ...applied, cursor: nextCursor, limit: 50 });
      setEvents((current) => [...current, ...page.items]); setNextCursor(page.nextCursor);
    } catch (problem) { setError(problemText(problem)); }
    finally { setLoadingMore(false); }
  }

  if (authLoading || loading) return <div className="flex min-h-[40vh] items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-emerald-300" /></div>;
  if (!account) return <section className="rounded-lg border border-white/10 bg-white/[0.03] p-6"><h1 className="text-2xl font-semibold text-white">로그인이 필요합니다</h1><Link href="/login?returnTo=/admin/audit" className="btn-primary mt-5 h-10">로그인</Link></section>;

  return <div className="space-y-6">
    <section className="rounded-lg border border-white/10 bg-white/[0.03] p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-emerald-200"><ShieldAlert className="h-4 w-4" />Audit</div>
      <h1 className="mt-2 text-2xl font-semibold text-white">감사 이벤트</h1>
      <p className="mt-2 text-sm text-slate-400">카테고리·동작·담당자·대상으로 전체 이력을 추적합니다. 행을 열면 안전하게 마스킹된 상세 정보를 볼 수 있습니다.</p>
      <AuditEventFilterForm value={draft} working={loading} onChange={setDraft} onSubmit={submit} onReset={() => { setDraft(EMPTY_FILTERS); void search(EMPTY_FILTERS); }} />
    </section>
    {error ? <div role="alert" className="flex gap-3 rounded-lg border border-red-300/30 bg-red-500/10 p-4 text-sm text-red-100"><AlertTriangle className="mt-0.5 h-4 w-4 flex-none" /><p>{error}</p></div> : null}
    <section className="overflow-x-auto rounded-lg border border-white/10 bg-[#111821]">
      <table className="min-w-full text-left text-sm"><thead className="border-b border-white/10 text-xs uppercase text-slate-500"><tr><th className="w-14 px-4 py-3"><span className="sr-only">상세</span></th><th className="px-4 py-3">시간</th><th className="px-4 py-3">심각도</th><th className="px-4 py-3">카테고리</th><th className="px-4 py-3">동작</th><th className="px-4 py-3">대상</th></tr></thead>
        <tbody className="divide-y divide-white/10 text-slate-300">{events.map((event) => <AuditEventRow key={event.id} event={event} expanded={expandedId === event.id} onToggle={() => setExpandedId((current) => current === event.id ? null : event.id)} />)}</tbody></table>
      {events.length === 0 ? <p className="p-8 text-center text-sm text-slate-400">조건에 맞는 감사 이벤트가 없습니다.</p> : null}
    </section>
    {nextCursor ? <div className="flex justify-center"><button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="btn-secondary min-h-11 gap-2">{loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}이전 이벤트 50건 더 보기</button></div> : null}
  </div>;
}

function cleanFilters(filters: AuditEventFilters): AuditEventFilters {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value?.trim())) as AuditEventFilters;
}

function problemText(problem: unknown): string { return problem instanceof Error ? problem.message : '감사 이벤트를 불러오지 못했습니다.'; }

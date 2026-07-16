'use client';

import { AlertTriangle, CheckCircle2, Flag, Loader2, UserCheck, UserMinus, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { assignWikiReport, fetchWikiReportQueue, transitionWikiReport, type WikiReportCase, type WikiReportStatus, type WikiReportTargetType } from '../../lib/wiki-api';
import { useAuth } from '../providers/auth-context';

const STATUSES: ReadonlyArray<{ value: '' | WikiReportStatus; label: string }> = [{ value: '', label: '전체 상태' }, { value: 'open', label: '접수' }, { value: 'in_review', label: '검토 중' }, { value: 'resolved', label: '조치 완료' }, { value: 'dismissed', label: '기각' }];
const TARGETS: ReadonlyArray<{ value: '' | WikiReportTargetType; label: string }> = [{ value: '', label: '전체 콘텐츠' }, { value: 'page', label: '문서' }, { value: 'revision', label: '판' }, { value: 'discussion', label: '토론' }, { value: 'comment', label: '댓글' }];

export function WikiReportAdminClient() {
  const { account, loading: authLoading } = useAuth();
  const [items, setItems] = useState<WikiReportCase[]>([]);
  const [status, setStatus] = useState<'' | WikiReportStatus>('');
  const [targetType, setTargetType] = useState<'' | WikiReportTargetType>('');
  const [assignee, setAssignee] = useState<'' | 'me' | 'unassigned'>('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!account) { setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const result = await fetchWikiReportQueue({ status: status || undefined, targetType: targetType || undefined, assignee: assignee || undefined });
      setItems(result.items); setCursor(result.nextCursor);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '신고 큐를 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }, [account, assignee, status, targetType]);

  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);

  async function more() {
    if (!cursor) return;
    setWorking('more');
    try {
      const result = await fetchWikiReportQueue({ status: status || undefined, targetType: targetType || undefined, assignee: assignee || undefined, cursor });
      setItems((current) => [...current, ...result.items.filter((item) => !current.some((row) => row.id === item.id))]); setCursor(result.nextCursor);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '다음 신고를 불러오지 못했습니다.'); }
    finally { setWorking(null); }
  }

  async function assign(item: WikiReportCase, mine: boolean) {
    setWorking(item.id); setError(null);
    try { replace(await assignWikiReport(item.id, item.version, mine ? undefined : null)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '담당자를 변경하지 못했습니다.'); }
    finally { setWorking(null); }
  }

  async function transition(item: WikiReportCase, next: WikiReportStatus) {
    const resolution = resolutions[item.id]?.trim();
    if ((next === 'resolved' || next === 'dismissed') && (!resolution || resolution.length < 3)) { setError('완료 또는 기각하려면 3자 이상의 처리 메모가 필요합니다.'); return; }
    setWorking(item.id); setError(null);
    try { replace(await transitionWikiReport(item.id, item.version, next, resolution)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '신고 상태를 변경하지 못했습니다.'); }
    finally { setWorking(null); }
  }

  function replace(next: WikiReportCase) { setItems((current) => current.map((item) => item.id === next.id ? next : item)); }

  if (authLoading || loading) return <div className="grid min-h-[40vh] place-items-center"><Loader2 className="size-6 animate-spin text-emerald-300" /></div>;
  if (!account) return <section className="surface-flat p-6"><h1 className="text-2xl font-bold text-white">로그인이 필요합니다</h1><Link href="/login?returnTo=/admin/wiki/reports" className="btn-primary mt-5">로그인</Link></section>;

  return <div className="space-y-5">
    <header className="rounded-xl border border-white/10 bg-white/[0.03] p-5"><p className="flex items-center gap-2 text-sm font-semibold text-red-200"><Flag className="size-4" /> Trust &amp; Safety</p><h1 className="mt-2 text-2xl font-bold text-white">위키 신고 큐</h1><p className="mt-2 text-sm leading-6 text-slate-400">중복 신고는 한 사건으로 집계되며, 증거 스냅샷과 처리 이력이 보존됩니다.</p><nav className="mt-4 flex flex-wrap gap-2"><Link href="/admin/wiki" className="chip chip-muted">위키 관리</Link><Link href="/admin/wiki/reports" className="chip chip-accent">신고 큐</Link></nav></header>
    <section className="grid gap-3 rounded-xl border border-white/10 bg-[#111821] p-4 sm:grid-cols-3">
      <Filter label="상태" value={status} onChange={(value) => setStatus(value as typeof status)} options={STATUSES} />
      <Filter label="대상" value={targetType} onChange={(value) => setTargetType(value as typeof targetType)} options={TARGETS} />
      <Filter label="담당" value={assignee} onChange={(value) => setAssignee(value as typeof assignee)} options={[{ value: '', label: '전체 담당자' }, { value: 'me', label: '내 담당' }, { value: 'unassigned', label: '미배정' }]} />
    </section>
    {error ? <p role="alert" className="flex gap-2 border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-100"><AlertTriangle className="size-4 shrink-0" />{error}</p> : null}
    <section className="space-y-3">{items.length === 0 ? <div className="border border-dashed border-white/15 p-10 text-center text-sm text-slate-500">조건에 맞는 신고가 없습니다.</div> : items.map((item) => <article key={item.id} className="rounded-xl border border-white/10 bg-[#111821] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><span className={`chip ${item.status === 'open' ? 'border-red-300/30 bg-red-300/10 text-red-100' : item.status === 'in_review' ? 'border-amber-300/30 bg-amber-300/10 text-amber-100' : 'chip-muted'}`}>{statusLabel(item.status)}</span><strong className="text-white">{targetLabel(item.targetType)} #{item.targetId}</strong><span className="text-xs text-slate-500">신고 {item.reportCount.toLocaleString('ko-KR')}건</span></div><p className="mt-2 text-xs text-slate-500">사건 {item.id} · v{item.version} · {formatDate(item.createdAt)}</p></div><div className="flex gap-2"><button disabled={working === item.id} onClick={() => void assign(item, true)} className="chip chip-muted inline-flex min-h-11 items-center gap-1"><UserCheck className="size-4" /> 내게 배정</button>{item.assigneeProfileId ? <button disabled={working === item.id} onClick={() => void assign(item, false)} className="chip chip-muted inline-flex min-h-11 items-center gap-1"><UserMinus className="size-4" /> 배정 해제</button> : null}</div></div>
      <div className="mt-4 space-y-2">{item.recentSubmissions.map((submission) => <blockquote key={submission.id} className="border-l-2 border-red-300/25 pl-3 text-sm leading-6 text-slate-300"><p className="whitespace-pre-wrap">{submission.reason}</p><footer className="mt-1 text-xs text-slate-600">신고자 #{submission.reporterProfileId} · {formatDate(submission.createdAt)}</footer></blockquote>)}</div>
      {item.status === 'open' || item.status === 'in_review' ? <div className="mt-4 border-t border-white/10 pt-4"><textarea value={resolutions[item.id] ?? ''} onChange={(event) => setResolutions((current) => ({ ...current, [item.id]: event.target.value }))} maxLength={1000} placeholder="완료/기각 처리 메모 (최소 3자)" aria-label="처리 메모" className="min-h-24 w-full rounded-lg border border-white/10 bg-black/20 p-3 text-sm text-white" /><div className="mt-3 flex flex-wrap justify-end gap-2">{item.status === 'open' ? <button disabled={working === item.id} onClick={() => void transition(item, 'in_review')} className="chip chip-muted min-h-11">검토 시작</button> : <button disabled={working === item.id} onClick={() => void transition(item, 'open')} className="chip chip-muted min-h-11">접수로 되돌리기</button>}<button disabled={working === item.id} onClick={() => void transition(item, 'dismissed')} className="chip chip-muted inline-flex min-h-11 items-center gap-1"><XCircle className="size-4" /> 기각</button><button disabled={working === item.id} onClick={() => void transition(item, 'resolved')} className="btn-primary min-h-11 gap-1"><CheckCircle2 className="size-4" /> 조치 완료</button></div></div> : <p className="mt-4 border-t border-white/10 pt-4 text-sm text-slate-400">처리 메모: {item.resolution ?? '-'}</p>}
    </article>)}</section>
    {cursor ? <button disabled={working === 'more'} onClick={() => void more()} className="chip chip-muted mx-auto flex min-h-11 items-center gap-2">{working === 'more' ? <Loader2 className="size-4 animate-spin" /> : null} 이전 신고 더 보기</button> : null}
  </div>;
}

function Filter({ label, value, onChange, options }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }> }) { return <label className="text-xs font-semibold text-slate-400">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-white">{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>; }
function statusLabel(status: WikiReportStatus) { return status === 'open' ? '접수' : status === 'in_review' ? '검토 중' : status === 'resolved' ? '조치 완료' : '기각'; }
function targetLabel(target: WikiReportTargetType) { return target === 'page' ? '문서' : target === 'revision' ? '판' : target === 'discussion' ? '토론' : '댓글'; }
function formatDate(value: string) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value)); }

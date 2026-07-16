'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Crown, Loader2, RefreshCw, Search, ShieldCheck, XCircle } from 'lucide-react';
import { csrfHeaders } from '../../lib/csrf';
import { getApiBaseUrl } from '../../lib/runtime-config';

type PremiumLayout = 'handbook' | 'brand';

interface ServerOption {
  readonly id: string;
  readonly name: string;
  readonly joinHost: string;
}

interface EntitlementItem {
  readonly id: string;
  readonly layoutKey: string;
  readonly status: string;
  readonly source: string;
  readonly externalRef: string | null;
  readonly startsAt: string;
  readonly expiresAt: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

interface EntitlementHistory {
  readonly serverId: string;
  readonly items: readonly EntitlementItem[];
  readonly nextCursor: string | null;
}

export function ServerWikiEntitlementConsole() {
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<ServerOption[]>([]);
  const [selected, setSelected] = useState<ServerOption | null>(null);
  const [history, setHistory] = useState<EntitlementHistory | null>(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [layoutKey, setLayoutKey] = useState<PremiumLayout>('handbook');
  const [startsAt, setStartsAt] = useState(() => toLocalDateTime(new Date()));
  const [expiresAt, setExpiresAt] = useState(() => toLocalDateTime(addYear(new Date())));
  const [source, setSource] = useState('manual');
  const [externalRef, setExternalRef] = useState('');
  const [reason, setReason] = useState('');
  const baseUrl = getApiBaseUrl();

  const activeLayouts = useMemo(() => new Set(
    (history?.items ?? [])
      .filter((item) => item.status === 'active' && Date.parse(item.startsAt) <= Date.now() && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()))
      .map((item) => item.layoutKey),
  ), [history]);

  const loadHistory = useCallback(async (server: ServerOption, before?: string) => {
    setLoading(true); setError(null);
    try {
      const query = before ? `?before=${encodeURIComponent(before)}&limit=50` : '?limit=50';
      const response = await fetch(`${baseUrl}/v1/admin/servers/${encodeURIComponent(server.id)}/wiki-layout-entitlements${query}`, { credentials: 'include', cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? '요금제 권한 이력을 불러오지 못했습니다.');
      const page = payload as EntitlementHistory;
      setHistory((current) => before && current ? { ...page, items: [...current.items, ...page.items] } : page);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '요금제 권한 이력을 불러오지 못했습니다.');
    } finally { setLoading(false); }
  }, [baseUrl]);

  useEffect(() => {
    const keyword = search.trim();
    if (keyword.length < 2 || selected?.name === keyword) { setOptions([]); return; }
    const timer = window.setTimeout(() => {
      setSearching(true);
      void fetch(`${baseUrl}/v1/servers?search=${encodeURIComponent(keyword)}&sort=name_asc`)
        .then(async (response) => {
          if (!response.ok) throw new Error('서버 검색에 실패했습니다.');
          return response.json() as Promise<ServerOption[]>;
        })
        .then((items) => setOptions(items.slice(0, 8)))
        .catch((problem) => setError(problem instanceof Error ? problem.message : '서버 검색에 실패했습니다.'))
        .finally(() => setSearching(false));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [baseUrl, search, selected?.name]);

  function choose(server: ServerOption) {
    setSelected(server); setSearch(server.name); setOptions([]); setHistory(null); setNotice(null);
    void loadHistory(server);
  }

  async function grant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) { setError('먼저 서버를 선택해 주세요.'); return; }
    const starts = new Date(startsAt); const expires = new Date(expiresAt);
    if (!Number.isFinite(starts.getTime()) || !Number.isFinite(expires.getTime()) || expires <= starts) {
      setError('종료 시각은 시작 시각보다 뒤여야 합니다.'); return;
    }
    setPending('grant'); setError(null); setNotice(null);
    try {
      await mutate(selected.id, '', {
        layoutKey, startsAt: starts.toISOString(), expiresAt: expires.toISOString(), source: source.trim(),
        ...(externalRef.trim() ? { externalRef: externalRef.trim() } : {}), reason: reason.trim(),
      });
      setReason(''); setExternalRef(''); setNotice(`${layoutLabel(layoutKey)} 권한을 부여했습니다.`);
      await loadHistory(selected);
    } catch (problem) { setError(problem instanceof Error ? problem.message : '권한 부여에 실패했습니다.'); }
    finally { setPending(null); }
  }

  async function extend(item: EntitlementItem) {
    if (!selected || !item.expiresAt) return;
    const defaultValue = toLocalDateTime(addYear(new Date(item.expiresAt)));
    const value = window.prompt('새 종료 시각을 입력하세요. (YYYY-MM-DDTHH:mm)', defaultValue);
    if (!value) return;
    const nextExpiry = new Date(value);
    if (!Number.isFinite(nextExpiry.getTime()) || nextExpiry <= new Date(item.expiresAt)) { setError('새 종료 시각은 현재 종료 시각보다 뒤여야 합니다.'); return; }
    const actionReason = window.prompt('연장 사유를 5자 이상 입력하세요.');
    if (!actionReason?.trim()) return;
    setPending(`extend:${item.id}`); setError(null); setNotice(null);
    try {
      await mutate(selected.id, `/${item.id}/extend`, { expiresAt: nextExpiry.toISOString(), reason: actionReason.trim() });
      setNotice(`${layoutLabel(item.layoutKey)} 권한을 연장했습니다.`); await loadHistory(selected);
    } catch (problem) { setError(problem instanceof Error ? problem.message : '권한 연장에 실패했습니다.'); }
    finally { setPending(null); }
  }

  async function revoke(item: EntitlementItem) {
    if (!selected || !window.confirm(`${layoutLabel(item.layoutKey)} 권한을 회수하시겠습니까? 마지막 활성 권한이면 공개 위키가 Docs로 전환됩니다.`)) return;
    const actionReason = window.prompt('회수 사유를 5자 이상 입력하세요.');
    if (!actionReason?.trim()) return;
    setPending(`revoke:${item.id}`); setError(null); setNotice(null);
    try {
      await mutate(selected.id, `/${item.id}/revoke`, { reason: actionReason.trim() });
      setNotice(`${layoutLabel(item.layoutKey)} 권한을 회수했습니다.`); await loadHistory(selected);
    } catch (problem) { setError(problem instanceof Error ? problem.message : '권한 회수에 실패했습니다.'); }
    finally { setPending(null); }
  }

  async function mutate(serverId: string, suffix: string, body: unknown) {
    const response = await fetch(`${baseUrl}/v1/admin/servers/${encodeURIComponent(serverId)}/wiki-layout-entitlements${suffix}`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) }, body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message ?? '요금제 권한을 변경하지 못했습니다.');
    return payload;
  }

  return (
    <div className="space-y-6 text-white">
      <header><p className="text-xs font-bold uppercase tracking-[0.18em] text-[#35e5b7]">Billing Entitlements</p><h1 className="mt-2 flex items-center gap-3 text-3xl font-extrabold"><Crown className="h-7 w-7 text-[#35e5b7]" />서버 위키 요금제 권한</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">결제 확인이 끝난 프리미엄 레이아웃을 수동 부여·연장·회수합니다. 모든 변경은 사유와 함께 감사 이벤트에 기록됩니다.</p></header>

      <section className="rounded-2xl border border-white/10 bg-[#17191c] p-5">
        <label className="text-sm font-bold text-slate-200">서버 검색</label>
        <div className="relative mt-2 max-w-2xl"><Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-500" /><input value={search} onChange={(event) => { setSearch(event.target.value); setSelected(null); setHistory(null); }} placeholder="서버명 또는 접속 주소" className="min-h-11 w-full rounded-lg border border-white/10 bg-[#101214] pl-10 pr-10 text-sm text-white outline-none focus:border-[#35e5b7]/50" />{searching ? <Loader2 className="absolute right-3 top-3.5 h-4 w-4 animate-spin text-[#35e5b7]" /> : null}</div>
        {options.length ? <ul className="mt-2 max-w-2xl overflow-hidden rounded-lg border border-white/10 bg-[#101214]">{options.map((server) => <li key={server.id}><button type="button" onClick={() => choose(server)} className="flex w-full items-center justify-between gap-4 border-b border-white/5 px-4 py-3 text-left text-sm last:border-0 hover:bg-white/5"><span><strong className="block text-white">{server.name}</strong><span className="text-xs text-slate-500">{server.joinHost}</span></span><span className="text-[10px] text-slate-600">{server.id}</span></button></li>)}</ul> : null}
        {selected ? <div className="mt-4 flex max-w-2xl items-center justify-between rounded-lg border border-[#35e5b7]/20 bg-[#35e5b7]/5 p-3"><div><p className="text-sm font-bold text-white">{selected.name}</p><p className="text-xs text-slate-400">{selected.joinHost} · {selected.id}</p></div><button type="button" aria-label="선택 해제" onClick={() => { setSelected(null); setSearch(''); setHistory(null); }}><XCircle className="h-5 w-5 text-slate-400" /></button></div> : null}
      </section>

      {error ? <p role="alert" className="rounded-xl border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">{error}</p> : null}
      {notice ? <p className="flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-4 text-sm text-emerald-100"><ShieldCheck className="h-4 w-4" />{notice}</p> : null}

      {selected ? <div className="grid gap-6 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <form onSubmit={grant} className="space-y-4 rounded-2xl border border-white/10 bg-[#17191c] p-5"><div><h2 className="text-lg font-bold">새 권한 부여</h2><p className="mt-1 text-xs leading-5 text-slate-500">외부 참조는 결제·계약 건별 고유값을 사용하면 재시도를 안전하게 멱등 처리합니다.</p></div><label className="block text-xs font-bold text-slate-300">레이아웃<select value={layoutKey} onChange={(event) => setLayoutKey(event.target.value as PremiumLayout)} className="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-[#101214] px-3 text-sm"><option value="handbook">Handbook</option><option value="brand">Brand</option></select></label><div className="grid gap-3 sm:grid-cols-2"><Field label="시작" value={startsAt} onChange={setStartsAt} type="datetime-local" /><Field label="종료" value={expiresAt} onChange={setExpiresAt} type="datetime-local" /></div><Field label="출처" value={source} onChange={setSource} maxLength={32} placeholder="manual" /><Field label="외부 참조 (선택)" value={externalRef} onChange={setExternalRef} maxLength={191} placeholder="invoice-2026-0001" /><label className="block text-xs font-bold text-slate-300">처리 사유<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={500} required rows={3} className="mt-1 w-full rounded-lg border border-white/10 bg-[#101214] p-3 text-sm outline-none focus:border-[#35e5b7]/50" /></label><button type="submit" disabled={pending !== null || reason.trim().length < 5} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#35e5b7] px-4 text-sm font-extrabold text-[#07110e] disabled:opacity-40">{pending === 'grant' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Crown className="h-4 w-4" />}권한 부여</button></form>

        <section className="rounded-2xl border border-white/10 bg-[#17191c] p-5"><div className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-bold">권한 이력</h2><p className="mt-1 text-xs text-slate-500">현재 활성: {activeLayouts.size ? [...activeLayouts].map(layoutLabel).join(', ') : '없음'}</p></div><button type="button" onClick={() => void loadHistory(selected)} disabled={loading} className="rounded-lg border border-white/10 p-2 text-slate-300 hover:bg-white/5"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button></div>{loading && !history ? <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />이력을 불러오는 중</div> : null}{history && history.items.length === 0 ? <p className="mt-5 rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-slate-500">등록된 권한이 없습니다.</p> : null}<div className="mt-4 space-y-3">{history?.items.map((item) => { const active = item.status === 'active' && Date.parse(item.startsAt) <= Date.now() && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()); return <article key={item.id} className="rounded-xl border border-white/10 bg-[#101214] p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex items-center gap-2"><strong>{layoutLabel(item.layoutKey)}</strong><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${active ? 'bg-emerald-400/10 text-emerald-300' : item.status === 'revoked' ? 'bg-red-400/10 text-red-200' : 'bg-slate-400/10 text-slate-300'}`}>{active ? '활성' : item.status === 'revoked' ? '회수됨' : '만료/대기'}</span></div><p className="mt-1 text-xs text-slate-500">#{item.id} · {item.source}{item.externalRef ? ` · ${item.externalRef}` : ''}</p></div><p className="flex items-center gap-1 text-xs text-slate-400"><CalendarClock className="h-3.5 w-3.5" />{formatDate(item.expiresAt)}</p></div>{item.status === 'active' ? <div className="mt-4 flex gap-2 border-t border-white/10 pt-3"><button type="button" onClick={() => void extend(item)} disabled={pending !== null || !item.expiresAt} className="min-h-10 flex-1 rounded-lg border border-[#35e5b7]/20 text-xs font-bold text-[#79f2cf] disabled:opacity-40">연장</button><button type="button" onClick={() => void revoke(item)} disabled={pending !== null} className="min-h-10 flex-1 rounded-lg border border-red-400/20 text-xs font-bold text-red-200 disabled:opacity-40">회수</button></div> : null}</article>; })}</div>{history?.nextCursor ? <button type="button" onClick={() => void loadHistory(selected, history.nextCursor ?? undefined)} disabled={loading} className="mt-4 min-h-11 w-full rounded-lg border border-white/10 text-sm font-bold hover:bg-white/5 disabled:opacity-40">이전 이력 더 보기</button> : null}</section>
      </div> : null}
    </div>
  );
}

function Field({ label, value, onChange, ...props }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly type?: string; readonly maxLength?: number; readonly placeholder?: string }) { return <label className="block text-xs font-bold text-slate-300">{label}<input value={value} onChange={(event) => onChange(event.target.value)} required className="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-[#101214] px-3 text-sm outline-none focus:border-[#35e5b7]/50" {...props} /></label>; }
function addYear(value: Date) { const next = new Date(value); next.setUTCFullYear(next.getUTCFullYear() + 1); return next; }
function toLocalDateTime(value: Date) { const offset = value.getTimezoneOffset() * 60_000; return new Date(value.getTime() - offset).toISOString().slice(0, 16); }
function layoutLabel(value: string) { return value === 'handbook' ? 'Handbook' : value === 'brand' ? 'Brand' : value; }
function formatDate(value: string | null) { if (!value) return '무기한'; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleString('ko-KR'); }

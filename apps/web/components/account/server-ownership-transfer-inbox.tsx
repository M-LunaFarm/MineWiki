'use client';

import Link from 'next/link';
import { Check, Loader2, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { csrfHeaders } from '../../lib/csrf';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import { PrivilegedActionGate } from '../auth/privileged-action-gate';

interface Transfer {
  readonly id: string; readonly serverId: string; readonly serverName: string;
  readonly serverAddress: string;
  readonly sourceOwnerName: string; readonly targetUsername: string; readonly targetDisplayName: string;
  readonly reason: string; readonly requestedAt: string; readonly expiresAt: string; readonly version: number;
}

export function ServerOwnershipTransferInbox() {
  const endpoint = `${normalizeApiBaseUrl()}/v1/me/server-ownership-transfers`;
  const [items, setItems] = useState<readonly Transfer[]>([]);
  const [loading, setLoading] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [responseReason, setResponseReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (preserveError = false) => {
    setLoading(true); if (!preserveError) setError(null);
    try {
      const response = await fetch(endpoint, { credentials: 'include', cache: 'no-store' });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiMessage(body, '소유권 이전 요청을 불러오지 못했습니다.'));
      setItems(parseItems(body));
    } catch (value) { setError(message(value, '소유권 이전 요청을 불러오지 못했습니다.')); }
    finally { setLoading(false); }
  }, [endpoint]);

  function expand(item: Transfer) {
    setExpandedId(item.id); setConfirmation(''); setResponseReason(''); setAcknowledged(false); setError(null);
  }

  async function respond(item: Transfer, action: 'accept' | 'decline') {
    if (action === 'accept' && (confirmation !== item.serverName || !acknowledged)) {
      setError('책임 범위를 확인하고 서버 이름을 정확히 입력해 주세요.'); return;
    }
    if (responseReason.trim().length < 5) { setError('응답 사유를 5자 이상 입력해 주세요.'); return; }
    setWorkingId(item.id); setError(null); setNotice(null);
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(item.id)}/${action}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({ expectedVersion: item.version, reason: responseReason }),
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiMessage(body, '소유권 이전 요청에 응답하지 못했습니다.'));
      setExpandedId(null); setNotice(action === 'accept'
        ? `${item.serverName} 서버의 소유권을 넘겨받았습니다.` : `${item.serverName} 서버의 이전 요청을 거절했습니다.`);
      await load();
    } catch (value) { setError(message(value, '소유권 이전 요청에 응답하지 못했습니다.')); await load(true); }
    finally { setWorkingId(null); }
  }

  return (
    <div id="server-ownership-transfers" className="scroll-mt-24">
      <PrivilegedActionGate purpose="server_ownership_transfer" title="소유권 이전 요청 확인" description="서버 전체 권한 수락 또는 거절은 전용 다중 인증으로 보호됩니다." onUnlocked={load}>
      <section aria-labelledby="server-ownership-transfers-title" aria-busy={loading || workingId !== null} className="mb-6 rounded-lg border border-amber-400/25 bg-[#181a1d] p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h3 id="server-ownership-transfers-title" className="flex items-center gap-2 text-lg font-bold text-white"><ShieldAlert className="size-5 text-amber-300" /> 서버 소유권 이전 요청</h3><p className="mt-2 text-sm leading-6 text-[#a0a0a0]">수락 전에는 권한이 바뀌지 않으며 요청은 72시간 뒤 만료됩니다.</p></div><button type="button" onClick={() => void load()} disabled={loading || workingId !== null} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-white/15 px-3 text-sm text-white disabled:opacity-50"><RefreshCw className={`size-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} /> 새로고침</button></div>
        {error ? <p className="mt-4 rounded-md border border-red-400/25 bg-red-500/10 p-3 text-sm text-red-100" role="alert">{error}</p> : null}
        {notice ? <p className="mt-4 rounded-md border border-emerald-400/25 bg-emerald-500/10 p-3 text-sm text-emerald-100" role="status" aria-live="polite">{notice}</p> : null}
        {loading ? <p className="mt-5 flex items-center gap-2 text-sm text-[#a0a0a0]"><Loader2 className="size-4 animate-spin" /> 요청을 불러오는 중입니다.</p> : null}
        {!loading && items.length === 0 ? <p className="mt-5 rounded-md border border-dashed border-white/10 p-5 text-center text-sm text-[#777]">응답할 소유권 이전 요청이 없습니다.</p> : null}
        <ul className="mt-5 space-y-3">{items.map((item) => {
          const expanded = expandedId === item.id;
          return <li key={item.id} className="rounded-lg border border-amber-200/15 bg-[#111315] p-4"><div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div><h4 className="font-bold text-white">{item.serverName}</h4><p className="mt-1 font-mono text-xs text-amber-100/80">{item.serverAddress}</p><p className="mt-2 text-sm text-slate-300">{item.sourceOwnerName}님이 이전을 요청했습니다.</p><p className="mt-2 text-xs leading-5 text-slate-400">{item.reason}</p><p className="mt-2 text-xs text-slate-500">만료 <time dateTime={item.expiresAt}>{formatDate(item.expiresAt)}</time></p></div><div className="flex gap-2"><Link href={`/servers/${encodeURIComponent(item.serverId)}`} className="inline-flex min-h-11 items-center px-3 text-sm font-semibold text-emerald-300">서버 보기</Link><button type="button" onClick={() => expand(item)} aria-expanded={expanded} aria-controls={`transfer-response-${item.id}`} className="min-h-11 rounded-md bg-amber-300 px-4 text-sm font-bold text-black">요청 검토</button></div></div>
            {expanded ? <div id={`transfer-response-${item.id}`} className="mt-4 grid gap-3 border-t border-white/10 pt-4"><p className="text-xs leading-5 text-amber-100/80">수락하면 서버 설정, 위키, 투표와 Votifier 관리 권한을 넘겨받고 기존 소유자의 서버별 권한은 즉시 회수됩니다.</p><label className="text-xs font-semibold text-slate-200">응답 사유<textarea value={responseReason} onChange={(event) => setResponseReason(event.target.value)} minLength={5} maxLength={500} rows={2} className="mt-2 w-full rounded-md border border-white/15 bg-black/20 p-3 text-sm text-white" /></label><label className="flex gap-3 text-xs leading-5 text-slate-200"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-1 size-4" /> 서버 운영과 보안 책임을 넘겨받는다는 점을 확인했습니다.</label><label className="text-xs font-semibold text-slate-200">수락하려면 서버 이름 입력: <span className="text-amber-200">{item.serverName}</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-white/15 bg-black/20 px-3 text-sm text-white" /></label><div className="flex flex-col gap-2 sm:flex-row"><button type="button" onClick={() => void respond(item, 'decline')} disabled={workingId !== null || responseReason.trim().length < 5} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-red-400/30 px-4 text-sm font-semibold text-red-200 disabled:opacity-50"><X className="size-4" /> 거절</button><button type="button" onClick={() => void respond(item, 'accept')} disabled={workingId !== null || responseReason.trim().length < 5 || confirmation !== item.serverName || !acknowledged} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-amber-300 px-4 text-sm font-bold text-black disabled:opacity-50">{workingId === item.id ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} 소유권 수락</button></div></div> : null}
          </li>;
        })}</ul>
      </section>
      </PrivilegedActionGate>
    </div>
  );
}

const DATE = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
function formatDate(value: string) { const time = Date.parse(value); return Number.isFinite(time) ? DATE.format(time) : '확인 필요'; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function apiMessage(value: unknown, fallback: string) { return isRecord(value) && typeof value.message === 'string' ? value.message : fallback; }
function message(value: unknown, fallback: string) { return value instanceof Error ? value.message : fallback; }
function parseItems(value: unknown): readonly Transfer[] {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every(isTransfer)) throw new Error('소유권 이전 응답 형식이 올바르지 않습니다.');
  return value.items;
}
function isTransfer(value: unknown): value is Transfer {
  return isRecord(value) && typeof value.id === 'string' && typeof value.serverId === 'string' && typeof value.serverName === 'string' && typeof value.serverAddress === 'string'
    && typeof value.sourceOwnerName === 'string' && typeof value.targetUsername === 'string' && typeof value.targetDisplayName === 'string'
    && typeof value.reason === 'string' && typeof value.requestedAt === 'string' && typeof value.expiresAt === 'string' && typeof value.version === 'number';
}

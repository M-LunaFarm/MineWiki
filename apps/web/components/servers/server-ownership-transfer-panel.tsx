'use client';

import { AlertTriangle, Loader2, RefreshCw, Send, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { csrfHeaders } from '../../lib/csrf';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import { PrivilegedActionGate } from '../auth/privileged-action-gate';

interface Transfer {
  readonly id: string; readonly serverId: string; readonly serverName: string;
  readonly serverAddress: string;
  readonly targetUsername: string; readonly targetDisplayName: string; readonly reason: string;
  readonly requestedAt: string; readonly expiresAt: string; readonly version: number;
}

export function ServerOwnershipTransferPanel({ serverId, serverName }: { readonly serverId: string; readonly serverName: string }) {
  const endpoint = `${normalizeApiBaseUrl()}/v1/servers/${encodeURIComponent(serverId)}/ownership-transfers`;
  const [current, setCurrent] = useState<Transfer | null>(null);
  const [targetUsername, setTargetUsername] = useState('');
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (preserveError = false) => {
    setLoading(true); if (!preserveError) setError(null);
    try {
      const response = await fetch(`${endpoint}/current`, { credentials: 'include', cache: 'no-store' });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(apiMessage(body, '소유권 이전 상태를 불러오지 못했습니다.'));
      setCurrent(body === null ? null : parseTransfer(body));
    } catch (value) { setError(message(value, '소유권 이전 상태를 불러오지 못했습니다.')); }
    finally { setLoading(false); }
  }, [endpoint]);

  async function requestTransfer() {
    if (confirmation !== serverName || !acknowledged) {
      setError('영향 범위를 확인하고 서버 이름을 정확히 입력해 주세요.'); return;
    }
    setWorking(true); setError(null); setNotice(null);
    try {
      const response = await fetch(endpoint, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({ targetUsername, reason }),
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiMessage(body, '소유권 이전 요청을 보내지 못했습니다.'));
      setCurrent(parseTransfer(body)); setTargetUsername(''); setReason(''); setConfirmation(''); setAcknowledged(false);
      setNotice('대상 사용자의 수락을 기다립니다. 수락 전에는 소유권이 변경되지 않습니다.');
    } catch (value) { setError(message(value, '소유권 이전 요청을 보내지 못했습니다.')); }
    finally { setWorking(false); }
  }

  async function cancelTransfer() {
    if (!current) return;
    setWorking(true); setError(null); setNotice(null);
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(current.id)}`, {
        method: 'DELETE', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({ expectedVersion: current.version, reason: cancelReason }),
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiMessage(body, '소유권 이전 요청을 취소하지 못했습니다.'));
      setCurrent(null); setCancelReason(''); setNotice('소유권 이전 요청을 취소했습니다.');
    } catch (value) { setError(message(value, '소유권 이전 요청을 취소하지 못했습니다.')); await load(true); }
    finally { setWorking(false); }
  }

  return (
    <PrivilegedActionGate purpose="server_ownership_transfer" title="소유권 이전 잠금 해제" description="서버 전체 권한을 넘기는 작업이므로 전용 다중 인증을 다시 확인합니다." onUnlocked={load}>
      <section id="server-ownership-transfer" aria-labelledby="server-ownership-transfer-title" aria-busy={loading || working} className="mt-5 rounded-lg border border-amber-400/25 bg-amber-500/5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div><h4 id="server-ownership-transfer-title" className="flex items-center gap-2 font-bold text-amber-100"><AlertTriangle className="size-4" aria-hidden="true" /> 소유권 및 위험 작업</h4><p className="mt-2 text-xs leading-5 text-amber-100/70">대상자의 명시적 수락 뒤 서버 설정·위키·투표·Votifier 권한이 함께 이전됩니다. 결제 이력이 있는 서버는 개인정보 보호를 위해 자동 이전할 수 없습니다.</p></div>
          <button type="button" onClick={() => void load()} disabled={loading || working} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-amber-200/20 text-amber-100 disabled:opacity-50" aria-label="이전 상태 새로고침"><RefreshCw className={`size-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} /></button>
        </div>
        {error ? <p role="alert" className="mt-3 rounded-md border border-red-400/25 bg-red-500/10 p-3 text-sm text-red-100">{error}</p> : null}
        {notice ? <p role="status" aria-live="polite" className="mt-3 rounded-md border border-emerald-400/25 bg-emerald-500/10 p-3 text-sm text-emerald-100">{notice}</p> : null}
        {current ? (
          <div className="mt-4 rounded-md border border-amber-200/15 bg-black/20 p-4">
            <p className="font-semibold text-white">{current.targetDisplayName} <span className="text-xs text-slate-400">@{current.targetUsername}</span></p>
            <p className="mt-2 text-xs text-slate-300">{current.reason}</p>
            <p className="mt-2 text-xs text-slate-400">만료 <time dateTime={current.expiresAt}>{formatDate(current.expiresAt)}</time></p>
            <label className="mt-4 block text-xs font-semibold text-slate-200">취소 사유<input value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} minLength={5} maxLength={500} className="mt-2 min-h-11 w-full rounded-md border border-white/15 bg-[#111315] px-3 text-sm text-white" /></label>
            <button type="button" onClick={() => void cancelTransfer()} disabled={working || cancelReason.trim().length < 5} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-md border border-red-400/30 px-4 text-sm font-semibold text-red-200 disabled:opacity-50">{working ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />} 요청 취소</button>
          </div>
        ) : (
          <div className="mt-4 grid gap-3">
            <label className="text-xs font-semibold text-slate-200">대상 MineWiki 사용자명<input value={targetUsername} onChange={(event) => setTargetUsername(event.target.value)} maxLength={64} autoComplete="off" className="mt-2 min-h-11 w-full rounded-md border border-white/15 bg-[#111315] px-3 text-sm text-white" /></label>
            <label className="text-xs font-semibold text-slate-200">이전 사유<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={500} rows={3} className="mt-2 w-full rounded-md border border-white/15 bg-[#111315] p-3 text-sm text-white" /></label>
            <label className="flex gap-3 text-xs leading-5 text-slate-200"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-1 size-4" /> 수락 즉시 기존 소유자 권한과 서버 위키 API 토큰이 회수되며 되돌리려면 새 이전 요청이 필요함을 확인했습니다.</label>
            <label className="text-xs font-semibold text-slate-200">확인을 위해 서버 이름 입력: <span className="text-amber-200">{serverName}</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-white/15 bg-[#111315] px-3 text-sm text-white" /></label>
            <button type="button" onClick={() => void requestTransfer()} disabled={working || !targetUsername || reason.trim().length < 5 || !acknowledged || confirmation !== serverName} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-amber-300 px-4 text-sm font-bold text-black disabled:opacity-50">{working ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} 소유권 이전 요청 보내기</button>
          </div>
        )}
      </section>
    </PrivilegedActionGate>
  );
}

const DATE = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
function formatDate(value: string) { const time = Date.parse(value); return Number.isFinite(time) ? DATE.format(time) : '확인 필요'; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function apiMessage(value: unknown, fallback: string) { return isRecord(value) && typeof value.message === 'string' ? value.message : fallback; }
function message(value: unknown, fallback: string) { return value instanceof Error ? value.message : fallback; }
function parseTransfer(value: unknown): Transfer {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.serverId !== 'string' || typeof value.serverName !== 'string'
    || typeof value.serverAddress !== 'string' || typeof value.targetUsername !== 'string' || typeof value.targetDisplayName !== 'string' || typeof value.reason !== 'string'
    || typeof value.requestedAt !== 'string' || typeof value.expiresAt !== 'string' || typeof value.version !== 'number') {
    throw new Error('소유권 이전 응답 형식이 올바르지 않습니다.');
  }
  return value as unknown as Transfer;
}

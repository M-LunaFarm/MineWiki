'use client';

import Link from 'next/link';
import { Check, Loader2, RefreshCw, UserPlus, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { csrfHeaders } from '../../lib/csrf';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';

type Role = 'manager' | 'editor' | 'reviewer';

interface Invitation {
  readonly id: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly role: Role;
  readonly reason: string;
  readonly inviterName: string;
  readonly invitedAt: string;
  readonly expiresAt: string;
  readonly version: number;
}

const ROLE_LABEL: Record<Role, string> = { manager: '관리자', editor: '편집자', reviewer: '검토자' };
const DATE_FORMAT = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

export function ServerWikiInvitationsPanel() {
  const endpoint = `${normalizeApiBaseUrl()}/v1/me/server-wiki-collaborator-invitations`;
  const [items, setItems] = useState<readonly Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { credentials: 'include', cache: 'no-store' });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiMessage(body, '서버 위키 초대를 불러오지 못했습니다.'));
      setItems(parseItems(body));
    } catch (value) {
      setError(value instanceof Error ? value.message : '서버 위키 초대를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => { void load(); }, [load]);

  async function respond(item: Invitation, action: 'accept' | 'decline') {
    setWorkingId(item.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(item.id)}/${action}`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({ expectedVersion: item.version }),
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const fallback = response.status === 404 || response.status === 409
          ? '초대가 이미 처리되었거나 만료되었습니다. 최신 목록을 확인해 주세요.'
          : '협업 초대에 응답하지 못했습니다.';
        throw new Error(apiMessage(body, fallback));
      }
      setNotice(action === 'accept'
        ? `${item.serverName} 서버 위키의 ${ROLE_LABEL[item.role]} 역할을 수락했습니다.`
        : `${item.serverName} 서버 위키 초대를 거절했습니다.`);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : '협업 초대에 응답하지 못했습니다.');
    } finally {
      setWorkingId(null);
    }
  }

  return (
    <section id="server-wiki-invitations" aria-labelledby="server-wiki-invitations-title" aria-busy={loading || workingId !== null} className="mb-6 rounded-lg border border-[#30363d] bg-[#181a1d] p-6 shadow-sm scroll-mt-24">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="server-wiki-invitations-title" className="flex items-center gap-2 text-lg font-bold text-white"><UserPlus className="size-5 text-[#13ec80]" aria-hidden="true" /> 서버 위키 협업 초대</h3>
          <p className="mt-2 text-sm leading-6 text-[#a0a0a0]">초대를 직접 수락하기 전에는 권한이 생기지 않습니다. 응답하지 않은 초대는 7일 뒤 만료됩니다.</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading || workingId !== null} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-white/15 px-3 text-sm text-white disabled:opacity-50"><RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /> 새로고침</button>
      </div>

      {error ? <p className="mt-4 rounded-md border border-red-400/25 bg-red-500/10 p-3 text-sm text-red-100" role="alert">{error}</p> : null}
      {notice ? <p className="mt-4 rounded-md border border-[#13ec80]/25 bg-[#13ec80]/10 p-3 text-sm text-[#b9f8d9]" role="status" aria-live="polite">{notice}</p> : null}
      {loading ? <p className="mt-5 flex items-center gap-2 text-sm text-[#a0a0a0]" role="status" aria-live="polite"><Loader2 className="size-4 animate-spin" aria-hidden="true" /> 초대를 불러오는 중입니다.</p> : null}
      {!loading && items.length === 0 ? <p className="mt-5 rounded-md border border-dashed border-white/10 p-5 text-center text-sm text-[#777]">응답을 기다리는 초대가 없습니다.</p> : null}
      {!loading && items.length > 0 ? (
        <ul className="mt-5 space-y-3">
          {items.map((item) => {
            const working = workingId === item.id;
            return (
              <li key={item.id}>
                <article className="rounded-lg border border-white/10 bg-[#111315] p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2"><h4 className="font-bold text-white">{item.serverName}</h4><span className="rounded-full bg-[#13ec80]/10 px-2.5 py-1 text-xs font-semibold text-[#13ec80]">{ROLE_LABEL[item.role]}</span></div>
                      <p className="mt-2 text-sm text-[#b7b7b7]">{item.inviterName}님이 초대했습니다.</p>
                      <p className="mt-2 text-xs leading-5 text-[#888]">{item.reason}</p>
                      <p className="mt-2 text-xs text-[#777]">만료 <time dateTime={item.expiresAt}>{formatDate(item.expiresAt)}</time></p>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <button type="button" onClick={() => void respond(item, 'decline')} disabled={workingId !== null} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-red-400/25 px-4 text-sm font-semibold text-red-200 disabled:opacity-50"><X className="size-4" aria-hidden="true" /> 거절</button>
                      <button type="button" onClick={() => void respond(item, 'accept')} disabled={workingId !== null} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-[#13ec80] px-4 text-sm font-bold text-[#08130d] disabled:opacity-50">{working ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Check className="size-4" aria-hidden="true" />} 수락</button>
                    </div>
                  </div>
                  <Link href={`/servers/${encodeURIComponent(item.serverId)}`} className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-[#13ec80] hover:underline">서버 정보 보기</Link>
                </article>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function parseItems(value: unknown): readonly Invitation[] {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every(isInvitation)) throw new Error('초대 목록 응답 형식이 올바르지 않습니다.');
  return value.items;
}

function isInvitation(value: unknown): value is Invitation {
  return isRecord(value) && typeof value.id === 'string' && typeof value.serverId === 'string'
    && typeof value.serverName === 'string' && isRole(value.role) && typeof value.reason === 'string'
    && typeof value.inviterName === 'string' && typeof value.invitedAt === 'string'
    && typeof value.expiresAt === 'string' && typeof value.version === 'number';
}

function isRole(value: unknown): value is Role { return value === 'manager' || value === 'editor' || value === 'reviewer'; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function apiMessage(value: unknown, fallback: string): string { return isRecord(value) && typeof value.message === 'string' && value.message.trim() ? value.message : fallback; }
function formatDate(value: string): string { const time = Date.parse(value); return Number.isFinite(time) ? DATE_FORMAT.format(time) : '만료 시각 확인 필요'; }

'use client';

import { AlertTriangle, Clock3, Globe2, Laptop, LogOut, ShieldCheck, Smartphone } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  fetchSessions,
  revokeOtherSessions,
  revokeSession,
  type SessionSummary,
} from '../../lib/auth-client';

function inferDeviceLabel(userAgent: string | null): {
  readonly label: string;
  readonly icon: 'laptop' | 'phone';
} {
  if (!userAgent) {
    return { label: '알 수 없는 기기', icon: 'laptop' };
  }

  const normalized = userAgent.toLowerCase();
  if (
    normalized.includes('iphone') ||
    normalized.includes('android') ||
    normalized.includes('mobile')
  ) {
    return { label: '모바일 기기', icon: 'phone' };
  }

  return { label: '데스크톱 기기', icon: 'laptop' };
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}.${month}.${day} ${hours}:${minutes}:${seconds}`;
}

function formatIpAddress(ipAddress: string | null): string {
  if (!ipAddress) {
    return 'IP 미확인';
  }
  const normalized = ipAddress.trim().toLowerCase();
  if (
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized.startsWith('127.')
  ) {
    return '로컬 프록시 (127.0.0.1)';
  }
  return ipAddress;
}

export function SessionList() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  useEffect(() => {
    let mounted = true;
    const loadSessions = async () => {
      try {
        const payload = await fetchSessions();
        if (!mounted) {
          return;
        }
        setSessions(payload.sessions);
        setError(null);
      } catch (loadError) {
        if (!mounted) {
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : '세션 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
        );
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    void loadSessions();
    return () => {
      mounted = false;
    };
  }, []);

  const sortedSessions = useMemo(
    () => [...sessions].sort((left, right) => (left.lastActiveAt < right.lastActiveAt ? 1 : -1)),
    [sessions],
  );

  const hasOtherSessions = sortedSessions.some((session) => !session.isCurrent);

  const handleRevokeSession = async (sessionId: string) => {
    setPendingSessionId(sessionId);
    setNotice(null);
    try {
      await revokeSession(sessionId);
      setSessions((current) => current.filter((session) => session.sessionId !== sessionId));
      setError(null);
      setNotice('선택한 세션을 종료했습니다.');
    } catch (revokeError) {
      setError(
        revokeError instanceof Error
          ? revokeError.message
          : '세션을 종료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      );
    } finally {
      setPendingSessionId(null);
    }
  };

  const handleRevokeOthers = async () => {
    setRevokingOthers(true);
    setNotice(null);
    try {
      await revokeOtherSessions();
      setSessions((current) => current.filter((session) => session.isCurrent));
      setError(null);
      setNotice('현재 기기를 제외한 모든 세션을 종료했습니다.');
    } catch (revokeError) {
      setError(
        revokeError instanceof Error
          ? revokeError.message
          : '다른 기기 로그아웃에 실패했습니다. 잠시 후 다시 시도해 주세요.',
      );
    } finally {
      setRevokingOthers(false);
    }
  };

  return (
    <section className="rounded-lg border border-[#30363d] bg-[#181a1d] p-6 shadow-sm">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-bold text-white">
            <ShieldCheck className="h-5 w-5 text-[#13ec80]" />
            활성 세션
          </h3>
          <p className="mt-1 text-xs text-[#8f98a3]">현재 로그인된 기기와 접속 정보를 확인하실 수 있습니다.</p>
        </div>
        <button
          type="button"
          className="inline-flex items-center justify-center gap-2 rounded-md border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300 transition hover:border-red-400/60 hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => void handleRevokeOthers()}
          disabled={!hasOtherSessions || loading || revokingOthers}
        >
          <LogOut className="h-3.5 w-3.5" />
          {revokingOthers ? '처리 중입니다.' : '다른 기기 모두 로그아웃'}
        </button>
      </div>

      {error ? (
        <p className="mb-4 rounded-md border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {error}
        </p>
      ) : null}

      {notice ? (
        <p className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          {notice}
        </p>
      ) : null}

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, index) => (
            <div
              key={index}
              className="h-20 animate-pulse rounded-md border border-[#30363d] bg-[#111315]"
            />
          ))}
        </div>
      ) : sortedSessions.length === 0 ? (
        <p className="rounded-md border border-[#30363d] bg-[#111315] px-4 py-3 text-sm text-[#a0a0a0]">
          현재 활성화된 세션이 없습니다.
        </p>
      ) : (
        <ul className="max-h-[360px] space-y-3 overflow-y-auto pr-1">
          {sortedSessions.map((session) => {
            const device = inferDeviceLabel(session.userAgent);
            const isPending = pendingSessionId === session.sessionId;
            return (
              <li
                key={session.sessionId}
                className={`rounded-md border px-4 py-3 ${
                  session.isCurrent
                    ? 'border-[#13ec80]/35 bg-[#13ec80]/10'
                    : 'border-[#30363d] bg-[#111315]'
                }`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-[#30363d] bg-[#181a1d] text-[#c8d2dc]">
                      {device.icon === 'phone' ? (
                        <Smartphone className="h-5 w-5" />
                      ) : (
                        <Laptop className="h-5 w-5" />
                      )}
                    </span>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-white">{device.label}</p>
                        {session.isCurrent ? (
                          <span className="rounded border border-[#13ec80]/45 bg-[#13ec80]/20 px-1.5 py-0.5 text-[10px] font-bold text-[#13ec80]">
                            현재 세션
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 max-w-[28rem] truncate text-xs text-[#8f9bab]">
                        {session.userAgent ?? '사용자 에이전트 정보가 없습니다.'}
                      </p>
                    </div>
                  </div>

                  <div className="text-left sm:text-right">
                    <p className="flex items-center gap-1 text-xs text-[#a0a0a0] sm:justify-end">
                      <Clock3 className="h-3.5 w-3.5" />
                      마지막 활동
                    </p>
                    <p className="whitespace-nowrap text-xs tabular-nums text-white">
                      {formatDateTime(session.lastActiveAt)}
                    </p>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[#30363d] pt-3">
                  <div className="space-y-0.5 text-[11px] text-[#8f9bab]">
                    <p className="flex items-center gap-1">
                      <Globe2 className="h-3.5 w-3.5" />
                      {formatIpAddress(session.ipAddress)}
                    </p>
                    <p className="whitespace-nowrap tabular-nums">
                      세션 시작: {formatDateTime(session.createdAt)}
                    </p>
                    <p>토큰 버전: {session.tokenVersion}</p>
                  </div>

                  <button
                    type="button"
                    className="rounded-md border border-[#3b4248] px-3 py-1.5 text-xs font-medium text-white transition hover:border-red-300/50 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void handleRevokeSession(session.sessionId)}
                    disabled={session.isCurrent || isPending}
                  >
                    {session.isCurrent ? '현재 기기' : isPending ? '종료 중입니다.' : '세션 종료'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!hasOtherSessions && !loading ? (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          현재 다른 기기에 활성 세션이 없습니다.
        </div>
      ) : null}
    </section>
  );
}

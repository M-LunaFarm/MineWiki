'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clipboard,
  Clock3,
  Copy,
  Database,
  FileText,
  Loader2,
  RefreshCw,
  Server,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getApiBaseUrl } from '../../lib/runtime-config';
import { useAuth } from '../providers/auth-context';
import { fetchDashboardOverview, type DashboardServerSummary } from '../../lib/dashboard-api';
import { csrfHeaders } from '../../lib/csrf';
import { SUPPORTED_CLAIM_METHODS, type ClaimMethod } from '@minewiki/schemas/claim-methods';

type ClaimMethodState = 'pending' | 'verified' | 'expired' | 'failed';

interface ClaimMethodStatus {
  readonly method: ClaimMethod;
  readonly token?: string;
  readonly issuedAt: string;
  readonly status: ClaimMethodState;
  readonly verified: boolean;
  readonly verifiedAt?: string;
  readonly expiresAt?: string;
  readonly lastCheckedAt?: string;
  readonly note?: string;
}

interface ClaimStatusResponse {
  readonly serverId: string;
  readonly grade: 'Verified' | 'Unverified';
  readonly methods: ClaimMethodStatus[];
}

interface QueryServerTarget {
  readonly id: string;
  readonly name: string;
}

const METHOD_OPTIONS: Array<{
  readonly method: ClaimMethod;
  readonly title: string;
  readonly icon: string;
  readonly difficulty: '쉬움' | '보통' | '어려움';
  readonly estimate: string;
  readonly featured?: boolean;
  readonly summary: string;
  readonly recommendedWhen: string;
  readonly steps: readonly string[];
  readonly helper: string;
}> = [
  {
    method: 'dns',
    title: 'DNS TXT',
    icon: 'dns',
    difficulty: '보통',
    estimate: '~10분',
    summary: '서버 도메인에 TXT 레코드를 추가하여 도메인 관리 권한을 증명합니다.',
    recommendedWhen: '도메인 DNS 권한이 있고, 장기적으로 안정적인 소유 증명이 필요한 경우',
    steps: [
      'DNS 관리자에서 TXT 레코드를 추가합니다.',
      '호스트는 서버 접속 주소 기준 `_cvverify`, `_minewiki`, `_claim` 또는 루트 도메인을 사용할 수 있습니다.',
      '값: 아래 발급된 토큰 문자열을 그대로 입력합니다.',
      '전파 완료 후 소유권 검증을 실행합니다.',
    ],
    helper:
      'DNS 제공업체에 따라 전파까지 최대 10분이 걸릴 수 있습니다. 반영 후 검증을 실행해 주세요.',
  },
  {
    method: 'motd',
    title: 'MOTD',
    icon: 'description',
    difficulty: '쉬움',
    estimate: '~1분',
    summary: '서버 MOTD(접속 안내 문구)에 토큰을 삽입하여 서버 설정 권한을 확인합니다.',
    recommendedWhen: '서버 설정에 접근 가능하며 빠른 1회 검증이 필요한 경우',
    steps: [
      '서버 목록에 표시되는 MOTD 텍스트를 서버 설정 파일 또는 MOTD 플러그인에서 수정합니다.',
      'MOTD 안에 아래 토큰 문자열을 공백 없이 그대로 포함합니다.',
      '서버를 재시작하거나 MOTD가 새로고침되도록 한 뒤 검증을 실행합니다.',
    ],
    helper:
      'MOTD는 색 코드와 함께 사용할 수 있으나 토큰 문자열 자체는 줄바꿈, 색 코드, 공백으로 나누지 않아야 합니다.',
  },
];

const NOTE_COPY: Record<string, string> = {
  token_issued: '토큰이 발급되었습니다.',
  dns_token_confirmed: 'DNS TXT 토큰이 확인되었습니다.',
  dns_token_not_found: 'DNS TXT 토큰을 찾지 못했습니다.',
  motd_token_confirmed: 'MOTD 토큰이 확인되었습니다.',
  motd_token_not_found: 'MOTD에서 토큰을 찾지 못했습니다.',
  token_expired: '검증 만료 기간이 지나 만료되었습니다.',
};
const CLAIM_LOGS_HIDDEN_AFTER_KEY_PREFIX = 'minewiki_claim_logs_hidden_after';

function getClaimLogsHiddenAfterStorageKey(accountId: string, serverId: string): string {
  return `${CLAIM_LOGS_HIDDEN_AFTER_KEY_PREFIX}:${accountId}:${serverId}`;
}

function loadClaimLogsHiddenAfter(accountId: string, serverId: string): number | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(getClaimLogsHiddenAfterStorageKey(accountId, serverId));
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistClaimLogsHiddenAfter(
  accountId: string,
  serverId: string,
  value: number | null,
): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const key = getClaimLogsHiddenAfterStorageKey(accountId, serverId);
    if (value === null) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, String(value));
  } catch {
    // ignore localStorage write failures (e.g., private mode)
  }
}

function mergeMethods(
  previous: readonly ClaimMethodStatus[] | undefined,
  incoming: readonly ClaimMethodStatus[],
): ClaimMethodStatus[] {
  const map = new Map<ClaimMethod, ClaimMethodStatus>();
  for (const method of previous ?? []) {
    map.set(method.method, method);
  }
  for (const method of incoming) {
    const previousMethod = map.get(method.method);
    map.set(method.method, {
      ...method,
      ...(method.token ? {} : previousMethod?.token ? { token: previousMethod.token } : {}),
    });
  }
  return SUPPORTED_CLAIM_METHODS.map((method) => map.get(method)).filter(Boolean) as ClaimMethodStatus[];
}

function formatMethodLabel(method: ClaimMethod): string {
  return METHOD_OPTIONS.find((item) => item.method === method)?.title ?? method;
}

function formatStatusLabel(status: ClaimMethodState): string {
  switch (status) {
    case 'pending':
      return '대기';
    case 'verified':
      return '완료';
    case 'expired':
      return '만료';
    case 'failed':
      return '실패';
    default:
      return status;
  }
}

function formatDateTime(value?: string | null): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return date.toLocaleString('ko-KR');
}

function difficultyClass(level: '쉬움' | '보통' | '어려움'): string {
  switch (level) {
    case '쉬움':
      return 'text-emerald-300';
    case '보통':
      return 'text-amber-300';
    case '어려움':
      return 'text-rose-300';
    default:
      return 'text-slate-300';
  }
}

function difficultyLabel(level: '쉬움' | '보통' | '어려움'): string {
  return level;
}

function logDotClass(level: 'success' | 'error' | 'info'): string {
  switch (level) {
    case 'success':
      return 'bg-emerald-400';
    case 'error':
      return 'bg-rose-400';
    case 'info':
    default:
      return 'bg-sky-400';
  }
}

function methodIcon(method: ClaimMethod): LucideIcon {
  switch (method) {
    case 'dns':
      return Database;
    case 'motd':
      return FileText;
    default:
      return ShieldCheck;
  }
}

function methodStatusTone(status?: ClaimMethodState): {
  readonly label: string;
  readonly className: string;
  readonly dotClassName: string;
} {
  switch (status) {
    case 'verified':
      return {
        label: '검증 완료',
        className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
        dotClassName: 'bg-emerald-400',
      };
    case 'failed':
      return {
        label: '조치 필요',
        className: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
        dotClassName: 'bg-rose-400',
      };
    case 'expired':
      return {
        label: '만료됨',
        className: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
        dotClassName: 'bg-amber-400',
      };
    case 'pending':
      return {
        label: '대기 중',
        className: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
        dotClassName: 'bg-sky-400',
      };
    default:
      return {
        label: '미발급',
        className: 'border-[#333333] bg-[#121212] text-[#A0A0A0]',
        dotClassName: 'bg-[#555555]',
      };
  }
}

function formatVerificationStatus(grade?: 'Verified' | 'Unverified'): string {
  return grade === 'Verified' ? '검증 완료' : '미검증';
}

function formatVerificationValidity(status?: ClaimMethodState, expiresAt?: string): string {
  if (!status) {
    return '토큰을 발급한 뒤 선택한 검증 위치에 그대로 입력해 주세요.';
  }
  if (status === 'expired') {
    return '검증 상태가 만료되었습니다. 토큰을 재발급해 다시 검증해 주세요.';
  }
  if (status !== 'verified') {
    return '토큰을 검증 위치에 그대로 입력해 주세요. 검증 완료 후 상태가 24시간 유지됩니다.';
  }
  if (!expiresAt) {
    return '검증 유지 기간 정보를 확인할 수 없습니다.';
  }
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(diff)) {
    return '검증 유지 기간 정보를 확인할 수 없습니다.';
  }
  if (diff <= 0) {
    return '검증 상태가 만료되었습니다. 토큰을 재발급해 다시 검증해 주세요.';
  }
  const minutes = Math.floor(diff / 1000 / 60);
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `검증 상태가 약 ${hours}시간 ${remainMinutes}분 후 만료됩니다.`;
}

async function readApiErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null);
  const message = body && typeof body === 'object' && 'message' in body ? body.message : null;
  if (Array.isArray(message)) {
    return message.join(' ');
  }
  if (typeof message === 'string' && message.trim()) {
    return message;
  }
  return fallback;
}

function formatClaimApiError(
  statusCode: number,
  message: string,
  action: 'status' | 'start' | 'verify',
): string {
  if (statusCode === 401 || message === 'UNAUTHORIZED') {
    return '로그인 세션이 만료되었습니다. 다시 로그인한 뒤 진행해 주세요.';
  }
  if (statusCode === 403 && action === 'status') {
    return '아직 이 계정에서 관리 중인 서버가 아닙니다. 서버가 미소유 상태라면 검증 토큰을 발급해 소유권 연결을 시작할 수 있습니다.';
  }
  if (statusCode === 403 && action === 'start') {
    return '이미 다른 계정이 소유한 서버이거나 검증을 시작할 권한이 없습니다. 서버 ID가 맞는지 확인해 주세요.';
  }
  if (statusCode === 403 && action === 'verify') {
    return '이 계정에서 발급한 토큰으로만 검증할 수 있습니다. 토큰을 발급한 계정으로 로그인해 주세요.';
  }
  return message;
}

interface VerificationLogItem {
  readonly at: string;
  readonly level: 'success' | 'error' | 'info';
  readonly title: string;
  readonly detail: string;
}

export function ClaimWorkflow() {
  const { account, loading } = useAuth();
  const [ownedServers, setOwnedServers] = useState<DashboardServerSummary[]>([]);
  const [serversLoading, setServersLoading] = useState(false);
  const [serverId, setServerId] = useState('');
  const [selectedMethod, setSelectedMethod] = useState<ClaimMethod>('dns');
  const [status, setStatus] = useState<ClaimStatusResponse | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [logsHiddenAfter, setLogsHiddenAfter] = useState<number | null>(null);
  const [claimedRequestedServerIds, setClaimedRequestedServerIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const apiBase = getApiBaseUrl();
  const [queryServerLookup, setQueryServerLookup] = useState<string | null>(null);
  const [queryServerTarget, setQueryServerTarget] = useState<QueryServerTarget | null>(null);
  const [queryServerLoading, setQueryServerLoading] = useState(false);
  const accountId = account?.id ?? null;

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    setQueryServerLookup(params.get('serverId'));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const lookup = queryServerLookup?.trim();
    if (!lookup) {
      setQueryServerTarget(null);
      return;
    }

    async function resolveQueryServer() {
      setQueryServerLoading(true);
      setError(null);
      try {
        const response = await fetch(`${apiBase}/v1/servers/${encodeURIComponent(lookup)}`, {
          credentials: 'include',
        });
        if (!response.ok) {
          throw new Error('URL로 지정된 서버를 찾지 못했습니다.');
        }
        const detail = (await response.json()) as { id?: unknown; name?: unknown };
        if (typeof detail.id !== 'string' || !detail.id.trim()) {
          throw new Error('URL로 지정된 서버 정보를 확인하지 못했습니다.');
        }
        if (!cancelled) {
          setQueryServerTarget({
            id: detail.id,
            name:
              typeof detail.name === 'string' && detail.name.trim() ? detail.name : '요청된 서버',
          });
        }
      } catch (lookupError) {
        if (!cancelled) {
          setQueryServerTarget(null);
          setError(
            lookupError instanceof Error
              ? lookupError.message
              : 'URL로 지정된 서버 정보를 확인하지 못했습니다.',
          );
        }
      } finally {
        if (!cancelled) {
          setQueryServerLoading(false);
        }
      }
    }

    void resolveQueryServer();
    return () => {
      cancelled = true;
    };
  }, [apiBase, queryServerLookup]);

  useEffect(() => {
    let cancelled = false;
    if (!account) {
      setOwnedServers([]);
      setServerId('');
      return;
    }
    async function loadServers() {
      setServersLoading(true);
      try {
        const overview = await fetchDashboardOverview();
        if (cancelled) {
          return;
        }
        setOwnedServers(overview.servers);
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : '보유 중인 서버 목록을 가져오지 못했습니다.',
        );
        setOwnedServers([]);
      } finally {
        if (!cancelled) {
          setServersLoading(false);
        }
      }
    }
    void loadServers();
    return () => {
      cancelled = true;
    };
  }, [account]);

  useEffect(() => {
    if (serversLoading || queryServerLoading) {
      return;
    }
    const preferred = queryServerTarget?.id;
    if (preferred) {
      setServerId(preferred);
      return;
    }
    if (ownedServers.length === 0) {
      return;
    }
    setServerId((current) => {
      if (current && ownedServers.some((server) => server.id === current)) {
        return current;
      }
      return ownedServers[0]?.id ?? '';
    });
  }, [ownedServers, queryServerLoading, queryServerTarget, serversLoading]);

  useEffect(() => {
    if (!accountId || !serverId) {
      setLogsHiddenAfter(null);
      return;
    }
    setLogsHiddenAfter(loadClaimLogsHiddenAfter(accountId, serverId));
  }, [accountId, serverId]);

  const activeMethod = useMemo(() => {
    return METHOD_OPTIONS.find((option) => option.method === selectedMethod) ?? METHOD_OPTIONS[0];
  }, [selectedMethod]);

  const activeMethodStatus = useMemo(() => {
    return status?.methods.find((method) => method.method === selectedMethod) ?? null;
  }, [status, selectedMethod]);

  const selectedServer = useMemo(() => {
    const ownedServer = ownedServers.find((server) => server.id === serverId);
    if (ownedServer) {
      return ownedServer;
    }
    if (queryServerTarget && serverId === queryServerTarget.id) {
      return queryServerTarget;
    }
    return null;
  }, [ownedServers, queryServerTarget, serverId]);

  const isKnownOwnedServer = useMemo(() => {
    return Boolean(serverId && ownedServers.some((server) => server.id === serverId));
  }, [ownedServers, serverId]);

  const wasClaimedInSession = Boolean(serverId && claimedRequestedServerIds.has(serverId));

  const isRequestedExternalServer = Boolean(
    queryServerTarget &&
      serverId === queryServerTarget.id &&
      !isKnownOwnedServer &&
      !wasClaimedInSession,
  );

  const verifiedCount = useMemo(() => {
    return status?.methods.filter((method) => method.status === 'verified').length ?? 0;
  }, [status]);

  const failedCount = useMemo(() => {
    return status?.methods.filter((method) => method.status === 'failed').length ?? 0;
  }, [status]);

  const progressPercent = useMemo(() => {
    return verifiedCount > 0 ? 100 : 0;
  }, [verifiedCount]);

  const latestCheckedAt = useMemo(() => {
    const allDates =
      status?.methods
        .flatMap((method) => [method.lastCheckedAt, method.verifiedAt, method.issuedAt])
        .filter(Boolean) ?? [];
    if (allDates.length === 0) {
      return null;
    }
    return allDates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
  }, [status]);

  const verificationLogs = useMemo<VerificationLogItem[]>(() => {
    if (!status) {
      return [];
    }
    const logs: VerificationLogItem[] = [];
    for (const method of status.methods) {
      const label = formatMethodLabel(method.method);
      if (method.issuedAt) {
        logs.push({
          at: method.issuedAt,
          level: 'info',
          title: `${label} 토큰 발급`,
          detail: '검증 토큰이 생성되었습니다.',
        });
      }
      if (method.lastCheckedAt) {
        logs.push({
          at: method.lastCheckedAt,
          level:
            method.status === 'verified'
              ? 'success'
              : method.status === 'failed'
                ? 'error'
                : 'info',
          title: `${label} 상태 점검`,
          detail: method.note
            ? (NOTE_COPY[method.note] ?? method.note)
            : `${formatStatusLabel(method.status)} 상태입니다.`,
        });
      }
      if (method.verifiedAt) {
        logs.push({
          at: method.verifiedAt,
          level: 'success',
          title: `${label} 검증 완료`,
          detail: '소유권 확인이 정상적으로 완료되었습니다.',
        });
      }
    }
    return logs.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 20);
  }, [status]);

  const fetchStatus = useCallback(
    async (silent = false): Promise<ClaimStatusResponse | null> => {
      if (!account || !serverId) {
        return null;
      }
      if (!silent) {
        setError(null);
        setNotice(null);
        setIsBusy(true);
      }
      try {
        const response = await fetch(`${apiBase}/v1/servers/${serverId}/claim/status`, {
          credentials: 'include',
        });
        if (!response.ok) {
          const message = await readApiErrorMessage(response, '상태 조회에 실패했습니다.');
          if (response.status === 403 && isRequestedExternalServer) {
            setStatus(null);
            if (!silent) {
              setNotice(formatClaimApiError(response.status, message, 'status'));
            }
            return null;
          }
          throw new Error(formatClaimApiError(response.status, message, 'status'));
        }
        const result = (await response.json()) as ClaimStatusResponse;
        setStatus((current) => ({
          ...result,
          methods: mergeMethods(current?.methods, result.methods),
        }));
        if (!silent) {
          setNotice('검증 상태를 최신 정보로 갱신했습니다.');
        }
        return result;
      } catch (refreshError) {
        if (!silent || !isRequestedExternalServer) {
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : '상태 조회 중 오류가 발생했습니다.',
          );
        }
        return null;
      } finally {
        if (!silent) {
          setIsBusy(false);
        }
      }
    },
    [account, apiBase, isRequestedExternalServer, serverId],
  );

  useEffect(() => {
    if (!account || !serverId) {
      return;
    }
    void fetchStatus(true);
  }, [account, serverId, fetchStatus]);

  const handleSelectMethod = (method: ClaimMethod) => {
    setSelectedMethod(method);
    setError(null);
    setNotice(null);
  };

  const handleStart = async () => {
    if (!account) {
      return;
    }
    if (!serverId) {
      setError('검증할 서버를 선택해 주세요.');
      return;
    }
    setError(null);
    setNotice(null);
    setIsBusy(true);
    try {
      const response = await fetch(`${apiBase}/v1/servers/${serverId}/claim/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        credentials: 'include',
        body: JSON.stringify({ methods: [selectedMethod] }),
      });
      if (!response.ok) {
        const message = await readApiErrorMessage(response, '검증 토큰 발급에 실패했습니다.');
        throw new Error(formatClaimApiError(response.status, message, 'start'));
      }
      const methods = (await response.json()) as ClaimMethodStatus[];
      if (isRequestedExternalServer) {
        setClaimedRequestedServerIds((current) => {
          const next = new Set(current);
          next.add(serverId);
          return next;
        });
      }
      setStatus((current) => ({
        serverId,
        grade: current?.grade ?? 'Unverified',
        methods: mergeMethods(current?.methods, methods),
      }));
      setNotice(`${formatMethodLabel(selectedMethod)} 토큰을 발급했습니다.`);
      void fetchStatus(true);
    } catch (startError) {
      setError(
        startError instanceof Error ? startError.message : '토큰 발급 중 오류가 발생했습니다.',
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleVerify = async () => {
    if (!account) {
      return;
    }
    if (!serverId) {
      setError('검증할 서버를 선택해 주세요.');
      return;
    }
    const proof = activeMethodStatus?.token;
    if (!proof) {
      setError('발급된 토큰이 없습니다. 먼저 토큰을 발급해 주세요.');
      return;
    }
    setError(null);
    setNotice(null);
    setIsBusy(true);
    try {
      const response = await fetch(`${apiBase}/v1/servers/${serverId}/claim/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        credentials: 'include',
        body: JSON.stringify({ method: selectedMethod, proof }),
      });
      if (!response.ok) {
        const message = await readApiErrorMessage(response, '검증 요청이 실패했습니다.');
        throw new Error(formatClaimApiError(response.status, message, 'verify'));
      }
      const result = (await response.json()) as ClaimStatusResponse;
      setStatus((current) => ({
        ...result,
        methods: mergeMethods(current?.methods, result.methods),
      }));
      const selected = result.methods.find((method) => method.method === selectedMethod);
      if (selected?.status === 'verified') {
        setNotice(`${formatMethodLabel(selectedMethod)} 검증이 완료되었습니다.`);
      } else if (selected?.status === 'failed') {
        const noteMessage = selected.note ? (NOTE_COPY[selected.note] ?? selected.note) : null;
        setNotice(noteMessage ?? `${formatMethodLabel(selectedMethod)} 검증이 실패했습니다.`);
      } else {
        setNotice(`${formatMethodLabel(selectedMethod)} 검증 요청을 처리했습니다.`);
      }
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : '검증 중 오류가 발생했습니다.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleFetchStatus = async () => {
    await fetchStatus(false);
  };

  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice('클립보드에 복사했습니다.');
      setError(null);
    } catch {
      setError('클립보드 복사에 실패했습니다.');
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-[#333333] bg-[#1A1A1A] p-6 text-sm text-[#A0A0A0]">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-[#13ec80]" />
          <div>
            <p className="font-medium text-white">검증 콘솔을 준비하고 있습니다.</p>
            <p className="mt-1 text-xs">계정 세션과 서버 목록을 확인하는 중입니다.</p>
          </div>
        </div>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="rounded-xl border border-[#333333] bg-[#1A1A1A] p-6 text-sm text-[#A0A0A0]">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-[#13ec80]" />
          <div>
            <p className="font-medium text-white">로그인이 필요합니다.</p>
            <p className="mt-1">
              서버 소유권 검증은 인증된 계정에서만 사용할 수 있습니다. Discord, Naver 또는 Email
              계정으로 로그인한 뒤 다시 진행해 주세요.
            </p>
          </div>
        </div>
        <Link
          className="mt-4 inline-flex text-xs font-medium text-[#13ec80] hover:underline"
          href="/me"
        >
          계정 페이지로 이동
        </Link>
      </div>
    );
  }

  const tokenString = activeMethodStatus?.token ?? '';
  const tokenIssuedAt = activeMethodStatus?.issuedAt
    ? new Date(activeMethodStatus.issuedAt).toLocaleString('ko-KR')
    : null;
  const displayedLogs =
    logsHiddenAfter === null
      ? verificationLogs
      : verificationLogs.filter((item) => {
          const timestamp = new Date(item.at).getTime();
          return Number.isFinite(timestamp) && timestamp > logsHiddenAfter;
        });

  const handleClearLogs = () => {
    const latestDisplayedLogAt = displayedLogs.reduce((latest, item) => {
      const timestamp = new Date(item.at).getTime();
      if (!Number.isFinite(timestamp)) {
        return latest;
      }
      return Math.max(latest, timestamp);
    }, Date.now());
    setLogsHiddenAfter(latestDisplayedLogAt);

    if (!accountId || !serverId) {
      return;
    }
    persistClaimLogsHiddenAfter(accountId, serverId, latestDisplayedLogAt);
  };

  const runPrimaryAction = async () => {
    if (activeMethodStatus?.status === 'verified') {
      await handleFetchStatus();
      return;
    }
    if (tokenString && activeMethodStatus?.status !== 'expired') {
      await handleVerify();
      return;
    }
    await handleStart();
  };
  const primaryActionLabel =
    activeMethodStatus?.status === 'verified'
      ? '검증 상태 새로고침'
      : activeMethodStatus?.status === 'expired'
        ? '검증 토큰 재발급'
        : tokenString
            ? activeMethodStatus?.status === 'failed'
              ? '다시 검증 실행'
              : '소유권 검증 실행'
            : '검증 토큰 발급';

  return (
    <section className="claim-surface pb-16 text-white">
      <div className="mb-8 border-b border-[#2a2a2d] pb-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[#333333] bg-[#121212] px-3 py-1 text-xs font-medium text-[#A0A0A0]">
              <ShieldCheck className="h-3.5 w-3.5 text-[#13ec80]" />
              서버 소유 확인
            </div>
            <h1 className="text-3xl font-bold tracking-tight">서버 소유권 검증</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[#A0A0A0]">
              서버 설정 권한을 확인하는 절차입니다. DNS TXT 또는 MOTD 중 하나를 선택해 토큰을
              발급하고, 서버 설정에 반영한 뒤 이 화면에서 검증을 실행해 주세요.
            </p>
          </div>

          <div className="grid min-w-full grid-cols-3 overflow-hidden rounded-xl border border-[#333333] bg-[#121212] lg:min-w-[420px]">
            <div className="border-r border-[#333333] p-4">
              <p className="text-[11px] font-medium uppercase tracking-wider text-[#777777]">
                현재 상태
              </p>
              <p className="mt-1 text-sm font-semibold text-white">
                {formatVerificationStatus(status?.grade)}
              </p>
            </div>
            <div className="border-r border-[#333333] p-4">
              <p className="text-[11px] font-medium uppercase tracking-wider text-[#777777]">
                충족 여부
              </p>
              <p className="mt-1 text-sm font-semibold text-[#13ec80]">
                {verifiedCount > 0 ? '충족' : '대기'}
              </p>
            </div>
            <div className="p-4">
              <p className="text-[11px] font-medium uppercase tracking-wider text-[#777777]">
                마지막 확인
              </p>
              <p className="mt-1 text-sm font-semibold text-white">
                {formatDateTime(latestCheckedAt)}
              </p>
            </div>
          </div>
        </div>
      </div>

      {notice ? (
        <div className="mb-4 rounded-lg border border-[#13ec80]/30 bg-[#13ec80]/10 p-3 text-sm text-[#d8ffef]">
          {notice}
        </div>
      ) : null}
      {verifiedCount > 0 && serverId ? (
        <div className="mb-6 flex flex-col gap-4 rounded-xl border border-[#13ec80]/30 bg-[#101a14] p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold text-white">소유권 연결이 완료되었습니다.</p>
            <p className="mt-1 text-sm leading-6 text-[#A0A0A0]">
              서버 관리 화면에서 프로필과 투표 연동을 설정하고, 자동 준비된 서버 위키 초안을 편집해 첫 릴리스를 발행할 수 있습니다.
            </p>
          </div>
          <Link
            href={`/servers/${encodeURIComponent(serverId)}`}
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#13ec80] px-4 py-2 text-sm font-bold text-black transition hover:bg-[#0fb865]"
          >
            서버 관리 계속하기
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      ) : null}
      {error ? (
        <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </div>
      ) : null}

      <div className="mb-8 rounded-xl border border-[#333333] bg-[#1A1A1A] p-5">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,360px)_1fr] lg:items-center">
          <div>
            <label
              htmlFor="claim-server"
              className="mb-2 block text-xs font-medium uppercase tracking-wider text-[#A0A0A0]"
            >
              대상 서버
            </label>
            <div className="relative">
              <select
                id="claim-server"
                className="w-full cursor-pointer appearance-none rounded-lg border border-[#333333] bg-[#121212] py-3 pl-4 pr-10 text-sm text-white transition-colors hover:border-[#A0A0A0] focus:border-[#13ec80] focus:outline-none focus:ring-1 focus:ring-[#13ec80]"
                value={serverId}
                onChange={(event) => {
                  setServerId(event.target.value);
                  setStatus(null);
                  setLogsHiddenAfter(null);
                }}
                disabled={serversLoading || queryServerLoading}
              >
                {queryServerLoading ? <option value="">URL 서버 확인 중</option> : null}
                {serverId && !ownedServers.some((server) => server.id === serverId) ? (
                  <option value={serverId}>
                    {selectedServer?.name ?? '요청된 서버'} ({serverId})
                  </option>
                ) : null}
                {ownedServers.length === 0 && !serverId ? (
                  <option value="">등록된 서버가 없습니다</option>
                ) : null}
                {ownedServers.map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.name}
                  </option>
                ))}
              </select>
              <Server className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#777777]" />
            </div>
            <p className="mt-2 break-all font-mono text-xs text-[#777777]">
              서버 ID: <span className="text-[#CFCFCF]">{serverId || '-'}</span>
            </p>
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <p className="text-xs font-medium uppercase tracking-wider text-[#A0A0A0]">
                검증 충족 상태
              </p>
              <p className="text-xs text-[#A0A0A0]">최소 1개 방식 완료 필요</p>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full border border-[#333333] bg-[#121212]">
              <div
                className="h-full rounded-full bg-[#13ec80] transition-[width]"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {SUPPORTED_CLAIM_METHODS.map((method) => {
                const methodStatus = status?.methods.find((item) => item.method === method);
                const tone = methodStatusTone(methodStatus?.status);
                return (
                  <div
                    key={method}
                    className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs ${tone.className}`}
                  >
                    <span className="font-medium">{formatMethodLabel(method)}</span>
                    <span className="flex items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 rounded-full ${tone.dotClassName}`} />
                      {tone.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {isRequestedExternalServer ? (
          <div className="mt-5 rounded-lg border border-blue-400/30 bg-blue-400/10 p-4 text-sm text-blue-100">
            URL로 지정된 서버입니다. 아직 이 계정의 관리 서버 목록에는 없습니다. 서버가 미소유
            상태라면 토큰 발급 시 이 계정에 연결되며, 이미 다른 계정이 소유한 서버라면 발급이
            차단됩니다.
          </div>
        ) : null}
        {ownedServers.length === 0 && !serverId && !serversLoading && !queryServerLoading ? (
          <div className="mt-5 rounded-lg border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">
            등록된 서버가 없습니다. 서버를 먼저 등록한 뒤 소유권 검증을 진행해 주세요.
          </div>
        ) : null}
      </div>

      <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-3">
        {METHOD_OPTIONS.map((option) => {
          const methodStatus = status?.methods.find((method) => method.method === option.method);
          const isSelected = selectedMethod === option.method;
          const tone = methodStatusTone(methodStatus?.status);
          const Icon = methodIcon(option.method);
          return (
            <button
              key={option.method}
              type="button"
              onClick={() => handleSelectMethod(option.method)}
              className={`min-h-[168px] rounded-xl border p-4 text-left transition-colors ${
                isSelected
                  ? 'border-[#13ec80] bg-[#162019]'
                  : 'border-[#333333] bg-[#1A1A1A] hover:border-[#666666] hover:bg-[#202020]'
              }`}
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span
                    className={`flex h-10 w-10 items-center justify-center rounded-lg border ${
                      isSelected
                        ? 'border-[#13ec80]/30 bg-[#13ec80]/10 text-[#13ec80]'
                        : 'border-[#333333] bg-[#121212] text-[#A0A0A0]'
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="font-semibold text-white">{option.title}</h3>
                    <p className="mt-1 text-xs text-[#A0A0A0]">{option.estimate}</p>
                  </div>
                </div>
                {methodStatus?.status === 'verified' ? (
                  <CheckCircle2 className="h-5 w-5 text-[#13ec80]" />
                ) : null}
              </div>
              <p className="text-sm leading-5 text-[#A0A0A0]">{option.summary}</p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2 py-1 text-[11px] ${tone.className}`}>
                  {tone.label}
                </span>
                <span className={`text-[11px] font-medium ${difficultyClass(option.difficulty)}`}>
                  {difficultyLabel(option.difficulty)}
                </span>
                {option.featured ? (
                  <span className="rounded-full border border-[#13ec80]/30 bg-[#13ec80]/10 px-2 py-1 text-[11px] text-[#13ec80]">
                    권장
                  </span>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mb-10 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-xl border border-[#333333] bg-[#1A1A1A]">
          <div className="border-b border-[#333333] p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-[#777777]">
                  선택한 방식
                </p>
                <h2 className="mt-2 text-xl font-semibold text-white">
                  {activeMethod.title} 검증 절차
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[#A0A0A0]">
                  {activeMethod.summary}
                </p>
              </div>
              <div
                className={`rounded-full border px-3 py-1 text-xs ${methodStatusTone(activeMethodStatus?.status).className}`}
              >
                {methodStatusTone(activeMethodStatus?.status).label}
              </div>
            </div>
          </div>

          <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="p-6">
              <div className="mb-6">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <label className="text-xs font-medium uppercase tracking-wider text-[#A0A0A0]">
                    검증 토큰
                  </label>
                  {tokenIssuedAt ? (
                    <span className="text-xs text-[#777777]">발급 {tokenIssuedAt}</span>
                  ) : null}
                </div>
                <div className="flex items-stretch gap-2">
                  <code
                    className={`min-h-[52px] flex-1 select-all rounded-lg border px-4 py-3 font-mono text-sm leading-6 ${
                      tokenString
                        ? 'border-[#13ec80]/30 bg-[#101812] text-[#13ec80]'
                        : 'border-dashed border-[#333333] bg-[#121212] text-[#777777]'
                    }`}
                  >
                    {tokenString || '토큰을 발급하면 여기에 표시됩니다.'}
                  </code>
                  <button
                    type="button"
                    title="토큰 복사"
                    aria-label="토큰 복사"
                    onClick={() => void handleCopy(tokenString)}
                    disabled={!tokenString}
                    className="flex w-12 items-center justify-center rounded-lg border border-[#333333] bg-[#222222] text-white transition-colors enabled:hover:border-[#13ec80]/40 enabled:hover:text-[#13ec80] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
                <p className="mt-2 flex items-center gap-1.5 text-xs text-[#A0A0A0]">
                  <Clock3 className="h-3.5 w-3.5" />
                  {formatVerificationValidity(
                    activeMethodStatus?.status,
                    activeMethodStatus?.expiresAt,
                  )}
                </p>
              </div>

              <div className="space-y-3">
                {activeMethod.steps.map((step, index) => {
                  const isComplete = Boolean(tokenString) && index === 0;
                  return (
                    <div
                      key={step}
                      className="flex items-start gap-3 rounded-lg border border-[#333333] bg-[#121212] p-4"
                    >
                      <div
                        className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                          isComplete
                            ? 'border-[#13ec80]/40 bg-[#13ec80]/10 text-[#13ec80]'
                            : 'border-[#444444] bg-[#1A1A1A] text-[#A0A0A0]'
                        }`}
                      >
                        {isComplete ? <CheckCircle2 className="h-4 w-4" /> : index + 1}
                      </div>
                      <p className="min-w-0 text-sm font-medium leading-5 text-white">{step}</p>
                    </div>
                  );
                })}
              </div>
            </div>

            <aside className="border-t border-[#333333] p-6 lg:border-l lg:border-t-0">
              <div className="rounded-lg border border-[#333333] bg-[#121212] p-4">
                <div className="mb-3 flex items-center gap-2">
                  <TerminalSquare className="h-4 w-4 text-[#13ec80]" />
                  <h3 className="text-sm font-semibold text-white">검증 조건</h3>
                </div>
                <p className="text-sm leading-6 text-[#A0A0A0]">{activeMethod.helper}</p>
                <p className="mt-4 text-xs leading-5 text-[#777777]">
                  권장 상황: {activeMethod.recommendedWhen}
                </p>
              </div>

              <div className="mt-4 rounded-lg border border-[#333333] bg-[#121212] p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-[#777777]">
                  대상 서버
                </p>
                <p className="mt-2 truncate text-sm font-semibold text-white">
                  {selectedServer?.name ?? '서버 미선택'}
                </p>
                <p className="mt-1 break-all font-mono text-xs text-[#777777]">{serverId || '-'}</p>
                <div className="mt-4 flex items-center justify-between text-xs text-[#A0A0A0]">
                  <span>실패 횟수</span>
                  <span className={failedCount > 0 ? 'text-rose-300' : 'text-[#CFCFCF]'}>
                    {failedCount}
                  </span>
                </div>
              </div>
            </aside>
          </div>

          <div className="flex flex-col gap-3 border-t border-[#333333] p-6 sm:flex-row">
            <button
              type="button"
              onClick={() => void runPrimaryAction()}
              disabled={isBusy || serversLoading || queryServerLoading || !serverId}
              className="btn-primary-shadow flex flex-1 items-center justify-center gap-2 rounded-lg bg-[#13ec80] px-6 py-3.5 text-sm font-semibold text-black transition-colors hover:bg-[#0fb865] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : tokenString && activeMethodStatus?.status !== 'expired' ? (
                <ShieldCheck className="h-4 w-4" />
              ) : (
                <Clipboard className="h-4 w-4" />
              )}
              {primaryActionLabel}
            </button>
            <button
              type="button"
              onClick={() => void handleFetchStatus()}
              disabled={isBusy || serversLoading || queryServerLoading || !serverId}
              className="flex items-center justify-center gap-2 rounded-lg border border-[#333333] bg-transparent px-6 py-3.5 text-sm font-medium text-white transition-colors hover:border-[#A0A0A0] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw className="h-4 w-4" />
              상태 확인
            </button>
          </div>
        </div>

        <div className="flex min-h-[520px] flex-col rounded-xl border border-[#333333] bg-[#1A1A1A]">
          <div className="flex items-center justify-between border-b border-[#333333] p-4">
            <div>
              <h3 className="text-sm font-semibold text-white">검증 이벤트</h3>
              <p className="mt-1 text-xs text-[#777777]">최근 20개 이벤트가 표시됩니다.</p>
            </div>
            <button
              type="button"
              onClick={handleClearLogs}
              className="rounded-lg border border-[#333333] px-3 py-1.5 text-xs text-[#A0A0A0] transition-colors hover:border-[#666666] hover:text-white"
            >
              기록 숨기기
            </button>
          </div>
          <div className="relative max-h-[520px] flex-1 overflow-y-auto p-4 before:absolute before:bottom-4 before:left-[19px] before:top-4 before:w-px before:bg-[#333333]">
            {displayedLogs.length === 0 ? (
              <div className="relative pl-9">
                <div className="absolute left-0 top-1 z-10 flex h-10 w-10 items-center justify-center rounded-full border border-[#333333] bg-[#121212]">
                  <Clock3 className="h-4 w-4 text-[#777777]" />
                </div>
                <p className="font-mono text-xs text-[#777777]">--:--:--</p>
                <p className="mt-1 text-sm font-medium text-white">이벤트가 없습니다.</p>
                <p className="mt-1 text-xs leading-5 text-[#A0A0A0]">
                  토큰 발급 또는 검증 실행 후 서버 응답이 이 영역에 기록됩니다.
                </p>
              </div>
            ) : (
              displayedLogs.map((item) => {
                const time = new Date(item.at).toLocaleTimeString('ko-KR', { hour12: false });
                return (
                  <div key={`${item.at}-${item.title}`} className="relative pb-6 pl-9">
                    <div
                      className={`absolute left-[14px] top-1 z-10 h-2.5 w-2.5 rounded-full border-2 border-[#1A1A1A] ${logDotClass(
                        item.level,
                      )}`}
                    />
                    <p className="mb-1 font-mono text-xs text-[#777777]">{time}</p>
                    <p
                      className={`text-sm font-medium ${item.level === 'error' ? 'text-rose-300' : 'text-white'}`}
                    >
                      {item.title}
                    </p>
                    <p
                      className={`mt-1 text-xs leading-5 ${
                        item.level === 'error' ? 'break-all text-rose-200' : 'text-[#A0A0A0]'
                      }`}
                    >
                      {item.detail}
                    </p>
                  </div>
                );
              })
            )}
          </div>
          <div className="border-t border-[#333333] bg-[#121212] p-4">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 text-amber-300" />
              <div>
                <h4 className="text-xs font-semibold text-amber-200">점검 기준</h4>
                <p className="mt-1 text-xs leading-5 text-[#A0A0A0]">
                  토큰 불일치가 발생하면 발급된 토큰, 서버 설정 파일, DNS 전파 상태를 순서대로
                  확인해 주세요.
                </p>
                <Link
                  className="mt-2 inline-block text-xs text-[#13ec80] underline hover:text-[#8bffd1]"
                  href="/policies/usage"
                >
                  이용 가이드 보기
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, Loader2, ShieldCheck, SquareArrowOutUpRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MinecraftIdentity } from '@minewiki/schemas';
import { createAccountMergeRequest } from '../../lib/auth-client';
import { getApiBaseUrl } from '../../lib/runtime-config';
import { csrfHeaders } from '../../lib/csrf';

const API_BASE_URL = getApiBaseUrl();
const VERIFY_ORIGIN = normalizeOrigin(
  process.env.NEXT_PUBLIC_VERIFY_URL ?? 'https://verify.minewiki.kr',
);

interface PendingAuthorization {
  readonly authorizationUrl: string;
  readonly state: string;
}

type FlowStage = 'idle' | 'popup' | 'callback' | 'verifying' | 'completed' | 'error';

function stepTone(active: boolean, done: boolean): string {
  if (active || done) {
    return 'border-[#13ec80]/[.45] bg-[#13ec80]/[.12]';
  }
  return 'border-white/10 bg-[#121212] opacity-70';
}

function buildAvatarCandidates(uuid: string): string[] {
  const compactUuid = uuid.replace(/-/g, '');
  return [
    `https://mc-heads.net/avatar/${compactUuid}/96`,
    `https://crafatar.com/avatars/${compactUuid}?size=96&overlay`,
  ];
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return 'https://verify.minewiki.kr';
  }
}

async function completeDiscordVerifySession(
  sessionId: string,
  completionToken: string,
  identity: MinecraftIdentity,
): Promise<void> {
  const response = await fetch(
    `${API_BASE_URL}/v1/verify/discord/sessions/${encodeURIComponent(sessionId)}/complete`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
      body: JSON.stringify({
        completionToken,
        minecraftUuid: identity.uuid,
        playerName: identity.playerName,
      }),
    },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      typeof body?.message === 'string'
        ? body.message
        : 'Discord 검증 세션을 완료하지 못했습니다.',
    );
  }
}

export function MinecraftOwnershipPanel() {
  const oauthPopupRef = useRef<Window | null>(null);
  const searchParams = useSearchParams();
  const verifySessionId = searchParams.get('verifySessionId');
  const verifyToken = searchParams.get('verifyToken');
  const requestedReturnTo = searchParams.get('returnTo');
  const returnTo = requestedReturnTo?.startsWith('/') && !requestedReturnTo.startsWith('//')
    ? requestedReturnTo
    : null;
  const [identity, setIdentity] = useState<MinecraftIdentity | null>(null);
  const [identities, setIdentities] = useState<MinecraftIdentity[]>([]);
  const [playerName, setPlayerName] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'verifying' | 'loadingIdentity'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pendingAuth, setPendingAuth] = useState<PendingAuthorization | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const [flowStage, setFlowStage] = useState<FlowStage>('idle');
  const [discordVerifyStatus, setDiscordVerifyStatus] = useState<string | null>(null);
  const [mergeTicketId, setMergeTicketId] = useState<string | null>(null);
  const [mergeRequestStatus, setMergeRequestStatus] = useState<string | null>(null);
  const [creatingMergeRequest, setCreatingMergeRequest] = useState(false);

  const isBusy =
    status !== 'idle' ||
    isStarting ||
    isRevoking ||
    flowStage === 'popup' ||
    flowStage === 'callback' ||
    flowStage === 'verifying';


  const performVerification = useCallback(
    async (details: { authorizationCode: string; state?: string }) => {
      const trimmedCode = details.authorizationCode.trim();
      if (!trimmedCode) {
        setFlowStage('error');
        setError('인증 코드가 전달되지 않았습니다. 처음부터 다시 시도해 주세요.');
        return;
      }

      setError(null);
      setMergeTicketId(null);
      setMergeRequestStatus(null);
      setFlowStage('verifying');
      setStatus('verifying');

      try {
        const response = await fetch(`${API_BASE_URL}/v1/minecraft/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
          credentials: 'include',
          body: JSON.stringify({
            authorizationCode: trimmedCode,
            state: details.state,
          }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          const message = (body?.message as string) ?? 'Minecraft 소유 확인이 실패했습니다.';
          throw new Error(message);
        }

        const data = (await response.json()) as MinecraftIdentity;
        setIdentities((current) => {
          const next = [data, ...current.filter((item) => item.uuid !== data.uuid)];
          return next.sort((left, right) => Number(Boolean(right.isPrimary)) - Number(Boolean(left.isPrimary)));
        });
        if (!identity || data.isPrimary) {
          setIdentity(data);
          setPlayerName(data.playerName ?? null);
        }
        if (verifySessionId && verifyToken) {
          await completeDiscordVerifySession(verifySessionId, verifyToken, data);
          setDiscordVerifyStatus('Discord 검증 세션이 MineWiki 계정과 연결되었습니다.');
        }
        setPendingAuth(null);
        setError(null);
        setFlowStage('completed');
      } catch (verifyError) {
        setError(
          verifyError instanceof Error
            ? verifyError.message
            : '알 수 없는 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
        );
        setFlowStage('error');
      } finally {
        setStatus('idle');
      }
    },
    [identity, verifySessionId, verifyToken],
  );

  const fetchIdentity = useCallback(async () => {
    setStatus('loadingIdentity');
    setError(null);

    try {
      const response = await fetch(`${API_BASE_URL}/v1/minecraft/identities`, {
        credentials: 'include',
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const message =
          (body?.message as string) ?? 'Minecraft 소유 인증 정보를 확인할 수 없습니다.';
        throw new Error(message);
      }

      const data = (await response.json()) as { identities: MinecraftIdentity[] };
      const primary = data.identities.find((item) => item.isPrimary) ?? data.identities[0] ?? null;
      setIdentities(data.identities);
      setIdentity(primary);
      setPlayerName(primary?.playerName ?? null);
      if (primary && verifySessionId && verifyToken) {
        await completeDiscordVerifySession(verifySessionId, verifyToken, primary);
        setDiscordVerifyStatus('Discord 검증 세션이 MineWiki 계정과 연결되었습니다.');
      }
      setFlowStage(primary ? 'completed' : 'idle');
    } catch (identityError) {
      setError(
        identityError instanceof Error
          ? identityError.message
          : 'Minecraft 소유 인증 정보를 불러오지 못했습니다.',
      );
      setFlowStage('error');
    } finally {
      setStatus('idle');
    }
  }, [verifySessionId, verifyToken]);

  const canCreateMergeRequest = Boolean(error && isRecoverableConflictError(error));

  const handleCreateMergeRequest = useCallback(async () => {
    if (!error) {
      return;
    }
    setCreatingMergeRequest(true);
    setMergeRequestStatus(null);
    try {
      const response = await createAccountMergeRequest({
        source: 'minecraft_verify',
        conflictMessage: error,
      });
      setMergeTicketId(response.ticketId);
      setMergeRequestStatus('지원 요청이 접수되었습니다. 고객센터에서 처리 상태를 확인해 주세요.');
    } catch (requestError) {
      setMergeRequestStatus(
        requestError instanceof Error ? requestError.message : '지원 요청을 만들지 못했습니다.',
      );
    } finally {
      setCreatingMergeRequest(false);
    }
  }, [error]);

  useEffect(() => {
    void fetchIdentity();
  }, [fetchIdentity]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin && event.origin !== VERIFY_ORIGIN) {
        return;
      }
      if (!oauthPopupRef.current || event.source !== oauthPopupRef.current) {
        return;
      }
      if (typeof event.data !== 'object' || event.data === null) {
        return;
      }
      if (event.data.type === 'minecraft-oauth-error') {
        oauthPopupRef.current = null;
        setFlowStage('error');
        setPendingAuth(null);
        setError(
          typeof event.data.message === 'string'
            ? event.data.message
            : 'Microsoft 인증을 완료하지 못했습니다.',
        );
        return;
      }
      if (event.data.type === 'minecraft-oauth-verified') {
        const verifiedIdentity = event.data.identity as Partial<MinecraftIdentity> | undefined;
        if (
          !verifiedIdentity ||
          typeof verifiedIdentity.uuid !== 'string' ||
          verifiedIdentity.msOwned !== true ||
          typeof verifiedIdentity.lastVerifiedAt !== 'string'
        ) {
          setFlowStage('error');
          setError('Minecraft 인증 결과를 확인할 수 없습니다. 계정 페이지를 새로고침해 주세요.');
          return;
        }
        const nextIdentity = verifiedIdentity as MinecraftIdentity;
        oauthPopupRef.current = null;
        setIdentities((current) => {
          const next = [nextIdentity, ...current.filter((item) => item.uuid !== nextIdentity.uuid)];
          return next.sort((left, right) => Number(Boolean(right.isPrimary)) - Number(Boolean(left.isPrimary)));
        });
        if (!identity || nextIdentity.isPrimary) {
          setIdentity(nextIdentity);
          setPlayerName(nextIdentity.playerName ?? null);
        }
        setPendingAuth(null);
        setError(null);
        setFlowStage('completed');
        if (verifySessionId && verifyToken) {
          void completeDiscordVerifySession(verifySessionId, verifyToken, nextIdentity)
            .then(() => {
              setDiscordVerifyStatus('Discord 검증 세션이 MineWiki 계정과 연결되었습니다.');
            })
            .catch((completionError) => {
              setError(
                completionError instanceof Error
                  ? completionError.message
                  : 'Discord 검증 세션을 완료하지 못했습니다.',
              );
            });
        }
        return;
      }
      if (event.data.type !== 'minecraft-oauth-complete') {
        return;
      }

      const incomingState = typeof event.data.state === 'string' ? event.data.state : '';
      if (!pendingAuth || pendingAuth.state !== incomingState) {
        setFlowStage('error');
        setError('인증 상태가 만료되었습니다. 다시 인증해 주세요.');
        return;
      }

      const incomingCode = typeof event.data.code === 'string' ? event.data.code : '';
      if (!incomingCode) {
        setFlowStage('error');
        setError('인증 코드가 전달되지 않았습니다. 다시 시도해 주세요.');
        return;
      }

      setFlowStage('callback');
      setError(null);
      oauthPopupRef.current = null;
      void performVerification({
        authorizationCode: incomingCode,
        state: pendingAuth.state,
      });
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [identity, pendingAuth, performVerification, verifySessionId, verifyToken]);

  const handleStartOAuth = useCallback(async () => {
    setError(null);
    setFlowStage('idle');
    setPendingAuth(null);
    setIsStarting(true);

    try {
      const response = await fetch(`${API_BASE_URL}/v1/minecraft/oauth/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        credentials: 'include',
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const message =
          (body?.message as string) ??
          'Microsoft 인증을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.';
        throw new Error(message);
      }

      const data = (await response.json()) as PendingAuthorization;
      setPendingAuth(data);
      setFlowStage('popup');

      const popup = window.open(data.authorizationUrl, '_blank', 'width=720,height=780');
      if (!popup) {
        setFlowStage('error');
        setError('팝업을 열 수 없습니다. 브라우저 팝업 차단 설정을 확인해 주세요.');
        return;
      }
      oauthPopupRef.current = popup;
      const closeTimer = window.setInterval(() => {
        if (!popup.closed) {
          return;
        }
        window.clearInterval(closeTimer);
        oauthPopupRef.current = null;
        setFlowStage((current) => {
          if (current === 'popup') {
            setPendingAuth(null);
            setError('Microsoft 인증 창이 닫혔습니다. 인증을 완료하지 못했습니다.');
            return 'error';
          }
          return current;
        });
      }, 800);
    } catch (startError) {
      setFlowStage('error');
      setError(
        startError instanceof Error
          ? startError.message
          : 'Microsoft 인증 페이지를 불러오지 못했습니다.',
      );
    } finally {
      setIsStarting(false);
    }
  }, []);

  const handleRevokeIdentity = useCallback(async (selectedIdentity: MinecraftIdentity) => {
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm(
        'Minecraft 소유권 인증을 취소하면 인증 전용 기능(예: 소유권 요구 투표)이 제한될 수 있습니다. 계속할까요?',
      );
      if (!confirmed) {
        return;
      }
    }

    setError(null);
    setIsRevoking(true);

    try {
      const response = await fetch(`${API_BASE_URL}/v1/minecraft/identities/${encodeURIComponent(selectedIdentity.uuid)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: await csrfHeaders(),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const rawMessage = body?.message;
        const message =
          typeof rawMessage === 'string'
            ? rawMessage
            : Array.isArray(rawMessage) && rawMessage.length > 0
              ? rawMessage.join(', ')
              : 'Minecraft 소유권 인증을 취소하지 못했습니다.';
        throw new Error(message);
      }

      const remaining = identities.filter((item) => item.uuid !== selectedIdentity.uuid);
      const selectedPrimary = remaining.find((item) => item.isPrimary) ?? remaining[0] ?? null;
      const normalizedRemaining = remaining.map((item) => ({
        ...item,
        isPrimary: item.uuid === selectedPrimary?.uuid,
      }));
      const nextPrimary = normalizedRemaining.find((item) => item.isPrimary) ?? null;
      setIdentities(normalizedRemaining);
      setIdentity(nextPrimary);
      setPlayerName(nextPrimary?.playerName ?? null);
      setPendingAuth(null);
      setFlowStage('idle');
    } catch (revokeError) {
      setError(
        revokeError instanceof Error
          ? revokeError.message
          : 'Minecraft 소유권 인증 취소 중 오류가 발생했습니다.',
      );
    } finally {
      setIsRevoking(false);
    }
  }, [identities]);

  const currentStep = useMemo(() => {
    if (identity || flowStage === 'completed') {
      return 4;
    }
    if (flowStage === 'verifying' || flowStage === 'callback') {
      return 3;
    }
    if (flowStage === 'popup') {
      return 2;
    }
    return 1;
  }, [flowStage, identity]);

  return (
    <section id="minecraft-ownership" className="relative overflow-hidden rounded-xl border border-white/10 bg-[#1A1A1A] p-8 shadow-sm">
      <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-[#13ec80]/5 blur-3xl" />
      <div className="relative z-10">
        <div className="mb-8 flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-xl font-bold text-white">
              <ShieldCheck className="h-5 w-5 text-[#13ec80]" />
              Minecraft 소유권 인증
            </h3>
            <p className="max-w-2xl text-sm leading-relaxed text-[#a0a0a0]">
              정품 계정을 인증하면 서버 등록, 리뷰 작성, 투표 신뢰 배지 등 주요 기능을 사용할 수
              있습니다. Microsoft 로그인을 통해 안전하게 인증하세요.
            </p>
            {verifySessionId ? (
              <p className="mt-3 rounded-lg border border-[#13ec80]/[.35] bg-[#13ec80]/[.10] px-4 py-3 text-sm text-[#b9f8d9]">
                {verifyToken
                  ? 'Discord /minewiki verify 세션을 완료하려면 Minecraft 소유권 인증을 마쳐 주세요.'
                  : 'Discord verify 링크가 만료되었거나 토큰이 없습니다. Discord에서 다시 시작해 주세요.'}
              </p>
            ) : null}
            {discordVerifyStatus ? (
              <p className="mt-3 rounded-lg border border-blue-300/30 bg-blue-400/[.10] px-4 py-3 text-sm text-blue-100">
                {discordVerifyStatus}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-3 rounded-lg border border-white/15 bg-[#242424] px-6 py-3 text-sm font-medium text-white transition hover:bg-[#2a2a2a] disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void handleStartOAuth()}
              disabled={isBusy}
            >
              <svg
                className="h-5 w-5"
                viewBox="0 0 21 21"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M10.155 0.36H0.6V9.915h9.555V0.36Z" fill="#F25022" />
                <path d="M20.67 0.36h-9.555V9.915h9.555V0.36Z" fill="#7FBA00" />
                <path d="M10.155 10.875H0.6v9.555h9.555v-9.555Z" fill="#00A4EF" />
                <path d="M20.67 10.875h-9.555v9.555h9.555v-9.555Z" fill="#FFB900" />
              </svg>
              {isStarting || status === 'loadingIdentity' ? '요청 중…' : identities.length > 0 ? 'Minecraft 계정 추가' : 'Microsoft로 인증하기'}
              <SquareArrowOutUpRight className="h-4 w-4" />
            </button>

          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <StepCard
            step={1}
            title="로그인"
            description="Microsoft 계정 로그인"
            active={currentStep === 1}
            done={currentStep > 1}
          />
          <StepCard
            step={2}
            title="권한 승인"
            description="프로필 읽기 권한"
            active={currentStep === 2}
            done={currentStep > 2}
          />
          <StepCard
            step={3}
            title="검증"
            description="소유권 확인 중"
            active={currentStep === 3}
            done={currentStep > 3}
          />
          <StepCard
            step={4}
            title="인증 완료"
            description={identity ? `${playerName ?? 'Player'} 확인됨` : '인증 완료 대기'}
            active={currentStep === 4}
            done={currentStep === 4}
          />
        </div>

        {flowStage !== 'idle' && flowStage !== 'completed' ? (
          <div className="mt-5 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
            {flowStage === 'popup'
              ? 'Microsoft 로그인 팝업에서 인증을 완료해 주세요.'
              : flowStage === 'callback'
                ? '인증 코드를 확인했습니다. 검증을 시작합니다.'
                : flowStage === 'verifying'
                  ? 'Minecraft 소유권을 검증 중입니다.'
                  : '인증 과정에 문제가 있습니다. 다시 시도해 주세요.'}
          </div>
        ) : null}

        {error ? (
          <div className="mt-4 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            <p>{error}</p>
            {canCreateMergeRequest ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md border border-red-200/30 bg-red-100/10 px-3 py-1.5 font-semibold text-red-100 transition hover:bg-red-100/15 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void handleCreateMergeRequest()}
                  disabled={creatingMergeRequest || Boolean(mergeTicketId)}
                >
                  {creatingMergeRequest ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {mergeTicketId ? '요청 접수됨' : '지원 요청 만들기'}
                </button>
                {mergeTicketId ? (
                  <a
                    href={`/support?ticket=${encodeURIComponent(mergeTicketId)}`}
                    className="font-semibold text-red-100 underline-offset-2 hover:underline"
                  >
                    티켓 보기
                  </a>
                ) : null}
              </div>
            ) : null}
            {mergeRequestStatus ? <p className="mt-2 text-red-100">{mergeRequestStatus}</p> : null}
          </div>
        ) : null}

        {status === 'verifying' ? (
          <div className="mt-4 flex items-center gap-2 text-xs text-[#a0a0a0]">
            <Loader2 className="h-4 w-4 animate-spin text-[#13ec80]" />
            서버에서 계정 소유권을 확인하고 있습니다.
          </div>
        ) : null}

        {identities.length > 0 ? (
          <div className="mt-6 border-t border-white/10 pt-6">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm font-bold text-white">인증된 Minecraft 계정 {identities.length}개</p>
              {returnTo ? <Link href={returnTo} className="inline-flex rounded-lg bg-[#13ec80] px-4 py-2 text-xs font-bold text-[#07130d] transition hover:bg-[#35f29a]">리뷰 화면으로 돌아가기</Link> : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {identities.map((item) => (
                <article key={item.uuid} className="flex min-w-0 items-center gap-3 rounded-lg border border-white/10 bg-[#121212] p-3">
                  <Image src={buildAvatarCandidates(item.uuid)[0]!} alt={`${item.playerName ?? 'Minecraft'} avatar`} width={48} height={48} className="size-12 rounded object-cover" unoptimized />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate text-sm font-bold text-white">{item.playerName ?? item.uuid.slice(0, 8)}<span className="inline-flex shrink-0 items-center gap-1 rounded border border-[#13ec80]/40 bg-[#13ec80]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#13ec80]"><CheckCircle2 className="size-3" />{item.isPrimary ? 'PRIMARY' : 'VERIFIED'}</span></p>
                    <p className="mt-1 truncate font-mono text-[10px] text-[#8b97a6]">{item.uuid}</p>
                  </div>
                  <button type="button" onClick={() => void handleRevokeIdentity(item)} disabled={isBusy} className="shrink-0 rounded-md border border-red-500/30 px-2.5 py-2 text-[11px] font-semibold text-red-200 hover:bg-red-500/10 disabled:opacity-50">{isRevoking ? '처리 중' : '해제'}</button>
                </article>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-6 border-t border-white/10 pt-5 text-xs text-[#8b97a6]">
            아직 인증된 Minecraft 계정이 없습니다. 위 버튼으로 인증을 시작해 주세요.
          </p>
        )}
      </div>
    </section>
  );
}

function isRecoverableConflictError(message: string): boolean {
  return /already linked|이미.*연결|충돌/.test(message);
}

function StepCard({
  step,
  title,
  description,
  active,
  done,
}: {
  readonly step: number;
  readonly title: string;
  readonly description: string;
  readonly active: boolean;
  readonly done: boolean;
}) {
  return (
    <div className={`rounded-lg border p-4 ${stepTone(active, done)}`}>
      <div className="mb-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-xs font-bold text-white">
        {done ? <CheckCircle2 className="h-4 w-4 text-[#13ec80]" /> : step}
      </div>
      <p className="text-xs font-semibold text-white">{title}</p>
      <p className="mt-0.5 text-[10px] text-[#8f9bab]">{description}</p>
    </div>
  );
}

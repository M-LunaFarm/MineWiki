'use client';

import Image from 'next/image';
import { CheckCircle2, Loader2, ShieldCheck, SquareArrowOutUpRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MinecraftIdentity } from '@creepervote/schemas';
import { getApiBaseUrl } from '../../lib/runtime-config';

const API_BASE_URL = getApiBaseUrl();

interface PendingAuthorization {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly codeVerifier: string;
}

type FlowStage = 'idle' | 'popup' | 'callback' | 'verifying' | 'completed' | 'error';

function stepTone(active: boolean, done: boolean): string {
  if (active || done) {
    return 'border-[#13ec80]/45 bg-[#13ec80]/12';
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

export function MinecraftOwnershipPanel() {
  const [identity, setIdentity] = useState<MinecraftIdentity | null>(null);
  const [playerName, setPlayerName] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'verifying' | 'loadingIdentity'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pendingAuth, setPendingAuth] = useState<PendingAuthorization | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const [flowStage, setFlowStage] = useState<FlowStage>('idle');
  const [avatarIndex, setAvatarIndex] = useState(0);

  const isBusy =
    status !== 'idle' ||
    isStarting ||
    isRevoking ||
    flowStage === 'popup' ||
    flowStage === 'callback' ||
    flowStage === 'verifying';

  const avatarCandidates = useMemo(
    () => (identity ? buildAvatarCandidates(identity.uuid) : []),
    [identity],
  );
  const activeAvatarSrc = avatarCandidates[avatarIndex];
  const avatarInitial = useMemo(() => {
    const source = playerName ?? identity?.uuid ?? 'P';
    return source.slice(0, 1).toUpperCase();
  }, [identity?.uuid, playerName]);

  const performVerification = useCallback(
    async (details: { authorizationCode: string; state?: string; codeVerifier?: string }) => {
      const trimmedCode = details.authorizationCode.trim();
      if (!trimmedCode) {
        setFlowStage('error');
        setError('인증 코드가 전달되지 않았습니다. 처음부터 다시 시도해 주세요.');
        return;
      }

      setError(null);
      setFlowStage('verifying');
      setStatus('verifying');

      try {
        const response = await fetch(`${API_BASE_URL}/v1/minecraft/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            authorizationCode: trimmedCode,
            state: details.state,
            codeVerifier: details.codeVerifier,
          }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          const message = (body?.message as string) ?? 'Minecraft 소유 확인이 실패했습니다.';
          throw new Error(message);
        }

        const data = (await response.json()) as MinecraftIdentity;
        setIdentity(data);
        setPlayerName(data.playerName ?? null);
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
    [],
  );

  const fetchIdentity = useCallback(async () => {
    setStatus('loadingIdentity');
    setError(null);

    try {
      const response = await fetch(`${API_BASE_URL}/v1/minecraft/identity`, {
        credentials: 'include',
      });

      if (response.status === 404) {
        setIdentity(null);
        setPlayerName(null);
        setFlowStage('idle');
        return;
      }

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const message =
          (body?.message as string) ?? 'Minecraft 소유 인증 정보를 확인할 수 없습니다.';
        throw new Error(message);
      }

      const data = (await response.json()) as MinecraftIdentity;
      setIdentity(data);
      setPlayerName(data.playerName ?? null);
      setFlowStage('completed');
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
  }, []);

  useEffect(() => {
    void fetchIdentity();
  }, [fetchIdentity]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      if (typeof event.data !== 'object' || event.data === null) {
        return;
      }
      if (event.data.type === 'minecraft-oauth-error') {
        setFlowStage('error');
        setPendingAuth(null);
        setError(
          typeof event.data.message === 'string'
            ? event.data.message
            : 'Microsoft 인증을 완료하지 못했습니다.',
        );
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
      void performVerification({
        authorizationCode: incomingCode,
        state: pendingAuth.state,
        codeVerifier: pendingAuth.codeVerifier,
      });
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [pendingAuth, performVerification]);

  useEffect(() => {
    setAvatarIndex(0);
  }, [identity?.uuid]);

  const handleStartOAuth = useCallback(async () => {
    setError(null);
    setFlowStage('idle');
    setPendingAuth(null);
    setIsStarting(true);

    try {
      const response = await fetch(`${API_BASE_URL}/v1/minecraft/oauth/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const closeTimer = window.setInterval(() => {
        if (!popup.closed) {
          return;
        }
        window.clearInterval(closeTimer);
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

  const handleRevokeIdentity = useCallback(async () => {
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
      const response = await fetch(`${API_BASE_URL}/v1/minecraft/identity`, {
        method: 'DELETE',
        credentials: 'include',
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

      setIdentity(null);
      setPlayerName(null);
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
  }, []);

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
    <section className="relative overflow-hidden rounded-xl border border-white/10 bg-[#1A1A1A] p-8 shadow-sm">
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
              {isStarting || status === 'loadingIdentity' ? '요청 중…' : 'Microsoft로 인증하기'}
              <SquareArrowOutUpRight className="h-4 w-4" />
            </button>

            {identity ? (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-lg border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-100 transition hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void handleRevokeIdentity()}
                disabled={isBusy}
              >
                {isRevoking ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    취소 중…
                  </>
                ) : (
                  '소유권 인증 취소'
                )}
              </button>
            ) : null}
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
          <p className="mt-4 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {error}
          </p>
        ) : null}

        {status === 'verifying' ? (
          <div className="mt-4 flex items-center gap-2 text-xs text-[#a0a0a0]">
            <Loader2 className="h-4 w-4 animate-spin text-[#13ec80]" />
            서버에서 계정 소유권을 확인하고 있습니다.
          </div>
        ) : null}

        {identity ? (
          <div className="mt-6 flex items-center gap-4 border-t border-white/10 pt-6">
            <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded border border-white/15 bg-[#121212]">
              {activeAvatarSrc ? (
                <Image
                  src={activeAvatarSrc}
                  alt="Minecraft avatar"
                  width={48}
                  height={48}
                  className="h-12 w-12 object-cover"
                  unoptimized
                  onError={() => {
                    setAvatarIndex((current) =>
                      current < avatarCandidates.length - 1 ? current + 1 : current,
                    );
                  }}
                />
              ) : (
                <span className="text-sm font-semibold text-[#c8d3de]">{avatarInitial}</span>
              )}
            </div>
            <div>
              <p className="flex items-center gap-2 text-sm font-bold text-white">
                {playerName ?? identity.uuid.slice(0, 8)}
                <span className="inline-flex items-center gap-1 rounded border border-[#13ec80]/40 bg-[#13ec80]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#13ec80]">
                  <CheckCircle2 className="h-3 w-3" />
                  VERIFIED
                </span>
              </p>
              <p className="mt-0.5 font-mono text-[11px] text-[#8b97a6]">UUID: {identity.uuid}</p>
              <p className="mt-0.5 text-[11px] text-[#8b97a6]">
                최근 검증: {new Date(identity.lastVerifiedAt).toLocaleString('ko-KR')}
              </p>
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

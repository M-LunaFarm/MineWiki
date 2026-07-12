'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { MinecraftIdentity } from '@minewiki/schemas';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Loader2,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  CallbackCard,
  CallbackCheckRow,
  CallbackShell,
  CallbackSideStat,
} from '../../../components/auth/callback-shell';
import { csrfHeaders } from '../../../lib/csrf';
import { getApiBaseUrl } from '../../../lib/runtime-config';

const API_BASE_URL = getApiBaseUrl();

interface CallbackClientProps {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
  readonly errorDescription?: string;
}

export function MinecraftCallbackClient({
  code,
  state,
  error,
  errorDescription,
}: CallbackClientProps) {
  const router = useRouter();
  const [handoffSent, setHandoffSent] = useState(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const status = useMemo(() => {
    if (error || verificationError) {
      return {
        kind: 'error' as const,
        title: 'Microsoft 인증을 완료하지 못했습니다.',
        message:
          error === 'access_denied'
            ? '사용자가 Microsoft 인증 창에서 권한 승인을 취소했습니다.'
            : verificationError ??
              'Microsoft 인증 처리 중 오류가 발생했습니다. 잠시 후 다시 시도하거나 다른 계정으로 인증해 주세요.',
        detail: errorDescription,
      };
    }
    if (!code || !state) {
      return {
        kind: 'warning' as const,
        title: '필수 인증 값이 전달되지 않았습니다.',
        message:
          'OAuth 콜백에 필요한 code 또는 state 값이 없습니다. MineWiki에서 Minecraft 인증을 다시 시작해 주세요.',
        detail: undefined,
      };
    }
    if (handoffSent) {
      return {
        kind: 'success' as const,
        title: 'Minecraft 소유권 인증을 완료했습니다.',
        message:
          'MineWiki 계정에 Minecraft 프로필이 연결되었습니다. 창이 자동으로 닫히지 않으면 직접 닫아도 됩니다.',
        detail: undefined,
      };
    }
    return {
      kind: 'pending' as const,
      title: 'Minecraft 소유권을 확인하고 있습니다.',
      message: 'Microsoft 응답을 서버에서 검증하고 Minecraft 보유 여부와 프로필을 확인하는 중입니다.',
      detail: undefined,
    };
  }, [code, state, error, errorDescription, handoffSent, verificationError]);

  useEffect(() => {
    if (error) {
      notifyMinecraftOAuthError(
        error === 'access_denied'
          ? '사용자가 Microsoft 인증 창에서 권한 승인을 취소했습니다.'
          : 'Microsoft 인증 처리 중 오류가 발생했습니다.',
      );
      return;
    }
    if (!code || !state) {
      notifyMinecraftOAuthError('OAuth 콜백에 필요한 code 또는 state 값이 없습니다.');
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }
    let cancelled = false;
    let closeTimer: number | undefined;

    const completeVerification = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/v1/minecraft/verify`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
          body: JSON.stringify({ authorizationCode: code, state }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            typeof body?.message === 'string'
              ? body.message
              : 'Minecraft 소유권을 확인하지 못했습니다.',
          );
        }
        if (cancelled) return;

        const identity = body as MinecraftIdentity;
        window.opener?.postMessage(
          { type: 'minecraft-oauth-verified', identity },
          window.location.origin,
        );
        setHandoffSent(true);
        closeTimer = window.setTimeout(() => {
          try {
            window.close();
          } catch {
            // 사용자가 직접 닫거나 /me로 이동할 수 있다.
          }
        }, 3000);
      } catch (verificationFailure) {
        if (cancelled) return;
        const message =
          verificationFailure instanceof Error
            ? verificationFailure.message
            : 'Minecraft 소유권을 확인하지 못했습니다.';
        setVerificationError(message);
        notifyMinecraftOAuthError(message);
      }
    };

    void completeVerification();
    return () => {
      cancelled = true;
      if (closeTimer) window.clearTimeout(closeTimer);
    };
  }, [code, state, error]);

  const progressWidth = status.kind === 'pending' ? '68%' : '100%';
  const shellStatus = status.kind;
  const checks = [
    {
      label: 'OAuth callback received',
      complete: Boolean(code && state && !error),
    },
    {
      label: 'State parameter preserved',
      complete: Boolean(state && !error),
    },
    {
      label: 'MineWiki account linked',
      complete: handoffSent && !error && !verificationError,
    },
  ];

  return (
    <CallbackShell
      eyebrow="Minecraft 인증"
      title={status.title}
      subtitle={status.message}
      status={shellStatus}
      aside={
        <>
          <CallbackSideStat label="공급자" value="Microsoft" />
          <CallbackSideStat label="연결" value="Minecraft" />
          <CallbackSideStat
            label="상태"
            value={
              status.kind === 'pending'
                ? '처리 중'
                : status.kind === 'success'
                  ? '완료'
                  : status.kind === 'warning'
                    ? '확인 필요'
                    : '오류'
            }
          />
        </>
      }
    >
      <CallbackCard
        status={shellStatus}
        progressWidth={progressWidth}
        footerLabel="MineWiki Minecraft"
      >
        <div className="mb-6 flex items-start gap-4">
          <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-lg border border-[#30363d] bg-[#0b0d10]">
            {status.kind === 'pending' ? (
              <Loader2 className="h-7 w-7 animate-spin text-blue-200" />
            ) : status.kind === 'success' ? (
              <CheckCircle2 className="h-7 w-7 text-[#13ec80]" />
            ) : status.kind === 'warning' ? (
              <AlertTriangle className="h-7 w-7 text-amber-400" />
            ) : (
              <XCircle className="h-7 w-7 text-[#f43f5e]" />
            )}
          </div>
          <div className="min-w-0 text-left">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-[#6b7280]">
              Minecraft OAuth Callback
            </p>
            <h2 className="mt-2 text-xl font-bold tracking-tight text-white sm:text-2xl">
              {status.kind === 'pending'
                ? '소유권 확인 중'
                : status.kind === 'success'
                  ? '소유권 인증 완료'
                  : '인증 응답 확인 필요'}
            </h2>
            <p className="mt-3 text-sm leading-6 text-[#a9b0ba]">
              {status.kind === 'pending'
                ? 'Microsoft 응답과 Minecraft 프로필을 서버에서 확인하고 있습니다.'
                : status.kind === 'success'
                  ? '인증된 Minecraft 프로필이 MineWiki 계정에 연결되었습니다.'
                  : 'MineWiki에서 Minecraft 인증을 다시 시작해 주세요.'}
            </p>
          </div>
        </div>

        <div className="mb-5 rounded-lg border border-[#30363d] bg-[#0b0d10] p-4 text-left">
          <div className="flex items-start gap-3">
            {status.kind === 'pending' ? (
              <Clock3 className="mt-0.5 h-4 w-4 text-blue-200" />
            ) : status.kind === 'success' ? (
              <ShieldCheck className="mt-0.5 h-4 w-4 text-[#13ec80]" />
            ) : status.kind === 'warning' ? (
              <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-400" />
            ) : (
              <LockKeyhole className="mt-0.5 h-4 w-4 text-[#f43f5e]" />
            )}
            <div>
              <p className="text-sm font-medium text-[#e5e7eb]">
                {status.kind === 'pending'
                  ? 'Minecraft 소유권을 확인하고 있습니다.'
                  : status.kind === 'success'
                    ? 'MineWiki 계정 연결이 완료되었습니다.'
                    : status.kind === 'warning'
                      ? '인증 응답 값이 유효하지 않습니다.'
                      : 'OAuth 처리 중 오류가 발생했습니다.'}
              </p>
              <p className="mt-1 text-xs leading-5 text-[#a9b0ba]">
                {status.kind === 'pending'
                  ? '인증 코드는 MineWiki API에서 일회성으로 검증됩니다.'
                  : status.kind === 'success'
                    ? '원래 창을 새로고침해도 연결된 프로필을 다시 확인할 수 있습니다.'
                    : 'MineWiki에서 Minecraft 인증을 다시 시작해 주세요.'}
              </p>
              {status.detail ? (
                <p className="mt-2 text-xs text-rose-200/90">{status.detail}</p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="mb-6 space-y-2">
          {checks.map((check) => (
            <CallbackCheckRow
              key={check.label}
              label={check.label}
              complete={check.complete}
              pending={status.kind === 'pending'}
              pendingIcon={<Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-blue-200" />}
            />
          ))}
        </div>

        {status.kind !== 'pending' ? (
          <button
            type="button"
            className="flex w-full items-center justify-center gap-2 rounded-md bg-[#13ec80] px-6 py-3.5 text-sm font-bold text-[#0b0d10] transition hover:bg-[#35f29a]"
            onClick={() => {
              try {
                window.close();
              } catch {
                router.replace('/me');
              }
            }}
          >
            {status.kind === 'success' ? (
              <ExternalLink className="h-4 w-4" />
            ) : (
              <RotateCcw className="h-4 w-4" />
            )}
            {status.kind === 'success' ? '창 닫기' : '인증 창 닫기'}
          </button>
        ) : (
          <button
            type="button"
            disabled
            className="flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-md border border-[#30363d] bg-[#15191f] px-6 py-3.5 text-sm font-bold text-[#6b7280]"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            처리 중
          </button>
        )}
      </CallbackCard>
    </CallbackShell>
  );
}

function notifyMinecraftOAuthError(message: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.opener?.postMessage({ type: 'minecraft-oauth-error', message }, window.location.origin);
}

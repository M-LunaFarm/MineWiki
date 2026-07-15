'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  CheckCircle2,
  Clock3,
  ExternalLink,
  Loader2,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { completeOAuthLogin, type OAuthProvider } from '../../../../lib/auth-client';
import { useAuth } from '../../../../components/providers/auth-context';
import {
  CallbackCard,
  CallbackCheckRow,
  CallbackShell,
  CallbackSideStat,
} from '../../../../components/auth/callback-shell';

interface OAuthCallbackClientProps {
  readonly provider: string;
}

export function OAuthCallbackClient({ provider }: OAuthCallbackClientProps) {
  const normalizedProvider = useMemo<OAuthProvider | null>(() => {
    return provider === 'discord' || provider === 'naver' ? provider : null;
  }, [provider]);
  const providerLabel =
    normalizedProvider === 'discord'
      ? 'Discord'
      : normalizedProvider === 'naver'
        ? 'Naver'
        : provider;

  const searchParams = useSearchParams();
  const router = useRouter();
  const { refresh } = useAuth();

  const [status, setStatus] = useState<'pending' | 'success' | 'error'>(
    normalizedProvider ? 'pending' : 'error',
  );
  const [message, setMessage] = useState<string>('');
  const [flowMode, setFlowMode] = useState<'login' | 'link'>('login');
  const [linkCompletionTarget, setLinkCompletionTarget] = useState<'opener' | 'redirect'>('opener');

  useEffect(() => {
    if (!normalizedProvider) {
      setStatus('error');
      setMessage('지원하지 않는 OAuth 공급자입니다.');
      return;
    }

    const errorParam = searchParams.get('error');
    if (errorParam) {
      setStatus('error');
      setMessage('OAuth 인증이 취소되었거나 공급자에서 오류 응답을 반환했습니다.');
      notifyOAuthLinkError(normalizedProvider, 'OAuth 인증이 취소되었거나 실패했습니다.');
      return;
    }

    const code = searchParams.get('code');
    const state = searchParams.get('state');
    if (!code || !state) {
      setStatus('error');
      setMessage('OAuth 응답에 필요한 code 또는 state 값이 없습니다.');
      notifyOAuthLinkError(normalizedProvider, 'OAuth 응답에 필요한 값이 없습니다.');
      return;
    }

    if (typeof window === 'undefined') {
      return;
    }

    const redirectUri = `${window.location.origin}/auth/callback/${normalizedProvider}`;

    const finalize = async () => {
      try {
        setStatus('pending');
        const result = await completeOAuthLogin({
          provider: normalizedProvider,
          code,
          state,
          redirectUri,
        });
        setFlowMode(result.mode);
        await refresh();
        if (result.mode === 'link') {
          setStatus('success');
          if (typeof window !== 'undefined') {
            const hasOpener = Boolean(window.opener && !window.opener.closed);
            if (hasOpener) {
              setLinkCompletionTarget('opener');
              setMessage('계정 연동이 완료되었습니다. 원래 창으로 결과를 전달했습니다.');
              window.opener.postMessage(
                { type: 'oauth-link-complete', provider: normalizedProvider },
                window.location.origin,
              );
              setTimeout(() => window.close(), 1500);
            } else {
              const returnTo = isSafeReturnPath(result.returnTo) ? result.returnTo : '/me';
              setLinkCompletionTarget('redirect');
              setMessage('계정 연동이 완료되었습니다. 계정 및 보안 화면으로 돌아갑니다.');
              setTimeout(() => router.replace(returnTo), 900);
            }
          }
          return;
        }
        setStatus('success');
        setMessage('로그인이 완료되었습니다. 계정 페이지로 이동합니다.');
        const returnTo = isSafeReturnPath(result.returnTo) ? result.returnTo : '/me';
        router.replace(
          result.account.policyConsent?.required
            ? `/policies/consent?returnTo=${encodeURIComponent(returnTo)}`
            : returnTo,
        );
      } catch (error) {
        setStatus('error');
        const nextMessage =
          error instanceof Error ? error.message : '로그인 처리 중 오류가 발생했습니다.';
        setMessage(nextMessage);
        notifyOAuthLinkError(normalizedProvider, nextMessage);
      }
    };

    void finalize();
  }, [normalizedProvider, searchParams, refresh, router]);

  const shellStatus = status;
  const statusTone =
    status === 'pending'
      ? 'text-blue-200'
      : status === 'success'
        ? 'text-[#35e5b7]'
        : 'text-[#f43f5e]';
  const progressWidth = status === 'pending' ? '66%' : '100%';
  const title =
    status === 'pending'
      ? `${providerLabel} 인증 응답을 처리하고 있습니다.`
      : status === 'success'
        ? flowMode === 'link'
          ? '계정 연동이 완료되었습니다.'
          : '로그인이 완료되었습니다.'
        : '인증 처리를 완료하지 못했습니다.';
  const subtitle =
    status === 'pending'
      ? '공급자에서 전달한 code와 state 값을 검증하고 세션을 발급하는 중입니다. 창을 닫지 말아 주세요.'
      : message;
  const detailTitle =
    status === 'pending'
      ? '콜백 토큰 검증 중'
      : status === 'success'
        ? flowMode === 'link'
          ? '계정 연결이 확정되었습니다.'
          : '세션 발급이 완료되었습니다.'
        : 'OAuth 처리 중 오류가 발생했습니다.';
  const detailBody =
    status === 'pending'
      ? '사용자 권한, state 무결성, 리디렉션 URI 일치 여부를 확인하고 있습니다.'
      : status === 'success'
        ? flowMode === 'link'
          ? linkCompletionTarget === 'opener'
            ? '원래 창으로 결과를 전달한 뒤 자동으로 닫힙니다.'
            : '연결된 로그인 수단을 반영한 계정 및 보안 화면으로 이동합니다.'
          : '잠시 후 계정 페이지로 자동 이동합니다.'
        : '로그인 화면으로 돌아가 OAuth 인증을 다시 시작해 주세요.';
  const actionLabel =
    status === 'pending'
      ? '처리 중'
      : flowMode === 'link'
        ? linkCompletionTarget === 'opener' ? '창 닫기' : '계정 페이지로 이동'
        : status === 'error'
          ? '로그인 페이지로 이동'
          : '계정 페이지로 이동';
  const checks = [
    {
      label: '로그인 서비스',
      value: providerLabel,
      complete: Boolean(normalizedProvider),
    },
    {
      label: '인증 코드',
      value: searchParams.get('code') ? '확인됨' : '없음',
      complete: Boolean(searchParams.get('code')),
    },
    {
      label: '요청 무결성',
      value: searchParams.get('state') ? '확인됨' : '없음',
      complete: Boolean(searchParams.get('state')),
    },
  ];

  return (
    <CallbackShell
      eyebrow="계정 인증"
      title={title}
      subtitle={subtitle}
      status={shellStatus}
      aside={
        <>
          <CallbackSideStat label="공급자" value={providerLabel} />
          <CallbackSideStat label="모드" value={flowMode === 'link' ? '연동' : '로그인'} />
          <CallbackSideStat
            label="상태"
            value={status === 'pending' ? '처리 중' : status === 'success' ? '완료' : '오류'}
          />
        </>
      }
    >
      <CallbackCard status={shellStatus} progressWidth={progressWidth} footerLabel="MineWiki OAuth">
        <div className="mb-6 flex items-start gap-4">
          <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-lg border border-[#30363d] bg-[#0b0d10]">
            {status === 'pending' ? (
              <Loader2 className={`h-7 w-7 animate-spin ${statusTone}`} />
            ) : status === 'success' ? (
              <CheckCircle2 className={`h-7 w-7 ${statusTone}`} />
            ) : (
              <XCircle className={`h-7 w-7 ${statusTone}`} />
            )}
          </div>
          <div className="min-w-0 text-left">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-[#6b7280]">
              간편 로그인
            </p>
            <h2 className="mt-2 text-xl font-bold tracking-tight text-white sm:text-2xl">
              {detailTitle}
            </h2>
            <p className="mt-3 text-sm leading-6 text-[#a9b0ba]">{detailBody}</p>
          </div>
        </div>

        <div className="mb-5 rounded-lg border border-[#30363d] bg-[#0b0d10] p-4 text-left">
          <div className="flex items-start gap-3">
            {status === 'pending' ? (
              <Clock3 className="mt-0.5 h-4 w-4 text-blue-200" />
            ) : status === 'success' ? (
              <ShieldCheck className="mt-0.5 h-4 w-4 text-[#35e5b7]" />
            ) : (
              <LockKeyhole className="mt-0.5 h-4 w-4 text-[#f43f5e]" />
            )}
            <div>
              <p className="text-sm font-medium text-[#e5e7eb]">{providerLabel} 응답 확인</p>
              <p className="mt-1 text-xs leading-5 text-[#a9b0ba]">
                code, state, redirect URI를 확인한 뒤 MineWiki 세션에 연결합니다.
              </p>
              {status === 'error' && message ? (
                <p className="mt-2 text-xs text-rose-200/90">{message}</p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="mb-6 space-y-2">
          {checks.map((check) => (
            <CallbackCheckRow
              key={check.label}
              label={check.label}
              value={check.value}
              complete={check.complete}
              pending={status === 'pending'}
              pendingIcon={<Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-blue-200" />}
            />
          ))}
        </div>

        <div className="space-y-3">
          <button
            type="button"
            disabled={status === 'pending'}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#35e5b7] px-6 py-3.5 text-sm font-bold text-[#07100e] transition hover:bg-[#5bedc8] disabled:cursor-not-allowed disabled:border disabled:border-white/10 disabled:bg-white/[0.04] disabled:text-slate-500"
            onClick={() => {
              if (flowMode === 'link' && status === 'success') {
                if (linkCompletionTarget === 'redirect') {
                  router.replace('/me');
                  return;
                }
                try {
                  window.close();
                  return;
                } catch {
                  router.replace('/me');
                  return;
                }
              }
              if (status === 'error') {
                router.replace('/login');
                return;
              }
              router.replace('/me');
            }}
          >
            {status === 'pending' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : status === 'error' ? (
              <RotateCcw className="h-4 w-4" />
            ) : flowMode === 'link' ? (
              <ExternalLink className="h-4 w-4" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            <span>{actionLabel}</span>
          </button>
        </div>
      </CallbackCard>
    </CallbackShell>
  );
}

function isSafeReturnPath(value: string | null | undefined): value is string {
  return Boolean(
    value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\'),
  );
}

function notifyOAuthLinkError(provider: OAuthProvider, message: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.opener?.postMessage(
    { type: 'oauth-link-error', provider, message },
    window.location.origin,
  );
}

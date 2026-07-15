'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { completeOAuthLogin, type OAuthProvider } from '../../../../lib/auth-client';
import { useAuth } from '../../../../components/providers/auth-context';
import {
  CallbackCard,
  CallbackShell,
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

    const openedForLink = typeof window !== 'undefined' && Boolean(window.opener && !window.opener.closed);
    if (openedForLink) {
      setFlowMode('link');
      setLinkCompletionTarget('opener');
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
              setTimeout(() => {
                window.close();
                setTimeout(() => {
                  if (!window.closed) router.replace('/me');
                }, 100);
              }, 1500);
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
      ? '로그인 서비스에서 받은 인증 응답과 요청 안전성을 확인하고 있습니다. 창을 닫지 말아 주세요.'
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
      ? '로그인 요청이 이 브라우저에서 시작되었는지 안전하게 확인하고 있습니다.'
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
      : status === 'error'
        ? flowMode === 'link' ? '계정 페이지로 돌아가기' : '로그인 페이지로 이동'
        : flowMode === 'link'
          ? linkCompletionTarget === 'opener' ? '창 닫기' : '계정 페이지로 이동'
          : '계정 페이지로 이동';
  return (
    <CallbackShell
      eyebrow="계정 인증"
      title={title}
      subtitle={subtitle}
      status={shellStatus}
    >
      <div role={status === 'error' ? 'alert' : 'status'} aria-live={status === 'error' ? 'assertive' : 'polite'}>
      <CallbackCard status={shellStatus} progressWidth={progressWidth} footerLabel="MineWiki OAuth">
        <div className="mb-5 flex flex-col items-start gap-3.5 min-[360px]:flex-row">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/10">
            {status === 'pending' ? (
              <Loader2 className={`h-6 w-6 animate-spin ${statusTone}`} />
            ) : status === 'success' ? (
              <CheckCircle2 className={`h-6 w-6 ${statusTone}`} />
            ) : (
              <XCircle className={`h-6 w-6 ${statusTone}`} />
            )}
          </div>
          <div className="min-w-0 text-left">
            <p className="text-xs font-semibold text-slate-500">
              {providerLabel} · {flowMode === 'link' ? '계정 연동' : '간편 로그인'}
            </p>
            <h2 className="mt-1.5 text-lg font-bold tracking-tight text-white sm:text-xl">
              {detailTitle}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">{detailBody}</p>
          </div>
        </div>

        <div className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/10 px-3.5 py-3 text-xs">
          <span className="flex min-w-0 items-center gap-2 text-slate-400">
            <ShieldCheck className="h-4 w-4 flex-shrink-0 text-[#35e5b7]" aria-hidden />
            요청 무결성 보호
          </span>
          <span className={`flex-shrink-0 font-semibold ${statusTone}`}>
            {status === 'pending' ? '확인 중' : status === 'success' ? '확인 완료' : '다시 시도 필요'}
          </span>
        </div>

        {status === 'error' && message ? (
          <p className="mb-5 rounded-lg border border-rose-400/25 bg-rose-500/10 px-3.5 py-3 text-xs leading-5 text-rose-300">
            {message}
          </p>
        ) : null}

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
                if (flowMode === 'link') {
                  window.close();
                  setTimeout(() => {
                    if (!window.closed) router.replace('/me');
                  }, 100);
                  return;
                }
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
      </div>
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

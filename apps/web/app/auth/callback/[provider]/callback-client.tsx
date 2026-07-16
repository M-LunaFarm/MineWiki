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
import {
  closeOAuthWindowOrNavigate,
  consumeOAuthLinkIntent,
} from '../../../../lib/oauth-link-intent.mjs';
import { useAuth } from '../../../../components/providers/auth-context';
import {
  CallbackShell,
} from '../../../../components/auth/callback-shell';
import { OAuthProviderChoice } from '../../../../components/auth/oauth-provider-choice';

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
        ? 'NAVER'
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

    const callbackState = searchParams.get('state');
    const openedForLink = typeof window !== 'undefined' && Boolean(window.opener && !window.opener.closed);
    const continuedLink = typeof window !== 'undefined' && Boolean(
      callbackState
      && consumeOAuthLinkIntent(
        window.sessionStorage,
        { provider: normalizedProvider, state: callbackState },
      )
    );
    if (openedForLink || continuedLink) {
      setFlowMode('link');
      setLinkCompletionTarget(openedForLink ? 'opener' : 'redirect');
    }

    const errorParam = searchParams.get('error');
    if (errorParam) {
      setStatus('error');
      setMessage('간편 로그인이 취소되었거나 외부 로그인 서비스에서 오류가 발생했습니다.');
      notifyOAuthLinkError(normalizedProvider, '간편 로그인이 취소되었거나 실패했습니다.');
      return;
    }

    const code = searchParams.get('code');
    const state = callbackState;
    if (!code || !state) {
      setStatus('error');
      setMessage('로그인 응답에 필요한 정보가 없어 안전하게 중단했습니다.');
      notifyOAuthLinkError(normalizedProvider, '로그인 응답에 필요한 정보가 없습니다.');
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
        if (result.consentRequired) {
          setStatus('success');
          setMessage('처음 만드는 계정입니다. MineWiki에서 필수 정책을 확인합니다.');
          router.replace('/auth/signup-consent');
          return;
        }
        if (!('mode' in result) || !result.mode || !('account' in result) || !result.account) {
          throw new Error('로그인 응답을 확인할 수 없습니다. 다시 시도해 주세요.');
        }
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
        setMessage('로그인이 완료되었습니다. 이전 화면으로 이동합니다.');
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
  const title =
    status === 'pending'
      ? `${providerLabel} 로그인을 확인하고 있습니다.`
      : status === 'success'
        ? flowMode === 'link'
          ? '계정 연동이 완료되었습니다.'
          : '로그인이 완료되었습니다.'
        : '로그인을 완료하지 못했습니다.';
  const subtitle =
    status === 'pending'
      ? '외부 로그인에서 돌아왔습니다. MineWiki 계정 연결을 마무리하고 있습니다.'
      : message;
  const detailTitle =
    status === 'pending'
      ? `${providerLabel}에서 돌아오는 중입니다.`
      : status === 'success'
        ? flowMode === 'link'
          ? '계정 연결이 확정되었습니다.'
          : '세션 발급이 완료되었습니다.'
        : '간편 로그인을 완료하지 못했습니다.';
  const detailBody =
    status === 'pending'
      ? 'MineWiki에서 시작한 요청인지 확인하고 안전한 로그인 세션을 준비합니다.'
      : status === 'success'
        ? flowMode === 'link'
          ? linkCompletionTarget === 'opener'
            ? '원래 창으로 결과를 전달한 뒤 자동으로 닫힙니다.'
            : '연결된 로그인 수단을 반영한 계정 및 보안 화면으로 이동합니다.'
          : '잠시 후 이전 화면으로 자동 이동합니다.'
        : flowMode === 'link'
          ? '계정 페이지로 돌아가 로그인 수단 연결을 다시 시작해 주세요.'
          : '로그인 화면으로 돌아가 간편 로그인을 다시 시작해 주세요.';
  const actionLabel =
    status === 'pending'
      ? '처리 중'
      : status === 'error'
        ? flowMode === 'link' ? '계정 페이지로 돌아가기' : '로그인 페이지로 이동'
        : flowMode === 'link'
          ? linkCompletionTarget === 'opener' ? '창 닫기' : '계정 페이지로 이동'
          : '이전 화면으로 이동';
  const providerState = status === 'pending' ? 'pending' : status === 'success' ? 'success' : 'error';
  return (
    <CallbackShell
      eyebrow={flowMode === 'link' ? '계정 연결' : '간편 로그인'}
      title={title}
      subtitle={subtitle}
      shellTitle={flowMode === 'link' ? '로그인 수단 연결' : '로그인'}
      shellDescription={
        flowMode === 'link'
          ? 'MineWiki 계정에 새로운 로그인 수단을 안전하게 연결합니다.'
          : 'MineWiki 계정으로 로그인하거나 새 계정을 만들 수 있습니다.'
      }
      status={shellStatus}
    >
      <div
        role={status === 'error' ? 'alert' : 'status'}
        aria-live={status === 'error' ? 'assertive' : 'polite'}
        className="space-y-4"
      >
        <div className="grid grid-cols-2 gap-3" aria-label="간편 로그인 공급자">
          <OAuthProviderChoice
            provider="discord"
            state={normalizedProvider === 'discord' ? providerState : 'inactive'}
          />
          <OAuthProviderChoice
            provider="naver"
            state={normalizedProvider === 'naver' ? providerState : 'inactive'}
          />
        </div>

        <div className={`flex items-start gap-3 rounded-lg border px-3.5 py-3 ${
          status === 'error'
            ? 'border-rose-400/30 bg-rose-500/10'
            : 'border-[#35e5b7]/25 bg-[#35e5b7]/[0.07]'
        }`}>
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/10">
              {status === 'pending' ? (
                <Loader2 className={`h-4 w-4 animate-spin ${statusTone}`} aria-hidden />
              ) : status === 'success' ? (
                <CheckCircle2 className={`h-4 w-4 ${statusTone}`} aria-hidden />
              ) : (
                <XCircle className={`h-4 w-4 ${statusTone}`} aria-hidden />
              )}
            </div>
            <div className="min-w-0 text-left">
              <h2 className="text-sm font-semibold text-white">
                {detailTitle}
              </h2>
              <p className="mt-0.5 text-[11px] leading-5 text-slate-500">
                {detailBody}
              </p>
            </div>
        </div>

        <div className="flex items-center justify-between gap-3 px-0.5 text-[11px]">
          <span className="flex min-w-0 items-center gap-2 text-slate-400">
            <ShieldCheck className="h-4 w-4 flex-shrink-0 text-[#35e5b7]" aria-hidden />
            MineWiki 보안 연결
          </span>
          <span className={`flex-shrink-0 font-semibold ${statusTone}`}>
            {status === 'pending' ? '확인 중' : status === 'success' ? '확인 완료' : '다시 시도 필요'}
          </span>
        </div>

        <button
          type="button"
          disabled={status === 'pending'}
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#35e5b7] px-5 text-sm font-bold text-[#07100e] transition hover:bg-[#5bedc8] disabled:cursor-not-allowed disabled:border disabled:border-white/10 disabled:bg-white/[0.04] disabled:text-slate-500"
          onClick={() => {
            if (flowMode === 'link' && status === 'success') {
              if (linkCompletionTarget === 'redirect') {
                router.replace('/me');
                return;
              }
              closeOAuthWindowOrNavigate(window, (path) => router.replace(path));
              return;
            }
            if (status === 'error') {
              if (flowMode === 'link') {
                closeOAuthWindowOrNavigate(window, (path) => router.replace(path));
                return;
              }
              router.replace('/login');
              return;
            }
            router.replace('/me');
          }}
        >
          {status === 'pending' ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : status === 'error' ? (
            <RotateCcw className="h-4 w-4" aria-hidden />
          ) : flowMode === 'link' ? (
            <ExternalLink className="h-4 w-4" aria-hidden />
          ) : (
            <ShieldCheck className="h-4 w-4" aria-hidden />
          )}
          <span>{actionLabel}</span>
        </button>

        <p className="text-center text-[11px] leading-5 text-slate-500">
          인증 결과만 확인하며 외부 계정 비밀번호는 MineWiki에 저장되지 않습니다.
        </p>
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

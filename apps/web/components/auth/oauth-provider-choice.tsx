'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import type { OAuthProvider } from '@minewiki/schemas';

export type OAuthProviderChoiceState = 'idle' | 'pending' | 'success' | 'error' | 'inactive';

interface OAuthProviderChoiceProps {
  readonly provider: OAuthProvider;
  readonly state?: OAuthProviderChoiceState;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}

const PROVIDER_LABEL: Record<OAuthProvider, string> = {
  discord: 'Discord',
  naver: 'NAVER',
};

export function OAuthProviderChoice({
  provider,
  state = 'idle',
  disabled = false,
  onClick,
}: OAuthProviderChoiceProps) {
  const label = PROVIDER_LABEL[provider];
  const accent = provider === 'discord'
    ? 'auth-provider-label-discord text-[#7c87ff]'
    : 'auth-provider-label-naver text-[#18d86b]';
  const active = state !== 'idle' && state !== 'inactive';
  const className = `auth-provider-button flex min-h-14 items-center justify-between gap-3 rounded-lg border bg-[#0d1416] px-3.5 py-3 text-left transition ${
    active ? 'border-[#35e5b7]/35' : 'border-white/10'
  } ${
    state === 'inactive'
      ? 'opacity-45'
      : 'hover:border-[#35e5b7]/40 hover:bg-white/[0.045]'
  } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#35e5b7]/35 disabled:cursor-not-allowed`;
  const content = (
    <>
      <span className="min-w-0">
        <span className={`block truncate text-xs font-black tracking-[0.02em] ${accent}`}>
          {label}
        </span>
        <span className="mt-0.5 block text-[10px] font-medium text-slate-500">
          {stateLabel(state)}
        </span>
      </span>
      <ProviderStateIcon provider={provider} state={state} />
    </>
  );

  if (!onClick) {
    return (
      <div className={className} aria-current={active ? 'step' : undefined}>
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={className}
      disabled={disabled}
      aria-label={`${label}로 ${state === 'pending' ? '이동 중' : '간편 로그인'}`}
    >
      {content}
    </button>
  );
}

function stateLabel(state: OAuthProviderChoiceState): string {
  if (state === 'pending') return '계정 확인 중';
  if (state === 'success') return '확인 완료';
  if (state === 'error') return '다시 시도 필요';
  if (state === 'inactive') return '다른 로그인 수단';
  return '계정으로 계속';
}

function ProviderStateIcon({
  provider,
  state,
}: {
  readonly provider: OAuthProvider;
  readonly state: OAuthProviderChoiceState;
}) {
  if (state === 'pending') {
    return <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-[#35e5b7] motion-reduce:animate-none" aria-hidden />;
  }
  if (state === 'success') {
    return <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-[#35e5b7]" aria-hidden />;
  }
  if (state === 'error') {
    return <XCircle className="h-4 w-4 flex-shrink-0 text-rose-400" aria-hidden />;
  }
  return (
    <span
      className={`h-2 w-2 flex-shrink-0 rounded-full ${
        provider === 'discord' ? 'bg-[#7c87ff]' : 'bg-[#18d86b]'
      }`}
      aria-hidden
    />
  );
}

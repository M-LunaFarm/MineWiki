'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import type { OAuthProvider } from '@minewiki/schemas';
import { OAuthProviderChoice, type OAuthProviderChoiceState } from './oauth-provider-choice';

interface OAuthFlowStatusProps {
  readonly provider: OAuthProvider | null;
  readonly state: Extract<OAuthProviderChoiceState, 'idle' | 'pending' | 'success' | 'error'>;
  readonly title?: string;
  readonly description: string;
  readonly onProviderSelect?: (provider: OAuthProvider) => void;
  readonly providerDisabled?: Partial<Record<OAuthProvider, boolean>>;
}

export function OAuthFlowStatus({
  provider,
  state,
  title,
  description,
  onProviderSelect,
  providerDisabled,
}: OAuthFlowStatusProps) {
  const statusTone =
    state === 'pending'
      ? 'text-blue-200'
      : state === 'success'
        ? 'text-[#35e5b7]'
        : 'text-rose-400';

  const providerState = (candidate: OAuthProvider): OAuthProviderChoiceState => {
    if (state === 'idle') return 'idle';
    return provider === candidate ? state : 'inactive';
  };

  return (
    <div>
      <p className="mb-2 text-xs font-semibold text-slate-400">간편 로그인·가입</p>
      <div className="grid grid-cols-2 gap-3" aria-label="간편 로그인 공급자">
        <OAuthProviderChoice
          provider="discord"
          state={providerState('discord')}
          disabled={providerDisabled?.discord}
          onClick={onProviderSelect ? () => onProviderSelect('discord') : undefined}
        />
        <OAuthProviderChoice
          provider="naver"
          state={providerState('naver')}
          disabled={providerDisabled?.naver}
          onClick={onProviderSelect ? () => onProviderSelect('naver') : undefined}
        />
      </div>

      <div className="mt-2 min-h-[3.75rem]" aria-live={state === 'error' ? 'assertive' : 'polite'}>
        {state === 'idle' ? (
          <p className="text-[11px] leading-5 text-slate-500">{description}</p>
        ) : (
          <div
            className={`flex min-h-[3.75rem] items-center gap-3 rounded-lg border px-3.5 py-2.5 ${
              state === 'error'
                ? 'border-rose-400/30 bg-rose-500/10'
                : 'border-[#35e5b7]/25 bg-[#35e5b7]/[0.07]'
            }`}
          >
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/10">
              {state === 'pending' ? (
                <Loader2 className={`h-4 w-4 animate-spin motion-reduce:animate-none ${statusTone}`} aria-hidden />
              ) : state === 'success' ? (
                <CheckCircle2 className={`h-4 w-4 ${statusTone}`} aria-hidden />
              ) : (
                <XCircle className={`h-4 w-4 ${statusTone}`} aria-hidden />
              )}
            </div>
            <div className="min-w-0 text-left">
              {title ? <h2 className="text-xs font-semibold text-white">{title}</h2> : null}
              <p className="mt-0.5 text-[11px] leading-5 text-slate-500">{description}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

import dynamic from 'next/dynamic';
import { ShieldCheck } from 'lucide-react';

const Turnstile = dynamic(() => import('@marsidev/react-turnstile').then((module) => module.Turnstile), {
  ssr: false,
  loading: () => <div className="h-20 w-full animate-pulse rounded-lg bg-white/[0.04]" />,
});
const HCaptcha = dynamic(() => import('@hcaptcha/react-hcaptcha').then((module) => module.default), {
  ssr: false,
  loading: () => <div className="h-20 w-full animate-pulse rounded-lg bg-white/[0.04]" />,
});

const turnstileSiteKey = normalizeSiteKey(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
const hcaptchaSiteKey = normalizeSiteKey(process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY);

export function isCaptchaConfigured(): boolean {
  return Boolean(turnstileSiteKey || hcaptchaSiteKey);
}

export function CaptchaChallenge({
  resetKey,
  onTokenChange,
}: {
  readonly resetKey: number;
  readonly onTokenChange: (token: string | null) => void;
}) {
  if (!isCaptchaConfigured()) return null;
  return (
    <div className="space-y-3 rounded-lg border border-dashed border-white/15 bg-white/[0.025] p-4">
      <div className="flex gap-2 text-sm text-slate-300">
        <ShieldCheck className="mt-0.5 size-4 flex-none text-emerald-300" />
        <div><p className="font-medium text-white">새 콘텐츠 보안 확인</p><p className="mt-1 text-xs leading-5 text-slate-400">새 문서나 토론을 만들 때 한 번만 확인합니다.</p></div>
      </div>
      {turnstileSiteKey ? (
        <Turnstile
          key={`wiki-turnstile-${resetKey}`}
          siteKey={turnstileSiteKey}
          onSuccess={onTokenChange}
          onExpire={() => onTokenChange(null)}
          onError={() => onTokenChange(null)}
          options={{ theme: 'auto' }}
        />
      ) : hcaptchaSiteKey ? (
        <HCaptcha
          key={`wiki-hcaptcha-${resetKey}`}
          sitekey={hcaptchaSiteKey}
          onVerify={onTokenChange}
          onExpire={() => onTokenChange(null)}
          onError={() => onTokenChange(null)}
          theme="dark"
        />
      ) : null}
    </div>
  );
}

function normalizeSiteKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const lowered = trimmed.toLowerCase();
  return lowered.startsWith('your-') || lowered === 'undefined' || lowered === 'null' ? undefined : trimmed;
}

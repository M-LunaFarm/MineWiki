'use client';

import Link from 'next/link';
import { Check, Loader2, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { acceptOAuthSignupConsent } from '../../lib/auth-client';

export function OAuthSignupConsentClient() {
  const router = useRouter();
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!termsAccepted || !privacyAccepted || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await acceptOAuthSignupConsent();
      router.replace(isSafeReturnPath(result.returnTo) ? result.returnTo : '/me');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '최초 가입 동의를 저장하지 못했습니다.');
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-[#35e5b7]/20 bg-[#35e5b7]/[0.06] p-4">
        <ShieldCheck className="h-5 w-5 text-[#35e5b7]" aria-hidden />
        <h2 className="mt-3 text-base font-bold text-white">처음 만드는 MineWiki 계정입니다.</h2>
        <p className="mt-1.5 text-xs leading-6 text-slate-400">외부 계정 인증은 이미 끝났습니다. 아래 필수 정책에 동의하면 다시 로그인할 필요 없이 계정 생성과 로그인이 완료됩니다.</p>
      </div>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-xs font-semibold text-slate-300">최초 가입 필수 동의</legend>
        <ConsentRow checked={termsAccepted} onChange={setTermsAccepted} label="MineWiki 이용약관" href="/policies/terms" />
        <ConsentRow checked={privacyAccepted} onChange={setPrivacyAccepted} label="개인정보 처리방침" href="/policies/privacy" />
      </fieldset>

      {error ? <p role="alert" className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p> : null}

      <button type="button" disabled={!termsAccepted || !privacyAccepted || submitting} onClick={() => void submit()} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#35e5b7] px-5 text-sm font-bold text-[#07100e] transition hover:bg-[#5bedc8] disabled:cursor-not-allowed disabled:opacity-40">
        {submitting ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
        {submitting ? '계정을 만들고 있습니다.' : '동의하고 계정 만들기'}
      </button>
      <p className="text-center text-[11px] leading-5 text-slate-500">동의하지 않으면 계정이 생성되지 않으며, 잠시 후 가입 확인 정보가 자동 폐기됩니다.</p>
    </div>
  );
}

function ConsentRow({ checked, onChange, label, href }: { readonly checked: boolean; readonly onChange: (value: boolean) => void; readonly label: string; readonly href: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 bg-[#0d1416] p-4">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-4 w-4 accent-[#35e5b7]" />
      <span className="min-w-0 flex-1 text-xs leading-5 text-slate-300"><span className="mr-1 font-semibold text-rose-300">[필수]</span>{label}</span>
      <Link href={href} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs font-semibold text-[#35e5b7] hover:underline">전문 보기</Link>
    </label>
  );
}

function isSafeReturnPath(value: string | null | undefined): value is string {
  return Boolean(value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\'));
}

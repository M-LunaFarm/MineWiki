'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Check, Loader2, LogOut, ShieldCheck } from 'lucide-react';
import { acceptCurrentPolicies } from '../../lib/auth-client';
import { useAuth } from '../providers/auth-context';

export function PolicyConsentClient({ returnTo }: { readonly returnTo: string }) {
  const router = useRouter();
  const { account, loading, refresh, logout } = useAuth();
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!account) {
      router.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    if (!account.policyConsent?.required) {
      router.replace(returnTo);
      return;
    }
    setTermsAccepted(account.policyConsent.terms.accepted);
    setPrivacyAccepted(account.policyConsent.privacy.accepted);
  }, [account, loading, returnTo, router]);

  async function submit() {
    if (!termsAccepted || !privacyAccepted || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await acceptCurrentPolicies();
      await refresh();
      router.replace(returnTo);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '약관 동의를 저장하지 못했습니다.');
      setSubmitting(false);
    }
  }

  async function signOut() {
    setSubmitting(true);
    try {
      await logout();
      router.replace('/login');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading || !account) {
    return (
      <main className="mx-auto flex min-h-[65vh] max-w-2xl items-center justify-center px-4">
        <Loader2 className="size-6 animate-spin text-emerald-300" aria-label="계정 확인 중" />
      </main>
    );
  }

  const status = account.policyConsent;
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-12 sm:py-20">
      <section className="overflow-hidden rounded-3xl border border-border bg-[#11161e] shadow-2xl shadow-black/10">
        <div className="border-b border-border bg-[#11161e] px-6 py-7 sm:px-9">
          <div className="flex size-11 items-center justify-center rounded-2xl bg-emerald-400/10 text-emerald-300">
            <ShieldCheck className="size-6" />
          </div>
          <h1 className="mt-5 text-2xl font-extrabold text-foreground sm:text-3xl">개정된 정책을 확인해 주세요</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            로그인은 유지됩니다. 변경된 정책에 동의하기 전까지 읽기와 정책 확인 외의 변경 작업만 잠시 제한됩니다.
          </p>
        </div>

        <div className="space-y-4 px-6 py-7 sm:px-9">
          <PolicyCheck
            checked={termsAccepted}
            disabled={Boolean(status?.terms.accepted)}
            onChange={setTermsAccepted}
            title="MineWiki 이용약관"
            version={status?.terms.currentVersion ?? '현재 버전'}
            href="/policies/terms"
          />
          <PolicyCheck
            checked={privacyAccepted}
            disabled={Boolean(status?.privacy.accepted)}
            onChange={setPrivacyAccepted}
            title="개인정보 처리방침"
            version={status?.privacy.currentVersion ?? '현재 버전'}
            href="/policies/privacy"
          />

          {error ? (
            <p role="alert" className="rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {error}
            </p>
          ) : null}

          <button
            type="button"
            disabled={!termsAccepted || !privacyAccepted || submitting}
            onClick={() => void submit()}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-400 px-5 text-sm font-extrabold text-emerald-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            동의하고 계속하기
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void signOut()}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-border text-sm font-semibold text-muted-foreground transition hover:bg-[#11161e] hover:text-foreground disabled:opacity-40"
          >
            <LogOut className="size-4" /> 동의하지 않고 로그아웃
          </button>
        </div>
      </section>
    </main>
  );
}

function PolicyCheck({
  checked,
  disabled,
  onChange,
  title,
  version,
  href,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly title: string;
  readonly version: string;
  readonly href: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border bg-[#11161e] p-4">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 size-4 accent-emerald-400"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-foreground">{title}</span>
        <span className="mt-1 block text-xs text-muted-foreground">필수 · {version}</span>
      </span>
      <Link href={href} target="_blank" className="text-xs font-bold text-emerald-300 hover:underline">
        전문 보기
      </Link>
    </label>
  );
}

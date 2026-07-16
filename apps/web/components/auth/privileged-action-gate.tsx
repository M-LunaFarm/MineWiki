'use client';

import { KeyRound, Loader2, LogIn, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { MfaStepUpPurpose } from '../../lib/auth-client';
import { useAuth } from '../providers/auth-context';
import { MfaStepUpDialog } from './mfa-step-up-dialog';

export function PrivilegedActionGate({
  purpose,
  children,
  title = '보호된 작업 잠금 해제',
  description = '민감한 정보와 변경 작업을 보호하기 위해 등록된 인증 앱 또는 복구 코드로 한 번 더 확인해 주세요.',
  className,
  onUnlocked,
}: {
  readonly purpose: MfaStepUpPurpose;
  readonly children: ReactNode;
  readonly title?: string;
  readonly description?: string;
  readonly className?: string;
  readonly onUnlocked?: () => void | Promise<void>;
}) {
  const { account, loading } = useAuth();
  const pathname = usePathname();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [localStepUpExpiresAt, setLocalStepUpExpiresAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const sessionExpiry = account?.access?.stepUpPurpose === purpose
    ? account.access.stepUpExpiresAt
    : null;
  const effectiveExpiry = localStepUpExpiresAt ?? sessionExpiry ?? null;
  const unlocked = useMemo(() => {
    const expiryMs = effectiveExpiry ? Date.parse(effectiveExpiry) : Number.NaN;
    return Number.isFinite(expiryMs) && expiryMs > now;
  }, [effectiveExpiry, now]);

  useEffect(() => {
    setDialogOpen(false);
    setLocalStepUpExpiresAt(null);
  }, [purpose]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!unlocked || !onUnlocked) return;
    void onUnlocked();
  }, [onUnlocked, unlocked]);

  if (unlocked) return children;

  if (loading) {
    return (
      <section className={`surface-card mx-auto max-w-xl p-6 text-center sm:p-8 ${className ?? ''}`} role="status" aria-live="polite">
        <Loader2 className="mx-auto size-8 animate-spin text-emerald-300" aria-hidden="true" />
        <p className="mt-4 text-sm text-slate-300">로그인 상태를 확인하는 중입니다.</p>
      </section>
    );
  }

  if (!account) {
    const returnTo = pathname || '/';
    return (
      <section className={`surface-card mx-auto max-w-xl p-6 text-center sm:p-8 ${className ?? ''}`}>
        <LogIn className="mx-auto size-10 text-emerald-300" aria-hidden="true" />
        <h2 className="mt-4 text-xl font-extrabold text-white">로그인이 필요합니다</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">계정 권한을 먼저 확인한 뒤 다중 인증을 요청합니다.</p>
        <Link
          href={`/login?returnTo=${encodeURIComponent(returnTo)}`}
          className="btn-primary mt-5 min-h-11 gap-2"
        >
          <LogIn className="size-4" aria-hidden="true" /> 로그인하고 계속
        </Link>
      </section>
    );
  }

  return (
    <section className={`surface-card mx-auto max-w-xl p-6 text-center sm:p-8 ${className ?? ''}`}>
      <ShieldCheck className="mx-auto h-10 w-10 text-[#14c794]" />
      <h2 className="mt-4 text-xl font-extrabold text-white">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-400">{description}</p>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[#13ec80] px-4 py-2.5 text-sm font-extrabold text-[#07120f] transition hover:bg-[#35f29a]"
      >
        <KeyRound className="h-4 w-4" /> 다중 인증으로 계속
      </button>
      <MfaStepUpDialog
        open={dialogOpen}
        purpose={purpose}
        onClose={() => setDialogOpen(false)}
        onSuccess={(expiresAt) => setLocalStepUpExpiresAt(expiresAt)}
      />
    </section>
  );
}

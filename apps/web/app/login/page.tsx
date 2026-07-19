'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthForms } from '../../components/auth/auth-forms';
import { AuthShellLayout } from '../../components/auth/auth-shell-layout';
import { useAuth } from '../../components/providers/auth-context';

export default function LoginPage() {
  const { account, loading } = useAuth();
  const router = useRouter();
  const [redirectTarget, setRedirectTarget] = useState('/me');
  const [redirectTargetReady, setRedirectTargetReady] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const returnToParam = params.get('returnTo');
    if (isSafeReturnPath(returnToParam)) {
      setRedirectTarget(returnToParam);
    } else {
      setRedirectTarget('/me');
    }
    setRedirectTargetReady(true);
  }, []);

  useEffect(() => {
    if (redirectTargetReady && !loading && account) {
      router.replace(
        account.policyConsent?.required
          ? `/policies/consent?returnTo=${encodeURIComponent(redirectTarget)}`
          : redirectTarget,
      );
    }
  }, [account, loading, redirectTarget, redirectTargetReady, router]);

  return (
    <AuthShellLayout
      title="로그인"
      description={redirectTarget.startsWith('/servers/register')
        ? '로그인 후 서버 등록 단계로 자동으로 돌아갑니다. Discord, NAVER 또는 이메일 계정을 사용할 수 있습니다.'
        : 'MineWiki 계정으로 로그인하거나 새 계정을 만들 수 있습니다.'}
    >
      <AuthForms />
    </AuthShellLayout>
  );
}

function isSafeReturnPath(value: string | null): value is string {
  return Boolean(
    value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\'),
  );
}

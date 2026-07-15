import type { Metadata } from 'next';
import { PolicyConsentClient } from '../../../components/policies/policy-consent-client';
import { AuthShellLayout } from '../../../components/auth/auth-shell-layout';

export const metadata: Metadata = {
  title: '개정 약관 동의',
  robots: { index: false, follow: false },
};

export default async function PolicyConsentPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly returnTo?: string }>;
}) {
  const { returnTo } = await searchParams;
  return (
    <AuthShellLayout title="개정 정책 확인" description="로그인은 유지되며, 변경된 정책만 확인하면 이전 화면으로 돌아갑니다.">
      <PolicyConsentClient returnTo={safeReturnTo(returnTo)} />
    </AuthShellLayout>
  );
}

function safeReturnTo(value?: string): string {
  return value?.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : '/me';
}

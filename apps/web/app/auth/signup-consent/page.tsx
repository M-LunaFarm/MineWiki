import type { Metadata } from 'next';
import { AuthShellLayout } from '../../../components/auth/auth-shell-layout';
import { OAuthSignupConsentClient } from '../../../components/auth/oauth-signup-consent-client';
import type { OAuthProvider } from '@minewiki/schemas';

export const metadata: Metadata = {
  title: '최초 가입 동의',
  robots: { index: false, follow: false },
};

interface OAuthSignupConsentPageProps {
  readonly searchParams: Promise<{ provider?: string }>;
}

export default async function OAuthSignupConsentPage({ searchParams }: OAuthSignupConsentPageProps) {
  const provider = normalizeProvider((await searchParams).provider);
  return (
    <AuthShellLayout title="로그인" description="MineWiki 계정으로 로그인하거나 새 계정을 만들 수 있습니다.">
      <OAuthSignupConsentClient provider={provider} />
    </AuthShellLayout>
  );
}

function normalizeProvider(provider: string | undefined): OAuthProvider | null {
  return provider === 'discord' || provider === 'naver' ? provider : null;
}

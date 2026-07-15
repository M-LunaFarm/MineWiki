import type { Metadata } from 'next';
import { AuthShellLayout } from '../../../components/auth/auth-shell-layout';
import { OAuthSignupConsentClient } from '../../../components/auth/oauth-signup-consent-client';

export const metadata: Metadata = {
  title: '최초 가입 동의',
  robots: { index: false, follow: false },
};

export default function OAuthSignupConsentPage() {
  return (
    <AuthShellLayout title="최초 가입 확인" description="외부 계정 인증을 이어서 MineWiki 계정을 안전하게 만듭니다.">
      <OAuthSignupConsentClient />
    </AuthShellLayout>
  );
}

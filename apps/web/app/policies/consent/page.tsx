import type { Metadata } from 'next';
import { PolicyConsentClient } from '../../../components/policies/policy-consent-client';

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
  return <PolicyConsentClient returnTo={safeReturnTo(returnTo)} />;
}

function safeReturnTo(value?: string): string {
  return value?.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : '/me';
}

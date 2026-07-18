import type { Metadata } from 'next';
import { EmailChangeConfirmClient } from './confirm-client';

export const metadata: Metadata = { title: '이메일 변경 확인' };

export default async function EmailChangeConfirmPage({ searchParams }: {
  readonly searchParams: Promise<{ readonly token?: string }>;
}) {
  const { token = '' } = await searchParams;
  return <EmailChangeConfirmClient token={token} />;
}

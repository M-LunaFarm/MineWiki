import type { Metadata } from 'next';
import ResendVerificationClient from './resend-verification-client';
import { createPageMetadata } from '../../../lib/metadata';

export const metadata: Metadata = createPageMetadata({
  title: '인증 메일 재전송',
  description: '이메일 인증 메일을 다시 보내는 페이지입니다.',
  path: '/login/resend-verification',
  noIndex: true,
});

export default function ResendVerificationPage() {
  return <ResendVerificationClient />;
}

import type { Metadata } from 'next';
import ForgotPasswordClient from './forgot-password-client';
import { createPageMetadata } from '../../../lib/metadata';

export const metadata: Metadata = createPageMetadata({
  title: '비밀번호 재설정 요청',
  description: '이메일 계정 비밀번호 재설정을 요청하는 페이지입니다.',
  path: '/login/forgot-password',
  noIndex: true,
});

export default function ForgotPasswordPage() {
  return <ForgotPasswordClient />;
}

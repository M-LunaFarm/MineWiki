import type { Metadata } from 'next';
import { Suspense } from 'react';
import ResetPasswordClient from './reset-password-client';
import { createPageMetadata } from '../../../lib/metadata';

export const metadata: Metadata = createPageMetadata({
  title: '새 비밀번호 설정',
  description: '이메일로 전송된 토큰으로 비밀번호를 변경합니다.',
  path: '/login/reset-password',
  noIndex: true,
});

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#f4f0e6] px-4">
          <div className="w-full max-w-md rounded-lg border border-[#ded7c8] bg-white p-8 text-center text-sm text-[#666b72] shadow-[0_24px_70px_rgba(35,31,25,0.12)]">
            로딩 중...
          </div>
        </div>
      }
    >
      <ResetPasswordClient />
    </Suspense>
  );
}

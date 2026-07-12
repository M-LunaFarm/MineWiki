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
        <div className="flex min-h-screen items-center justify-center bg-[#070a0c] px-4">
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#0d1416] p-8 text-center text-sm text-slate-400 shadow-2xl">
            로딩 중...
          </div>
        </div>
      }
    >
      <ResetPasswordClient />
    </Suspense>
  );
}

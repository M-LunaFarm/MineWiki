'use client';

import Link from 'next/link';
import { useState } from 'react';
import { resendVerification } from '../../../lib/auth-client';
import { AuthShellLayout } from '../../../components/auth/auth-shell-layout';

export default function ResendVerificationClient() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim()) {
      setStatus({ type: 'error', message: '이메일을 입력해 주세요.' });
      return;
    }
    setLoading(true);
    setStatus(null);
    try {
      await resendVerification(email.trim());
      setStatus({
        type: 'success',
        message: '인증 메일을 다시 보냈습니다. 이메일을 확인해 주세요.',
      });
    } catch (error) {
      setStatus({
        type: 'error',
        message: error instanceof Error ? error.message : '요청에 실패했습니다.',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShellLayout
      title="인증 메일 재전송"
      description="가입한 이메일 주소로 계정 인증 메일을 다시 발송합니다."
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        <label className="flex flex-col gap-2 text-xs font-semibold text-slate-300">
          이메일 주소
          <input
            className="rounded-lg border border-white/15 bg-[#0d1416] px-4 py-3 text-sm text-white outline-none transition-all placeholder:text-[#9aa0a6] focus:border-[#35e5b7] focus:bg-white/[0.04] focus:ring-2 focus:ring-[#35e5b7]/15"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.com"
            required
          />
        </label>
        {status ? (
          <p
            className={`rounded-lg border px-3 py-2 text-sm ${
              status.type === 'success'
                ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                : 'border-rose-400/30 bg-rose-500/10 text-rose-300'
            }`}
          >
            {status.message}
          </p>
        ) : null}
        <button
          type="submit"
          className="w-full rounded-lg bg-[#13ec80] px-4 py-3 text-sm font-semibold text-[#06110d] transition hover:bg-[#10cf70] disabled:opacity-50"
          disabled={loading}
        >
          {loading ? '전송 중...' : '인증 메일 재전송'}
        </button>
      </form>

      <div className="mt-6 flex flex-wrap gap-2">
        <Link
          className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200 transition hover:border-[#35e5b7]/50 hover:text-[#35e5b7]"
          href="/login"
        >
          로그인 페이지로 돌아가기
        </Link>
        <Link
          className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200 transition hover:border-[#35e5b7]/50 hover:text-[#35e5b7]"
          href="/me"
        >
          계정 센터 이동
        </Link>
      </div>
    </AuthShellLayout>
  );
}

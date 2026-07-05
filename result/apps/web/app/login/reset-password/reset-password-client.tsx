'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { resetPassword } from '../../../lib/auth-client';
import { AuthShellLayout } from '../../../components/auth/auth-shell-layout';

export default function ResetPasswordClient() {
  const searchParams = useSearchParams();
  const [token, setToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    const initial = searchParams?.get('token');
    if (initial) {
      setToken(initial);
    }
  }, [searchParams]);

  const passwordLengthValid = newPassword.length >= 8;
  const passwordUppercaseValid = /[A-Z]/.test(newPassword);
  const passwordSpecialValid = /[^A-Za-z0-9]/.test(newPassword);
  const passwordFullyValid = passwordLengthValid && passwordUppercaseValid && passwordSpecialValid;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token.trim()) {
      setStatus({ type: 'error', message: '재설정 토큰을 입력해 주세요.' });
      return;
    }
    if (!passwordFullyValid) {
      setStatus({
        type: 'error',
        message: '비밀번호는 8자 이상, 대문자 및 특수문자를 포함해야 합니다.',
      });
      return;
    }
    if (newPassword !== confirmPassword) {
      setStatus({ type: 'error', message: '비밀번호 확인이 일치하지 않습니다.' });
      return;
    }
    setLoading(true);
    setStatus(null);
    try {
      await resetPassword({ token: token.trim(), newPassword });
      setStatus({ type: 'success', message: '비밀번호가 변경되었습니다. 다시 로그인해 주세요.' });
      setNewPassword('');
      setConfirmPassword('');
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
      title="새 비밀번호 설정"
      description="메일로 받은 재설정 토큰과 새 비밀번호를 입력해 주세요."
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        <label className="flex flex-col gap-2 text-xs font-semibold text-[#555b62]">
          재설정 토큰
          <input
            className="rounded-lg border border-[#d8d0c0] bg-[#fcfaf5] px-4 py-3 text-sm text-[#1f2328] outline-none transition-all placeholder:text-[#9aa0a6] focus:border-[#16824d] focus:bg-white focus:ring-2 focus:ring-[#16824d]/15"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="이메일로 받은 코드"
            required
          />
        </label>
        <label className="flex flex-col gap-2 text-xs font-semibold text-[#555b62]">
          새 비밀번호
          <input
            className="rounded-lg border border-[#d8d0c0] bg-[#fcfaf5] px-4 py-3 text-sm text-[#1f2328] outline-none transition-all placeholder:text-[#9aa0a6] focus:border-[#16824d] focus:bg-white focus:ring-2 focus:ring-[#16824d]/15"
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            placeholder="새 비밀번호"
            required
          />
        </label>
        <label className="flex flex-col gap-2 text-xs font-semibold text-[#555b62]">
          새 비밀번호 확인
          <input
            className="rounded-lg border border-[#d8d0c0] bg-[#fcfaf5] px-4 py-3 text-sm text-[#1f2328] outline-none transition-all placeholder:text-[#9aa0a6] focus:border-[#16824d] focus:bg-white focus:ring-2 focus:ring-[#16824d]/15"
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            placeholder="새 비밀번호 확인"
            required
          />
        </label>

        <ul className="space-y-1 rounded-lg border border-[#ded7c8] bg-[#fcfaf5] px-4 py-3 text-xs text-[#666b72]">
          <PasswordRule met={passwordLengthValid}>8자 이상</PasswordRule>
          <PasswordRule met={passwordUppercaseValid}>대문자 포함</PasswordRule>
          <PasswordRule met={passwordSpecialValid}>특수문자 포함</PasswordRule>
        </ul>

        {status ? (
          <p
            className={`rounded-lg border px-3 py-2 text-sm ${
              status.type === 'success'
                ? 'border-[#a8d9bd] bg-[#effaf3] text-[#0f6a3d]'
                : 'border-[#f0b8ad] bg-[#fff4f2] text-[#b42318]'
            }`}
          >
            {status.message}
          </p>
        ) : null}
        <button
          type="submit"
          className="w-full rounded-lg bg-[#13ec80] px-4 py-3 text-sm font-semibold text-[#0f1713] transition hover:bg-[#10cf70] disabled:opacity-50"
          disabled={loading}
        >
          {loading ? '변경 중...' : '비밀번호 변경'}
        </button>
      </form>

      <div className="mt-6 flex flex-wrap gap-2">
        <Link
          className="rounded-lg border border-[#ded7c8] bg-white px-4 py-2 text-xs font-semibold text-[#3f454c] transition hover:border-[#16824d]/50 hover:text-[#16824d]"
          href="/login"
        >
          로그인 페이지로 돌아가기
        </Link>
        <Link
          className="rounded-lg border border-[#ded7c8] bg-white px-4 py-2 text-xs font-semibold text-[#3f454c] transition hover:border-[#16824d]/50 hover:text-[#16824d]"
          href="/login/forgot-password"
        >
          재설정 메일 다시 받기
        </Link>
      </div>
    </AuthShellLayout>
  );
}

function PasswordRule(props: { met: boolean; children: ReactNode }) {
  const { met, children } = props;
  return (
    <li className={`flex items-center gap-2 ${met ? 'text-[#16824d]' : 'text-[#7a7f86]'}`}>
      <span
        className={`flex h-4 w-4 items-center justify-center rounded-full border text-[10px] ${
          met
            ? 'border-[#16824d]/70 bg-[#e9f5ee] text-[#16824d]'
            : 'border-[#d8d0c0] text-[#7a7f86]'
        }`}
      >
        {met ? '✓' : '•'}
      </span>
      {children}
    </li>
  );
}

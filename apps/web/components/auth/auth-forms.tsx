'use client';

import Link from 'next/link';
import { Check, Eye, EyeOff, MessageCircle, Minus } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '../providers/auth-context';
import {
  fetchOAuthProviderAvailability,
  type OAuthProviderAvailability,
} from '../../lib/auth-client';
import type { OAuthProvider } from '@minewiki/schemas';

export function AuthForms() {
  const {
    account,
    loading,
    loginEmail,
    registerEmail,
    loginOAuth,
    logout,
    verifyEmail,
    resendVerification,
  } = useAuth();

  const [mode, setMode] = useState<'login' | 'register' | 'verify'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [pendingVerification, setPendingVerification] = useState<{
    email: string;
    expiresAt: string;
  } | null>(null);
  const [verifyToken, setVerifyToken] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [oauthAvailability, setOauthAvailability] = useState<OAuthProviderAvailability>({
    discord: true,
    naver: true,
  });

  useEffect(() => {
    let mounted = true;
    const loadAvailability = async () => {
      try {
        const availability = await fetchOAuthProviderAvailability();
        if (mounted) {
          setOauthAvailability(availability);
        }
      } catch {
        // Keep defaults enabled on fetch failure.
      }
    };
    void loadAvailability();
    return () => {
      mounted = false;
    };
  }, []);

  const passwordLengthValid = password.length >= 8;
  const passwordUppercaseValid = /[A-Z]/.test(password);
  const passwordSpecialValid = /[^A-Za-z0-9]/.test(password);
  const passwordFullyValid = passwordLengthValid && passwordUppercaseValid && passwordSpecialValid;
  const showPasswordHints = passwordFocused || password.length > 0;
  const passwordsMatch =
    mode === 'register' && confirmPassword.length > 0 ? password === confirmPassword : null;

  const clearTransientMessages = () => {
    setError(null);
    setNotice(null);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mode === 'verify') {
      return;
    }

    clearTransientMessages();

    try {
      if (mode === 'login') {
        await loginEmail({ email, password });
      } else {
        if (!displayName.trim()) {
          setError('닉네임을 입력해 주세요.');
          return;
        }
        if (!passwordFullyValid) {
          setError('비밀번호는 8자 이상, 대문자 및 특수문자를 포함해야 합니다.');
          return;
        }
        if (password !== confirmPassword) {
          setError('비밀번호 확인이 일치하지 않습니다.');
          return;
        }
        if (!termsAccepted || !privacyAccepted) {
          setError('이용약관과 개인정보 처리방침에 모두 동의해야 합니다.');
          return;
        }

        const result = await registerEmail({
          email,
          password,
          displayName: displayName.trim(),
          agreeTerms: true,
          agreePrivacy: true,
        });
        setPendingVerification({
          email: result.email,
          expiresAt: result.expiresAt,
        });
        setVerifyToken('');
        setMode('verify');
        setNotice('인증 코드가 이메일로 발송되었습니다.');
      }

      setEmail('');
      setPassword('');
      setConfirmPassword('');
      setDisplayName('');
      setTermsAccepted(false);
      setPrivacyAccepted(false);
      setPasswordFocused(false);
      setShowPassword(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '요청이 실패했습니다.');
    }
  };

  const handleVerifySubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clearTransientMessages();

    if (!verifyToken.trim()) {
      setError('이메일로 전달된 인증 코드를 입력해주세요.');
      return;
    }

    try {
      await verifyEmail(verifyToken.trim());
      setNotice('이메일 인증이 완료되었습니다. 잠시 후 자동으로 계정으로 이동합니다.');
      setPendingVerification(null);
      setVerifyToken('');
      setMode('login');
    } catch (verificationError) {
      setError(
        verificationError instanceof Error
          ? verificationError.message
          : '이메일 인증에 실패했습니다. 토큰을 다시 확인해 주세요.',
      );
    }
  };

  const handleResendVerification = async () => {
    if (!pendingVerification) {
      return;
    }

    clearTransientMessages();
    try {
      const result = await resendVerification(pendingVerification.email);
      setPendingVerification({
        email: result.email,
        expiresAt: result.expiresAt,
      });
      setVerifyToken('');
      setNotice('새 인증 코드를 이메일로 전송했습니다.');
    } catch (resendError) {
      setError(
        resendError instanceof Error
          ? resendError.message
          : '인증 코드를 재발급하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      );
    }
  };

  const PROVIDER_LABEL: Record<OAuthProvider, string> = {
    discord: 'Discord',
    naver: 'NAVER',
  };

  const handleOAuth = async (provider: OAuthProvider) => {
    setOauthError(null);

    if (mode === 'register' && (!termsAccepted || !privacyAccepted)) {
      setOauthError('처음 가입할 때는 이용약관과 개인정보 처리방침 동의가 필요합니다.');
      return;
    }

    if (!oauthAvailability[provider]) {
      setOauthError(`${PROVIDER_LABEL[provider]} 로그인이 현재 비활성화되어 있습니다.`);
      return;
    }

    try {
      let returnTo: string | undefined;
      if (typeof window !== 'undefined') {
        const requestedReturnTo = new URLSearchParams(window.location.search).get('returnTo');
        if (isSafeReturnPath(requestedReturnTo)) {
          returnTo = requestedReturnTo;
        } else if (window.location.pathname === '/login' || window.location.pathname === '/auth') {
          returnTo = '/me';
        } else {
          returnTo = `${window.location.pathname}${window.location.search}`;
        }
      }
      await loginOAuth(provider, {
        returnTo,
        agreeTerms: mode === 'register',
        agreePrivacy: mode === 'register',
      });
    } catch (oauthProblem) {
      const message =
        oauthProblem instanceof Error ? oauthProblem.message : '간편 로그인을 시작하지 못했습니다.';
      setOauthError(message);
    }
  };

  if (account) {
    return (
      <div className="space-y-4 rounded-lg border border-white/10 bg-[#0d1416] p-5">
        <h3 className="text-sm font-semibold text-white">로그인된 계정</h3>
        <p className="text-sm text-slate-200">
          {account.displayName ?? account.email ?? '알 수 없는 사용자'}
        </p>
        <p className="text-xs text-slate-400">연동 방식: {account.provider}</p>
        <div className="flex flex-wrap gap-2 text-xs">
          <Link
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-slate-200 hover:border-[#35e5b7]/50 hover:text-[#35e5b7]"
            href="/servers/register"
          >
            서버 등록
          </Link>
          <Link
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-slate-200 hover:border-[#35e5b7]/50 hover:text-[#35e5b7]"
            href="/dashboard"
          >
            대시보드
          </Link>
          <Link
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-slate-200 hover:border-[#35e5b7]/50 hover:text-[#35e5b7]"
            href="/me"
          >
            계정 관리
          </Link>
        </div>
        <button
          type="button"
          className="w-full rounded-lg border border-[#d8c8bc] bg-white/[0.04] px-4 py-2 text-xs font-semibold text-[#7d2d2d] transition hover:border-[#b85454] hover:text-[#9e2f2f]"
          disabled={loading}
          onClick={() => void logout()}
        >
          로그아웃
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {mode !== 'verify' ? (
        <div className="grid grid-cols-2 rounded-lg border border-white/10 bg-white/[0.04] p-1">
          <button
            type="button"
            className={`rounded-md py-2.5 text-sm font-semibold transition-colors ${
              mode === 'login'
                ? 'bg-[#35e5b7]/10 text-[#35e5b7] shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
            onClick={() => {
              setMode('login');
              clearTransientMessages();
              setOauthError(null);
              setPendingVerification(null);
            }}
          >
            로그인
          </button>
          <button
            type="button"
            className={`rounded-md py-2.5 text-sm font-semibold transition-colors ${
              mode === 'register'
                ? 'bg-[#35e5b7]/10 text-[#35e5b7] shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
            onClick={() => {
              setMode('register');
              clearTransientMessages();
              setOauthError(null);
              setPendingVerification(null);
            }}
          >
            회원가입
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => void handleOAuth('discord')}
          className="flex items-center justify-center gap-2 rounded-lg bg-[#5865F2] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#4752c4] disabled:cursor-not-allowed disabled:opacity-50"
          disabled={loading || !oauthAvailability.discord}
        >
          <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-white/20">
            <MessageCircle className="h-4 w-4 text-white" aria-hidden />
          </span>
          Discord
        </button>
        <button
          type="button"
          onClick={() => void handleOAuth('naver')}
          className="flex items-center justify-center gap-2 rounded-lg bg-[#03C75A] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#02b350] disabled:cursor-not-allowed disabled:opacity-50"
          disabled={loading || !oauthAvailability.naver}
        >
          <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-white text-sm font-extrabold text-[#03C75A]">
            N
          </span>
          NAVER
        </button>
      </div>

      {!oauthAvailability.discord || !oauthAvailability.naver ? (
        <p className="rounded-lg border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
          일부 간편 로그인 옵션은 현재 비활성화되어 있습니다.
        </p>
      ) : null}
      {oauthError ? (
        <p className="rounded-lg border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
          {oauthError}
        </p>
      ) : null}

      {mode === 'register' ? (
        <>
          <PolicyAgreements
            termsAccepted={termsAccepted}
            privacyAccepted={privacyAccepted}
            onTermsChange={setTermsAccepted}
            onPrivacyChange={setPrivacyAccepted}
          />
          <p className="-mt-4 text-[11px] leading-5 text-slate-500">
            최초 회원가입에만 적용됩니다. 기존 계정 로그인에는 다시 동의를 요구하지 않습니다.
          </p>
        </>
      ) : null}

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-white/10" />
        </div>
        <div className="relative flex justify-center text-xs">
          <span className="bg-[#09100f] px-2 text-slate-500">이메일로 계속하기</span>
        </div>
      </div>

      {mode !== 'verify' ? (
        <>
          <form className="space-y-5" onSubmit={handleSubmit}>
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-300" htmlFor="email">
                이메일 주소
              </label>
              <input
                id="email"
                className="w-full rounded-lg border border-white/15 bg-[#0d1416] px-4 py-3 text-sm text-white outline-none transition-all placeholder:text-[#9aa0a6] focus:border-[#35e5b7] focus:bg-white/[0.04] focus:ring-2 focus:ring-[#35e5b7]/15"
                type="email"
                placeholder="name@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>

            <div>
              <label
                className="mb-1.5 block text-xs font-semibold text-slate-300"
                htmlFor="password"
              >
                비밀번호
              </label>
              <div className="relative">
                <input
                  id="password"
                  className="w-full rounded-lg border border-white/15 bg-[#0d1416] px-4 py-3 pr-12 text-sm text-white outline-none transition-all placeholder:text-[#9aa0a6] focus:border-[#35e5b7] focus:bg-white/[0.04] focus:ring-2 focus:ring-[#35e5b7]/15"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="비밀번호"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onFocus={() => setPasswordFocused(true)}
                  onBlur={() => setPasswordFocused(false)}
                  required
                  minLength={8}
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 transition-colors hover:text-white"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {showPasswordHints && mode === 'register' ? (
              <div className="rounded-lg border border-white/10 bg-[#0d1416] p-3 text-xs text-slate-400">
                <p className="font-semibold text-white">비밀번호 조건</p>
                <ul className="mt-2 space-y-1">
                  <PasswordRequirement met={passwordLengthValid}>8자 이상 입력</PasswordRequirement>
                  <PasswordRequirement met={passwordUppercaseValid}>
                    대문자 최소 1자 포함
                  </PasswordRequirement>
                  <PasswordRequirement met={passwordSpecialValid}>
                    특수문자 최소 1자 포함
                  </PasswordRequirement>
                </ul>
              </div>
            ) : null}

            {mode === 'register' ? (
              <>
                <div>
                  <label
                    className="mb-1.5 block text-xs font-semibold text-slate-300"
                    htmlFor="confirmPassword"
                  >
                    비밀번호 확인
                  </label>
                  <input
                    id="confirmPassword"
                    className="w-full rounded-lg border border-white/15 bg-[#0d1416] px-4 py-3 text-sm text-white outline-none transition-all placeholder:text-[#9aa0a6] focus:border-[#35e5b7] focus:bg-white/[0.04] focus:ring-2 focus:ring-[#35e5b7]/15"
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    required
                    minLength={8}
                  />
                </div>
                {passwordsMatch !== null ? (
                  <p className={`text-xs ${passwordsMatch ? 'text-[#35e5b7]' : 'text-rose-300'}`}>
                    {passwordsMatch ? '비밀번호가 일치합니다.' : '비밀번호가 일치하지 않습니다.'}
                  </p>
                ) : null}

                <div>
                  <label
                    className="mb-1.5 block text-xs font-semibold text-slate-300"
                    htmlFor="displayName"
                  >
                    닉네임
                  </label>
                  <input
                    id="displayName"
                    className="w-full rounded-lg border border-white/15 bg-[#0d1416] px-4 py-3 text-sm text-white outline-none transition-all placeholder:text-[#9aa0a6] focus:border-[#35e5b7] focus:bg-white/[0.04] focus:ring-2 focus:ring-[#35e5b7]/15"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="커뮤니티에 표시될 이름"
                    required
                  />
                </div>

                <p className="text-xs leading-5 text-slate-400">
                  위 필수 정책 동의는 이메일 회원가입과 간편 로그인에 공통으로 적용됩니다.
                </p>
              </>
            ) : (
              <div className="flex justify-end">
                <Link
                  className="text-xs font-semibold text-[#35e5b7] transition-colors hover:text-[#0f5f38]"
                  href="/login/forgot-password"
                >
                  비밀번호 찾기
                </Link>
              </div>
            )}

            {error ? (
              <p className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
                {notice}
              </p>
            ) : null}

            <button
              type="submit"
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-[#13ec80] px-6 py-3.5 text-sm font-bold text-[#06110d] shadow-sm transition-all hover:bg-[#10cf70] disabled:opacity-50"
              disabled={loading}
            >
              {mode === 'login' ? '로그인하기' : '가입 후 인증 진행'}
            </button>
          </form>

          {mode === 'login' ? (
            <div className="mt-6 space-y-2 text-center">
              <p className="text-xs text-slate-400">
                계정에 문제가 있나요?{' '}
                <Link
                  className="font-semibold text-[#35e5b7] underline decoration-[#9bbda8] underline-offset-2 transition-colors hover:text-[#0f5f38]"
                  href="/login/resend-verification"
                >
                  인증 메일 재전송
                </Link>
              </p>
              <p className="text-xs text-slate-400">
                <Link
                  className="font-semibold text-[#35e5b7] transition-colors hover:text-[#0f5f38]"
                  href="/login/forgot-password"
                >
                  비밀번호 재설정
                </Link>
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <form className="space-y-4" onSubmit={handleVerifySubmit}>
          <div className="rounded-lg border border-white/10 bg-[#0d1416] p-4 text-sm text-white">
            <p className="font-semibold text-[#35e5b7]">이메일 인증 대기 중</p>
            <p className="mt-2 text-xs leading-5 text-slate-400">
              {pendingVerification
                ? `${pendingVerification.email} 주소로 인증 코드를 발송했습니다. 만료 시간 ${new Date(
                    pendingVerification.expiresAt,
                  ).toLocaleString('ko-KR')} 이전에 입력해주세요.`
                : '등록된 이메일 주소를 찾을 수 없습니다. 처음부터 다시 시도해 주세요.'}
            </p>
          </div>

          <div>
            <label
              className="mb-1.5 block text-xs font-semibold text-slate-300"
              htmlFor="verifyToken"
            >
              인증 코드
            </label>
            <input
              id="verifyToken"
              className="w-full rounded-lg border border-white/15 bg-[#0d1416] px-4 py-3 text-sm text-white outline-none transition-all placeholder:text-[#9aa0a6] focus:border-[#35e5b7] focus:bg-white/[0.04] focus:ring-2 focus:ring-[#35e5b7]/15"
              value={verifyToken}
              onChange={(event) => setVerifyToken(event.target.value)}
              placeholder="이메일로 전송된 코드 입력"
              required
            />
          </div>

          {error ? (
            <p className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
              {notice}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200 transition hover:border-[#35e5b7]/50 hover:text-[#35e5b7] disabled:opacity-50"
              onClick={() => void handleResendVerification()}
              disabled={loading || !pendingVerification}
            >
              인증 코드 재발급
            </button>
            <button
              type="submit"
              className="rounded-lg bg-[#13ec80] px-4 py-2 text-xs font-semibold text-[#06110d] transition hover:bg-[#10cf70] disabled:opacity-50"
              disabled={loading}
            >
              이메일 인증 완료
            </button>
          </div>

          <button
            type="button"
            className="text-xs font-semibold text-[#35e5b7] underline transition hover:text-[#0f5f38]"
            onClick={() => {
              setMode('login');
              setPendingVerification(null);
              setVerifyToken('');
              setNotice(null);
              setError(null);
            }}
          >
            다른 계정으로 로그인하기
          </button>
        </form>
      )}
    </div>
  );
}

function PolicyAgreements({
  termsAccepted,
  privacyAccepted,
  onTermsChange,
  onPrivacyChange,
}: {
  readonly termsAccepted: boolean;
  readonly privacyAccepted: boolean;
  readonly onTermsChange: (value: boolean) => void;
  readonly onPrivacyChange: (value: boolean) => void;
}) {
  return (
    <fieldset className="space-y-2 rounded-lg border border-white/10 bg-[#0d1416] px-4 py-3 text-xs leading-5 text-slate-400">
      <legend className="px-1 font-semibold text-slate-200">간편 로그인·신규 가입 필수 동의</legend>
      <PolicyCheckbox checked={termsAccepted} onChange={onTermsChange} href="/policies/terms" label="이용약관" />
      <PolicyCheckbox checked={privacyAccepted} onChange={onPrivacyChange} href="/policies/privacy" label="개인정보 처리방침" />
    </fieldset>
  );
}

function PolicyCheckbox({ checked, onChange, href, label }: { readonly checked: boolean; readonly onChange: (value: boolean) => void; readonly href: string; readonly label: string }) {
  return (
    <label className="flex items-start gap-3">
      <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-white/20 bg-white/[0.04] text-[#35e5b7] focus:ring-[#35e5b7]" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span><span className="mr-1 font-semibold text-rose-300">[필수]</span><Link className="text-[#35e5b7] underline" href={href} target="_blank" rel="noopener noreferrer">{label}</Link>에 동의합니다.</span>
    </label>
  );
}

function isSafeReturnPath(value: string | null): value is string {
  return Boolean(
    value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\'),
  );
}

function PasswordRequirement(props: { met: boolean; children: ReactNode }) {
  const { met, children } = props;
  return (
    <li className={`flex items-center gap-2 ${met ? 'text-[#35e5b7]' : 'text-slate-500'}`}>
      <span
        className={`flex h-4 w-4 items-center justify-center rounded-full border text-[10px] ${
          met
            ? 'border-[#35e5b7]/70 bg-[#35e5b7]/10 text-[#35e5b7]'
            : 'border-white/15 text-slate-500'
        }`}
      >
        {met ? <Check className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
      </span>
      {children}
    </li>
  );
}

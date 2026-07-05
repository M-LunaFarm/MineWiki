'use client';

import Link from 'next/link';
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
  const [agreementsAccepted, setAgreementsAccepted] = useState(false);
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
        if (!agreementsAccepted) {
          setError('이용약관과 개인정보 처리방침에 모두 동의해야 합니다.');
          return;
        }

        const result = await registerEmail({
          email,
          password,
          displayName: displayName.trim(),
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
      setAgreementsAccepted(false);
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
      await loginOAuth(provider, { returnTo });
    } catch (oauthProblem) {
      const message =
        oauthProblem instanceof Error ? oauthProblem.message : '간편 로그인을 시작하지 못했습니다.';
      setOauthError(message);
    }
  };

  if (account) {
    return (
      <div className="space-y-4 rounded-lg border border-[#ded7c8] bg-[#fcfaf5] p-5">
        <h3 className="text-sm font-semibold text-[#1f2328]">로그인된 계정</h3>
        <p className="text-sm text-[#3f454c]">
          {account.displayName ?? account.email ?? '알 수 없는 사용자'}
        </p>
        <p className="text-xs text-[#666b72]">연동 방식: {account.provider}</p>
        <div className="flex flex-wrap gap-2 text-xs">
          <Link
            className="rounded-lg border border-[#ded7c8] bg-white px-3 py-2 text-[#3f454c] hover:border-[#16824d]/50 hover:text-[#16824d]"
            href="/servers/register"
          >
            서버 등록
          </Link>
          <Link
            className="rounded-lg border border-[#ded7c8] bg-white px-3 py-2 text-[#3f454c] hover:border-[#16824d]/50 hover:text-[#16824d]"
            href="/dashboard"
          >
            대시보드
          </Link>
          <Link
            className="rounded-lg border border-[#ded7c8] bg-white px-3 py-2 text-[#3f454c] hover:border-[#16824d]/50 hover:text-[#16824d]"
            href="/me"
          >
            계정 관리
          </Link>
        </div>
        <button
          type="button"
          className="w-full rounded-lg border border-[#d8c8bc] bg-white px-4 py-2 text-xs font-semibold text-[#7d2d2d] transition hover:border-[#b85454] hover:text-[#9e2f2f]"
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
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => void handleOAuth('discord')}
          className="flex items-center justify-center gap-2 rounded-lg bg-[#5865F2] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#4752c4] disabled:cursor-not-allowed disabled:opacity-50"
          disabled={loading || !oauthAvailability.discord}
        >
          <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-white/20">
            <svg className="h-4 w-4 text-white" viewBox="0 0 261 199" aria-hidden>
              <path
                d="M216.856339,16.5966031 C200.285002,8.84328665 182.566144,3.2084988 164.041564,0 C161.766523,4.11318106 159.108624,9.64549908 157.276099,14.0464379 C137.583995,11.0849896 118.072967,11.0849896 98.7430163,14.0464379 C96.9108417,9.64549908 94.1925838,4.11318106 91.8971895,0 C73.3526068,3.2084988 55.6133949,8.86399117 39.0420583,16.6376612 C5.61752293,67.146514 -3.4433191,116.400813 1.08711069,164.955721 C23.2560196,181.510915 44.7403634,191.567697 65.8621325,198.148576 C71.0772151,190.971126 75.7283628,183.341335 79.7352139,175.300261 C72.104019,172.400575 64.7949724,168.822202 57.8887866,164.667963 C59.7209612,163.310589 61.5131304,161.891452 63.2445898,160.431257 C105.36741,180.133187 151.134928,180.133187 192.754523,160.431257 C194.506336,161.891452 196.298154,163.310589 198.110326,164.667963 C191.183787,168.842556 183.854737,172.420929 176.223542,175.320965 C180.230393,183.341335 184.861538,190.991831 190.096624,198.16893 C211.238746,191.588051 232.743023,181.531619 254.911949,164.955721 C260.227747,108.668201 245.831087,59.8662432 216.856339,16.5966031 Z M85.4738752,135.09489 C72.8290281,135.09489 62.4592217,123.290155 62.4592217,108.914901 C62.4592217,94.5396472 72.607595,82.7145587 85.4738752,82.7145587 C98.3405064,82.7145587 108.709962,94.5189427 108.488529,108.914901 C108.508531,123.290155 98.3405064,135.09489 85.4738752,135.09489 Z M170.525237,135.09489 C157.88039,135.09489 147.510584,123.290155 147.510584,108.914901 C147.510584,94.5396472 157.658606,82.7145587 170.525237,82.7145587 C183.391518,82.7145587 193.761324,94.5189427 193.539891,108.914901 C193.539891,123.290155 183.391518,135.09489 170.525237,135.09489 Z"
                fill="currentColor"
                fillRule="nonzero"
              />
            </svg>
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
        <p className="rounded-lg border border-[#e7c56f] bg-[#fff8e1] px-3 py-2 text-xs text-[#765900]">
          일부 간편 로그인 옵션은 현재 비활성화되어 있습니다.
        </p>
      ) : null}
      {oauthError ? (
        <p className="rounded-lg border border-[#e7c56f] bg-[#fff8e1] px-3 py-2 text-xs text-[#765900]">
          {oauthError}
        </p>
      ) : null}

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-[#ded7c8]" />
        </div>
        <div className="relative flex justify-center text-xs">
          <span className="bg-white px-2 text-[#7a7f86]">이메일로 계속하기</span>
        </div>
      </div>

      {mode !== 'verify' ? (
        <>
          <div className="grid grid-cols-2 rounded-lg border border-[#ded7c8] bg-[#f4f0e6] p-1">
            <button
              type="button"
              className={`rounded-md py-2.5 text-sm font-semibold transition-colors ${
                mode === 'login'
                  ? 'bg-white text-[#1f2328] shadow-sm'
                  : 'text-[#666b72] hover:text-[#1f2328]'
              }`}
              onClick={() => {
                setMode('login');
                clearTransientMessages();
                setPendingVerification(null);
              }}
            >
              로그인
            </button>
            <button
              type="button"
              className={`rounded-md py-2.5 text-sm font-semibold transition-colors ${
                mode === 'register'
                  ? 'bg-white text-[#1f2328] shadow-sm'
                  : 'text-[#666b72] hover:text-[#1f2328]'
              }`}
              onClick={() => {
                setMode('register');
                clearTransientMessages();
                setPendingVerification(null);
              }}
            >
              회원가입
            </button>
          </div>

          <form className="space-y-5" onSubmit={handleSubmit}>
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-[#555b62]" htmlFor="email">
                이메일 주소
              </label>
              <input
                id="email"
                className="w-full rounded-lg border border-[#d8d0c0] bg-[#fcfaf5] px-4 py-3 text-sm text-[#1f2328] outline-none transition-all placeholder:text-[#9aa0a6] focus:border-[#16824d] focus:bg-white focus:ring-2 focus:ring-[#16824d]/15"
                type="email"
                placeholder="name@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>

            <div>
              <label
                className="mb-1.5 block text-xs font-semibold text-[#555b62]"
                htmlFor="password"
              >
                비밀번호
              </label>
              <div className="relative">
                <input
                  id="password"
                  className="w-full rounded-lg border border-[#d8d0c0] bg-[#fcfaf5] px-4 py-3 pr-12 text-sm text-[#1f2328] outline-none transition-all placeholder:text-[#9aa0a6] focus:border-[#16824d] focus:bg-white focus:ring-2 focus:ring-[#16824d]/15"
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
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#7a7f86] transition-colors hover:text-[#1f2328]"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  <span className="material-symbols-outlined text-xl">
                    {showPassword ? 'visibility_off' : 'visibility'}
                  </span>
                </button>
              </div>
            </div>

            {showPasswordHints && mode === 'register' ? (
              <div className="rounded-lg border border-[#ded7c8] bg-[#fcfaf5] p-3 text-xs text-[#666b72]">
                <p className="font-semibold text-[#1f2328]">비밀번호 조건</p>
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
                    className="mb-1.5 block text-xs font-semibold text-[#555b62]"
                    htmlFor="confirmPassword"
                  >
                    비밀번호 확인
                  </label>
                  <input
                    id="confirmPassword"
                    className="w-full rounded-lg border border-[#d8d0c0] bg-[#fcfaf5] px-4 py-3 text-sm text-[#1f2328] outline-none transition-all placeholder:text-[#9aa0a6] focus:border-[#16824d] focus:bg-white focus:ring-2 focus:ring-[#16824d]/15"
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    required
                    minLength={8}
                  />
                </div>
                {passwordsMatch !== null ? (
                  <p className={`text-xs ${passwordsMatch ? 'text-[#16824d]' : 'text-[#b42318]'}`}>
                    {passwordsMatch ? '비밀번호가 일치합니다.' : '비밀번호가 일치하지 않습니다.'}
                  </p>
                ) : null}

                <div>
                  <label
                    className="mb-1.5 block text-xs font-semibold text-[#555b62]"
                    htmlFor="displayName"
                  >
                    닉네임
                  </label>
                  <input
                    id="displayName"
                    className="w-full rounded-lg border border-[#d8d0c0] bg-[#fcfaf5] px-4 py-3 text-sm text-[#1f2328] outline-none transition-all placeholder:text-[#9aa0a6] focus:border-[#16824d] focus:bg-white focus:ring-2 focus:ring-[#16824d]/15"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="커뮤니티에 표시될 이름"
                    required
                  />
                </div>

                <label className="flex items-start gap-3 rounded-lg border border-[#ded7c8] bg-[#fcfaf5] px-4 py-3 text-xs leading-5 text-[#666b72]">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-[#b9b0a1] bg-white text-[#16824d] focus:ring-[#16824d]"
                    checked={agreementsAccepted}
                    onChange={(event) => setAgreementsAccepted(event.target.checked)}
                    required
                  />
                  <span>
                    <Link
                      className="text-[#16824d] underline"
                      href="/policies/terms"
                      target="_blank"
                    >
                      이용약관
                    </Link>{' '}
                    및{' '}
                    <Link
                      className="text-[#16824d] underline"
                      href="/policies/privacy"
                      target="_blank"
                    >
                      개인정보 처리방침
                    </Link>
                    에 동의합니다.
                  </span>
                </label>
              </>
            ) : (
              <div className="flex justify-end">
                <Link
                  className="text-xs font-semibold text-[#16824d] transition-colors hover:text-[#0f5f38]"
                  href="/login/forgot-password"
                >
                  비밀번호 찾기
                </Link>
              </div>
            )}

            {error ? (
              <p className="rounded-lg border border-[#f0b8ad] bg-[#fff4f2] px-3 py-2 text-sm text-[#b42318]">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p className="rounded-lg border border-[#a8d9bd] bg-[#effaf3] px-3 py-2 text-sm text-[#0f6a3d]">
                {notice}
              </p>
            ) : null}

            <button
              type="submit"
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-[#13ec80] px-6 py-3.5 text-sm font-bold text-[#0f1713] shadow-sm transition-all hover:bg-[#10cf70] disabled:opacity-50"
              disabled={loading}
            >
              {mode === 'login' ? '로그인하기' : '가입 후 인증 진행'}
            </button>
          </form>

          {mode === 'login' ? (
            <div className="mt-6 space-y-2 text-center">
              <p className="text-xs text-[#666b72]">
                계정에 문제가 있나요?{' '}
                <Link
                  className="font-semibold text-[#16824d] underline decoration-[#9bbda8] underline-offset-2 transition-colors hover:text-[#0f5f38]"
                  href="/login/resend-verification"
                >
                  인증 메일 재전송
                </Link>
              </p>
              <p className="text-xs text-[#666b72]">
                <Link
                  className="font-semibold text-[#16824d] transition-colors hover:text-[#0f5f38]"
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
          <div className="rounded-lg border border-[#ded7c8] bg-[#fcfaf5] p-4 text-sm text-[#1f2328]">
            <p className="font-semibold text-[#16824d]">이메일 인증 대기 중</p>
            <p className="mt-2 text-xs leading-5 text-[#666b72]">
              {pendingVerification
                ? `${pendingVerification.email} 주소로 인증 코드를 발송했습니다. 만료 시간 ${new Date(
                    pendingVerification.expiresAt,
                  ).toLocaleString('ko-KR')} 이전에 입력해주세요.`
                : '등록된 이메일 주소를 찾을 수 없습니다. 처음부터 다시 시도해 주세요.'}
            </p>
          </div>

          <div>
            <label
              className="mb-1.5 block text-xs font-semibold text-[#555b62]"
              htmlFor="verifyToken"
            >
              인증 코드
            </label>
            <input
              id="verifyToken"
              className="w-full rounded-lg border border-[#d8d0c0] bg-[#fcfaf5] px-4 py-3 text-sm text-[#1f2328] outline-none transition-all placeholder:text-[#9aa0a6] focus:border-[#16824d] focus:bg-white focus:ring-2 focus:ring-[#16824d]/15"
              value={verifyToken}
              onChange={(event) => setVerifyToken(event.target.value)}
              placeholder="이메일로 전송된 코드 입력"
              required
            />
          </div>

          {error ? (
            <p className="rounded-lg border border-[#f0b8ad] bg-[#fff4f2] px-3 py-2 text-sm text-[#b42318]">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="rounded-lg border border-[#a8d9bd] bg-[#effaf3] px-3 py-2 text-sm text-[#0f6a3d]">
              {notice}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="rounded-lg border border-[#ded7c8] bg-white px-4 py-2 text-xs font-semibold text-[#3f454c] transition hover:border-[#16824d]/50 hover:text-[#16824d] disabled:opacity-50"
              onClick={() => void handleResendVerification()}
              disabled={loading || !pendingVerification}
            >
              인증 코드 재발급
            </button>
            <button
              type="submit"
              className="rounded-lg bg-[#13ec80] px-4 py-2 text-xs font-semibold text-[#0f1713] transition hover:bg-[#10cf70] disabled:opacity-50"
              disabled={loading}
            >
              이메일 인증 완료
            </button>
          </div>

          <button
            type="button"
            className="text-xs font-semibold text-[#16824d] underline transition hover:text-[#0f5f38]"
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

function isSafeReturnPath(value: string | null): value is string {
  return Boolean(
    value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\'),
  );
}

function PasswordRequirement(props: { met: boolean; children: ReactNode }) {
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

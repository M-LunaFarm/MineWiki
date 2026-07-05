'use client';

import dynamic from 'next/dynamic';
import { useState, useEffect } from 'react';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import { X, Shield, ChevronRight, Vote } from 'lucide-react';

interface VoteResponse {
  acknowledged: boolean;
  nextEligibleAt: string;
}

interface VoteModalProps {
  readonly serverId: string;
  readonly apiBaseUrl?: string;
  readonly requiresOwnership?: boolean;
  readonly triggerClassName?: string;
  readonly triggerLabel?: string;
  readonly initialOpen?: boolean;
}

const Turnstile = dynamic(() => import('@marsidev/react-turnstile').then((mod) => mod.Turnstile), {
  ssr: false,
  loading: () => <div className="h-20 w-full rounded-xl skeleton animate-pulse" />,
});

const HCaptcha = dynamic(() => import('@hcaptcha/react-hcaptcha').then((mod) => mod.default), {
  ssr: false,
  loading: () => <div className="h-20 w-full rounded-xl skeleton animate-pulse" />,
});

function normalizeSiteKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith('your-') || lowered === 'undefined' || lowered === 'null') {
    return undefined;
  }
  return trimmed;
}

function normalizeMinecraftUsername(value: string): string {
  return value.trim();
}

function isValidMinecraftUsername(value: string): boolean {
  return /^[A-Za-z0-9_]{3,16}$/.test(value);
}

function formatKstDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

function mapVoteErrorMessage(message: string): string {
  if (message.includes('닉네임을 3~16자')) {
    return '닉네임은 영문/숫자/_ 조합으로 3~16자여야 합니다.';
  }
  if (message.includes('CAPTCHA 검증에 실패')) {
    return 'CAPTCHA 확인이 만료되었거나 누락되었습니다. 다시 확인해 주세요.';
  }
  if (message.includes('다음 투표 가능 시간:') || message.includes('다음 가능 시간:')) {
    const isoMatch = message.match(/\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?/);
    if (isoMatch?.[0]) {
      return message.replace(isoMatch[0], `${formatKstDateTime(isoMatch[0])} (KST)`);
    }
  }
  return message;
}

function isCaptchaFailureMessage(message: string): boolean {
  return message.includes('CAPTCHA 검증에 실패');
}

export function VoteModal({
  serverId,
  apiBaseUrl,
  requiresOwnership = false,
  triggerClassName,
  triggerLabel,
  initialOpen = false,
}: VoteModalProps) {
  const [isOpen, setIsOpen] = useState(initialOpen);
  const [username, setUsername] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<VoteResponse | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [agreePrivacy, setAgreePrivacy] = useState(false);

  const baseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const turnstileSiteKey = normalizeSiteKey(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
  const hcaptchaSiteKey = normalizeSiteKey(process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY);

  const captchaMode = turnstileSiteKey ? 'turnstile' : hcaptchaSiteKey ? 'hcaptcha' : 'none';
  const captchaRequired = captchaMode !== 'none';

  useEffect(() => {
    if (initialOpen) {
      setIsOpen(true);
    }
  }, [initialOpen]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    const normalizedUsername = normalizeMinecraftUsername(username);
    if (!isValidMinecraftUsername(normalizedUsername)) {
      setError('닉네임은 영문/숫자/_ 조합으로 3~16자여야 합니다.');
      return;
    }
    if (!agreeTerms || !agreePrivacy) {
      setError('이용약관과 개인정보 처리방침에 동의해 주세요.');
      return;
    }
    if (captchaRequired && !captchaToken) {
      setError('CAPTCHA 확인을 완료해 주세요.');
      return;
    }
    setIsSubmitting(true);

    try {
      const response = await fetch(`${baseUrl}/v1/servers/${serverId}/votes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          username: normalizedUsername,
          captchaToken,
          agreeTerms,
          agreePrivacy,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const message = body?.message ?? '투표 요청이 실패했습니다.';
        throw new Error(message);
      }

      const data = (await response.json()) as VoteResponse;
      setSuccess(data);
      setUsername('');
      setCaptchaToken(null);
      setCaptchaKey((value) => value + 1);
      setAgreeTerms(false);
      setAgreePrivacy(false);
    } catch (voteError) {
      if (voteError instanceof Error) {
        if (isCaptchaFailureMessage(voteError.message)) {
          setCaptchaToken(null);
          setCaptchaKey((value) => value + 1);
        }
        setError(mapVoteErrorMessage(voteError.message));
      } else {
        setError('알 수 없는 오류가 발생했습니다.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  return (
    <div>
      <button
        type="button"
        className={
          triggerClassName ??
          'group relative rounded-xl bg-[#f5f7fb] px-6 py-2.5 font-semibold text-[#111827] transition hover:bg-white active:scale-[0.99]'
        }
        onClick={() => {
          setIsOpen(true);
          setError(null);
          setSuccess(null);
          setCaptchaToken(null);
          setCaptchaKey((value) => value + 1);
          setAgreeTerms(false);
          setAgreePrivacy(false);
        }}
      >
        {triggerLabel ? (
          <span className="relative">{triggerLabel}</span>
        ) : (
          <span className="relative flex items-center gap-2">
            <Vote className="w-4 h-4" />
            <span>투표하기</span>
            <ChevronRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
          </span>
        )}
      </button>

      {isOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/80 backdrop-blur-md"
            onClick={() => !success && setIsOpen(false)}
          />

          {/* Modal */}
          <div className="relative w-full max-w-md animate-scale-in">
            <div className="rounded-xl border border-[#30343b] bg-[#151922] p-6 shadow-2xl shadow-black/40">
              <div className="relative">
                {/* Header */}
                <div className="flex items-start justify-between mb-6">
                  <div className="space-y-2">
                    <h3 className="text-2xl font-bold text-white flex items-center gap-2">
                      <div className="p-2 rounded-lg bg-blue-500/10 text-blue-100">
                        <Vote className="w-5 h-5" />
                      </div>
                      MineWiki
                    </h3>
                    <p className="text-sm text-[#9ca3af]">서버에 투표하고 보상을 받으세요</p>
                  </div>
                  <button
                    type="button"
                    className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                    onClick={() => !success && setIsOpen(false)}
                    disabled={success !== null}
                  >
                    <X className="w-5 h-5 text-[#9ca3af]" />
                  </button>
                </div>

                {requiresOwnership && !success && (
                  <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 animate-fade-up">
                    <div className="flex gap-3">
                      <Shield className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-amber-200">인증 필요</p>
                        <p className="text-xs text-amber-200/70">
                          이 서버는 인증된 유저만 투표할 수 있습니다. /me에서 계정 인증을 완료했는지
                          확인해주세요.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <form className="mt-4 space-y-4" onSubmit={handleSubmit}>
                  <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    마인크래프트 닉네임
                    <input
                      className="rounded-lg border border-[#30343b] bg-[#101216] px-3 py-2 text-sm text-slate-100"
                      type="text"
                      value={username}
                      onChange={(event) => setUsername(event.target.value.replace(/\s+/g, ''))}
                      required
                      minLength={3}
                      maxLength={16}
                      placeholder="닉네임을 입력하세요"
                    />
                    <span className="text-[10px] font-medium text-slate-500">
                      영문, 숫자, 밑줄(_)만 사용 가능 (3~16자)
                    </span>
                  </label>

                  {captchaMode === 'turnstile' ? (
                    <div className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                      로봇 방지 확인
                      <Turnstile
                        key={`turnstile-${captchaKey}`}
                        siteKey={turnstileSiteKey as string}
                        onSuccess={(token) => setCaptchaToken(token)}
                        onExpire={() => setCaptchaToken(null)}
                        options={{ theme: 'dark' }}
                      />
                    </div>
                  ) : captchaMode === 'hcaptcha' ? (
                    <div className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                      로봇 방지 확인
                      <HCaptcha
                        key={`hcaptcha-${captchaKey}`}
                        sitekey={hcaptchaSiteKey as string}
                        onVerify={(token) => setCaptchaToken(token)}
                        onExpire={() => setCaptchaToken(null)}
                        theme="dark"
                      />
                    </div>
                  ) : (
                    <p className="rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs text-blue-100">
                      CAPTCHA 구성이 감지되지 않았습니다. 투표가 실패하면 새로고침 후 다시 시도해
                      주세요.
                    </p>
                  )}

                  {error ? <p className="text-sm text-red-400">{error}</p> : null}
                  {success ? (
                    <p className="text-sm text-emerald-200">
                      투표가 접수되었습니다! 다음 투표 가능 시간:{' '}
                      {formatKstDateTime(success.nextEligibleAt)} (KST)
                    </p>
                  ) : null}

                  <div className="rounded-xl border border-[#30343b] bg-[#101216] px-4 py-3 text-xs text-slate-300">
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-[2px] h-4 w-4 rounded border border-slate-600 bg-slate-900"
                        checked={agreeTerms}
                        onChange={(event) => setAgreeTerms(event.target.checked)}
                      />
                      <span>
                        <a
                          className="text-blue-100 underline"
                          href="/policies/terms"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          이용약관
                        </a>
                        에 동의합니다.
                      </span>
                    </label>
                    <label className="mt-2 flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-[2px] h-4 w-4 rounded border border-slate-600 bg-slate-900"
                        checked={agreePrivacy}
                        onChange={(event) => setAgreePrivacy(event.target.checked)}
                      />
                      <span>
                        <a
                          className="text-blue-100 underline"
                          href="/policies/privacy"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          개인정보 처리방침
                        </a>
                        에 동의합니다.
                      </span>
                    </label>
                  </div>

                  <div className="flex items-center justify-end gap-3">
                    <button
                      type="button"
                      className="rounded-lg border border-[#30343b] px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-[#202632]"
                      onClick={() => setIsOpen(false)}
                    >
                      닫기
                    </button>
                    <button
                      type="submit"
                      className="rounded-lg bg-[#f5f7fb] px-4 py-2 text-sm font-semibold text-[#111827] hover:bg-white disabled:opacity-60"
                      disabled={
                        isSubmitting ||
                        (captchaRequired && !captchaToken) ||
                        !agreeTerms ||
                        !agreePrivacy
                      }
                    >
                      {isSubmitting ? '전송 중…' : '투표 전송'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

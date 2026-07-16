'use client';

import dynamic from 'next/dynamic';
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import { X, Shield, ChevronRight, Vote } from 'lucide-react';
import { csrfHeaders } from '../../lib/csrf';
import { useVoteMinecraftIdentity } from './use-vote-minecraft-identity';

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

  const baseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const turnstileSiteKey = normalizeSiteKey(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
  const hcaptchaSiteKey = normalizeSiteKey(process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY);

  const captchaMode = turnstileSiteKey ? 'turnstile' : hcaptchaSiteKey ? 'hcaptcha' : 'none';
  const captchaRequired = captchaMode !== 'none';
  const { identity, eligibility, status: identityStatus } = useVoteMinecraftIdentity(isOpen, serverId, apiBaseUrl);

  useEffect(() => {
    if (identity?.playerName) setUsername(identity.playerName);
  }, [identity]);

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
          ...(await csrfHeaders()),
        },
        credentials: 'include',
        body: JSON.stringify({
          username: normalizedUsername,
          captchaToken,
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

      {isOpen ? createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/80 backdrop-blur-md"
            onClick={() => !success && setIsOpen(false)}
          />

          {/* Modal */}
          <div className="relative w-full max-w-md animate-scale-in">
            <div className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain rounded-xl border border-[#30343b] bg-[#151922] p-6 shadow-2xl shadow-black/40">
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

                {identityStatus === 'guest' && !success ? (
                  <div className="mb-6 rounded-xl border border-blue-400/25 bg-blue-400/10 p-4">
                    <p className="text-sm font-medium text-blue-100">로그인 필요</p>
                    <p className="mt-1 text-xs leading-5 text-blue-100/70">투표 기록과 보상을 한 계정에 안전하게 연결하려면 먼저 로그인해 주세요.</p>
                    <a className="mt-2 inline-flex text-xs font-semibold text-blue-100 underline underline-offset-4" href="/login">로그인하고 투표하기</a>
                  </div>
                ) : null}

                {identityStatus === 'error' && !success ? (
                  <div className="mb-6 rounded-xl border border-red-400/25 bg-red-400/10 p-4">
                    <p className="text-sm font-medium text-red-100">투표 상태를 확인하지 못했어요</p>
                    <p className="mt-1 text-xs leading-5 text-red-100/70">창을 닫았다가 다시 열어 주세요. 상태가 확인되기 전에는 중복 투표 방지를 위해 전송하지 않습니다.</p>
                  </div>
                ) : null}

                {eligibility?.reason === 'cooldown' && !success ? (
                  <div className="mb-6 rounded-xl border border-emerald-400/25 bg-emerald-400/10 p-4">
                    <p className="text-sm font-medium text-emerald-100">오늘 이 서버에 투표했어요</p>
                    <p className="mt-1 text-xs leading-5 text-emerald-100/70">
                      {eligibility.nextEligibleAt
                        ? `${formatKstDateTime(eligibility.nextEligibleAt)} (KST)부터 다시 투표할 수 있습니다.`
                        : '다음 날 자정부터 다시 투표할 수 있습니다.'}
                    </p>
                  </div>
                ) : null}

                {identityStatus === 'conflict' && !success ? (
                  <div className="mb-6 rounded-xl border border-red-400/25 bg-red-400/10 p-4">
                    <p className="text-sm font-medium text-red-100">계정 인증 확인 필요</p>
                    <p className="mt-1 text-xs leading-5 text-red-100/70">연결된 계정에 서로 다른 Minecraft 인증이 있습니다. support@minewiki.kr로 병합을 요청해 주세요.</p>
                  </div>
                ) : null}

                {requiresOwnership && identityStatus !== 'guest' && !success && (
                  <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 animate-fade-up">
                    <div className="flex gap-3">
                      <Shield className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-amber-200">
                          {identityStatus === 'verified' ? '인증된 플레이어' : '인증 필요'}
                        </p>
                        <p className="text-xs text-amber-200/70">
                          {identityStatus === 'verified'
                            ? `${identity?.playerName} 계정으로 안전하게 투표합니다.`
                            : '이 서버는 로그인 후 Microsoft로 Minecraft 소유권을 인증한 사용자만 투표할 수 있습니다.'}
                        </p>
                        {identityStatus !== 'verified' && identityStatus !== 'loading' ? (
                          <a className="mt-2 inline-flex text-xs font-semibold text-amber-100 underline underline-offset-4" href="/me">
                            계정 및 보안에서 인증하기
                          </a>
                        ) : null}
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
                      readOnly={identityStatus === 'verified'}
                      aria-describedby={identityStatus === 'verified' ? `vote-identity-${serverId}` : undefined}
                    />
                    <span id={`vote-identity-${serverId}`} className="text-[10px] font-medium text-slate-500">
                      {identityStatus === 'verified'
                        ? 'Microsoft에서 확인된 닉네임이며 변경할 수 없습니다.'
                        : '영문, 숫자, 밑줄(_)만 사용 가능 (3~16자)'}
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

                  <p className="text-xs leading-5 text-slate-400">
                    투표에는 <a className="text-blue-100 underline underline-offset-2" href="/policies/voting" target="_blank" rel="noopener noreferrer">투표 무결성 정책</a>이 적용됩니다.
                  </p>

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
                        (requiresOwnership && identityStatus !== 'verified')
                        || ['idle', 'loading', 'guest', 'error', 'conflict'].includes(identityStatus)
                        || eligibility?.eligible === false
                      }
                    >
                      {isSubmitting ? '전송 중…' : '투표 전송'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

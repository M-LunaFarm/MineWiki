'use client';

import dynamic from 'next/dynamic';
import { useState, useEffect } from 'react';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import { motion, AnimatePresence } from 'framer-motion';
import { csrfHeaders } from '../../lib/csrf';
import {
  CheckCircle2,
  AlertCircle,
  X,
  User,
  Shield,
  Clock,
  ChevronRight,
  Vote,
} from 'lucide-react';

interface VoteModalProps {
  readonly serverId: string;
  readonly apiBaseUrl?: string;
  readonly requiresOwnership?: boolean;
}

interface VoteResponse {
  acknowledged: boolean;
  nextEligibleAt: string;
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

export function VoteModalModern({
  serverId,
  apiBaseUrl,
  requiresOwnership = false,
}: VoteModalProps) {
  const [isOpen, setIsOpen] = useState(false);
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
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

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
          ...(await csrfHeaders()),
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

      // Auto close after success
      setTimeout(() => {
        setIsOpen(false);
        // Reset form after modal closes
        setTimeout(() => {
          setUsername('');
          setCaptchaToken(null);
          setCaptchaKey((value) => value + 1);
          setAgreeTerms(false);
          setAgreePrivacy(false);
          setSuccess(null);
        }, 300);
      }, 3000);
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

  return (
    <>
      <motion.button
        type="button"
        className="group relative rounded-xl bg-[#f5f7fb] px-8 py-3 font-semibold text-[#111827] transition hover:bg-white active:scale-[0.99]"
        onClick={() => {
          setIsOpen(true);
          setError(null);
          setSuccess(null);
          setCaptchaToken(null);
          setCaptchaKey((value) => value + 1);
          setAgreeTerms(false);
          setAgreePrivacy(false);
        }}
        whileHover={{ y: -2 }}
        whileTap={{ scale: 0.98 }}
      >
        <div className="relative flex items-center gap-2">
          <Vote className="w-4 h-4" />
          <span>투표하기</span>
          <ChevronRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
        </div>
      </motion.button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
          >
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/80 backdrop-blur-md"
              onClick={() => !success && setIsOpen(false)}
            />

            {/* Modal */}
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              transition={{ type: 'spring', damping: 20, stiffness: 300 }}
              className="relative w-full max-w-md"
            >
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
                      <p className="text-sm text-muted-foreground">
                        서버에 투표하고 보상을 받으세요
                      </p>
                    </div>
                    <button
                      type="button"
                      className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                      onClick={() => !success && setIsOpen(false)}
                      disabled={success !== null}
                    >
                      <X className="w-5 h-5 text-muted-foreground" />
                    </button>
                  </div>

                  {success ? (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="py-12 text-center space-y-4"
                    >
                      <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ delay: 0.2, type: 'spring' }}
                        className="inline-flex p-4 rounded-full bg-green-500/20"
                      >
                        <CheckCircle2 className="w-12 h-12 text-green-400" />
                      </motion.div>
                      <h4 className="text-xl font-semibold text-white">투표 완료!</h4>
                      <p className="text-sm text-muted-foreground">다음 투표 가능 시간:</p>
                      <p className="text-sm font-medium text-brand-200">
                        {formatKstDateTime(success.nextEligibleAt)} (KST)
                      </p>
                    </motion.div>
                  ) : (
                    <form onSubmit={handleSubmit} className="space-y-6">
                      {/* Ownership warning */}
                      {requiresOwnership && (
                        <motion.div
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20"
                        >
                          <div className="flex gap-3">
                            <Shield className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                            <div className="space-y-1">
                              <p className="text-sm font-medium text-amber-200">인증 필요</p>
                              <p className="text-xs text-amber-200/70">
                                이 서버는 인증된 유저만 투표할 수 있습니다.
                              </p>
                            </div>
                          </div>
                        </motion.div>
                      )}

                      {/* Username input */}
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                          <User className="w-4 h-4" />
                          마인크래프트 닉네임
                        </label>
                        <input
                          type="text"
                          value={username}
                          onChange={(e) => setUsername(e.target.value.replace(/\s+/g, ''))}
                          required
                          minLength={3}
                          maxLength={16}
                          placeholder="닉네임을 입력하세요"
                          className="w-full rounded-lg border border-[#30343b] bg-[#101216] px-4 py-3 text-white placeholder:text-[#9ca3af] transition focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400/20"
                        />
                        <p className="text-[11px] text-muted-foreground">
                          영문, 숫자, 밑줄(_)만 사용 가능 (3~16자)
                        </p>
                      </div>

                      {/* CAPTCHA */}
                      {captchaMode === 'turnstile' ? (
                        <div className="space-y-2">
                          <label className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                            <Shield className="w-4 h-4" />
                            로봇 방지 확인
                          </label>
                          <Turnstile
                            key={`turnstile-${captchaKey}`}
                            siteKey={turnstileSiteKey as string}
                            onSuccess={(token) => setCaptchaToken(token)}
                            onExpire={() => setCaptchaToken(null)}
                            options={{ theme: 'dark' }}
                          />
                        </div>
                      ) : captchaMode === 'hcaptcha' ? (
                        <div className="space-y-2">
                          <label className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                            <Shield className="w-4 h-4" />
                            로봇 방지 확인
                          </label>
                          <HCaptcha
                            key={`hcaptcha-${captchaKey}`}
                            sitekey={hcaptchaSiteKey as string}
                            onVerify={(token) => setCaptchaToken(token)}
                            onExpire={() => setCaptchaToken(null)}
                            theme="dark"
                          />
                        </div>
                      ) : (
                        <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20">
                          <p className="text-xs text-blue-300 flex items-start gap-2">
                            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                            <span>CAPTCHA 구성이 감지되지 않았습니다. 투표 실패 시 새로고침 후 다시 시도해 주세요.</span>
                          </p>
                        </div>
                      )}

                      {/* Terms */}
                      <div className="space-y-3 rounded-xl border border-[#30343b] bg-[#101216] p-4">
                        <label className="flex items-start gap-3 cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={agreeTerms}
                            onChange={(e) => setAgreeTerms(e.target.checked)}
                            className="mt-1 w-4 h-4 rounded border-white/20 bg-white/5 text-brand-500 focus:ring-brand-500 focus:ring-offset-0"
                          />
                          <span className="text-sm text-muted-foreground">
                            <a
                              href="/policies/terms"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-100 underline decoration-dotted underline-offset-2 hover:text-blue-50"
                            >
                              이용약관
                            </a>
                            에 동의합니다
                          </span>
                        </label>
                        <label className="flex items-start gap-3 cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={agreePrivacy}
                            onChange={(e) => setAgreePrivacy(e.target.checked)}
                            className="mt-1 w-4 h-4 rounded border-white/20 bg-white/5 text-brand-500 focus:ring-brand-500 focus:ring-offset-0"
                          />
                          <span className="text-sm text-muted-foreground">
                            <a
                              href="/policies/privacy"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-100 underline decoration-dotted underline-offset-2 hover:text-blue-50"
                            >
                              개인정보 처리방침
                            </a>
                            에 동의합니다
                          </span>
                        </label>
                      </div>

                      {/* Error message */}
                      {error && (
                        <motion.div
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="p-3 rounded-xl bg-red-500/10 border border-red-500/20"
                        >
                          <p className="text-sm text-red-300 flex items-start gap-2">
                            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                            {error}
                          </p>
                        </motion.div>
                      )}

                      {/* Submit button */}
                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={() => setIsOpen(false)}
                          className="flex-1 rounded-lg border border-[#30343b] px-4 py-3 font-medium text-white transition-colors hover:bg-[#202632]"
                        >
                          취소
                        </button>
                        <button
                          type="submit"
                          disabled={
                            isSubmitting ||
                            (captchaRequired && !captchaToken) ||
                            !agreeTerms ||
                            !agreePrivacy
                          }
                          className="flex-1 rounded-lg bg-[#f5f7fb] px-4 py-3 font-medium text-[#111827] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isSubmitting ? (
                            <span className="flex items-center justify-center gap-2">
                              <motion.div
                                animate={{ rotate: 360 }}
                                transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                              >
                                <Clock className="w-4 h-4" />
                              </motion.div>
                              전송 중...
                            </span>
                          ) : (
                            '투표하기'
                          )}
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Vote info */}
                  {!success && (
                    <div className="mt-6 pt-6 border-t border-white/10">
                      <p className="text-xs text-center text-muted-foreground">
                        투표는 매일 자정(KST)에 초기화됩니다
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

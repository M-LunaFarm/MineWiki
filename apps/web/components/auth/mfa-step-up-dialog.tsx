'use client';

import { KeyRound, Loader2, ShieldAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  fetchMfaStatus,
  performMfaStepUp,
  type MfaStepUpPurpose,
} from '../../lib/auth-client';

const PURPOSE_LABELS: Record<MfaStepUpPurpose, string> = {
  wiki_admin: '위키 관리',
  role_admin: '역할 관리',
  server_admin: '서버 관리',
  review_moderation: '리뷰 조정',
  vote_admin: '투표 관리',
  guild_admin: '그룹 관리',
  file_admin: '파일 관리',
  audit_read: '감사 기록 조회',
  account_delete_admin: '계정 종료 관리',
  mfa_manage: '다중 인증 설정',
};

export function MfaStepUpDialog({
  open,
  purpose,
  onClose,
  onSuccess,
}: {
  readonly open: boolean;
  readonly purpose: MfaStepUpPurpose;
  readonly onClose: () => void;
  readonly onSuccess: (expiresAt: string) => void | Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [method, setMethod] = useState<'totp' | 'recovery_code'>('totp');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCode('');
    setError(null);
    setChecking(true);
    void fetchMfaStatus()
      .then((status) => setEnrolled(status.totpEnabled))
      .catch((loadError) => {
        setEnrolled(null);
        setError(loadError instanceof Error ? loadError.message : '다중 인증 상태를 확인하지 못했습니다.');
      })
      .finally(() => setChecking(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.clearTimeout(timer);
    };
  }, [onClose, open, submitting]);

  if (!open) return null;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await performMfaStepUp({ method, purpose, code: code.trim() });
      await onSuccess(result.expiresAt);
      setCode('');
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '다중 인증을 확인하지 못했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="mfa-step-up-title"
        className="w-full rounded-t-2xl border border-white/10 bg-[#181a1d] p-5 shadow-2xl sm:max-w-md sm:rounded-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-[#13ec80]/30 bg-[#13ec80]/10 px-2.5 py-1 text-[11px] font-semibold text-[#71f5b1]">
              <ShieldAlert className="h-3.5 w-3.5" /> 추가 보안 확인
            </p>
            <h2 id="mfa-step-up-title" className="text-lg font-bold text-white">
              {PURPOSE_LABELS[purpose]} 계속하기
            </h2>
            <p className="mt-1 text-sm leading-6 text-[#9aa5b1]">
              인증 앱 또는 일회용 복구 코드로 확인하면 해당 목적에만 5분 동안 사용할 수 있습니다.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md p-1.5 text-[#8f98a3] transition hover:bg-white/5 hover:text-white disabled:opacity-50"
            aria-label="다중 인증 창 닫기"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {checking ? (
          <div className="mt-5 flex items-center gap-2 rounded-lg border border-white/10 bg-black/15 px-3 py-3 text-sm text-[#aab3bd]">
            <Loader2 className="h-4 w-4 animate-spin" /> 등록 상태 확인 중
          </div>
        ) : enrolled === false ? (
          <div className="mt-5 rounded-lg border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">
            먼저 계정 설정에서 다중 인증을 등록해야 합니다.
            <a href="/me" className="mt-3 block font-semibold text-[#71f5b1] hover:underline">
              계정 보안 설정으로 이동
            </a>
          </div>
        ) : (
          <form className="mt-5 space-y-4" onSubmit={submit}>
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-[#111315] p-1">
              <button
                type="button"
                onClick={() => { setMethod('totp'); setCode(''); setError(null); }}
                className={`rounded-md px-3 py-2 text-xs font-semibold transition ${method === 'totp' ? 'bg-[#26312d] text-[#71f5b1]' : 'text-[#8f98a3] hover:text-white'}`}
              >
                인증 앱
              </button>
              <button
                type="button"
                onClick={() => { setMethod('recovery_code'); setCode(''); setError(null); }}
                className={`rounded-md px-3 py-2 text-xs font-semibold transition ${method === 'recovery_code' ? 'bg-[#26312d] text-[#71f5b1]' : 'text-[#8f98a3] hover:text-white'}`}
              >
                복구 코드
              </button>
            </div>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-[#aab3bd]">
                {method === 'totp' ? '6자리 인증 코드' : '16자리 일회용 복구 코드'}
              </span>
              <input
                ref={inputRef}
                value={code}
                onChange={(event) => { setCode(event.target.value); setError(null); }}
                inputMode={method === 'totp' ? 'numeric' : 'text'}
                autoComplete="one-time-code"
                placeholder={method === 'totp' ? '000000' : 'XXXX-XXXX-XXXX-XXXX'}
                minLength={6}
                maxLength={64}
                required
                disabled={submitting}
                className="w-full rounded-lg border border-[#3a424a] bg-[#101214] px-3 py-3 font-mono text-base tracking-wider text-white outline-none transition focus:border-[#13ec80]"
              />
            </label>
            {error ? <p role="alert" className="text-sm text-red-300">{error}</p> : null}
            <button
              type="submit"
              disabled={submitting || code.trim().length < 6}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#13ec80] px-4 py-3 text-sm font-bold text-[#07130d] transition hover:bg-[#35f29a] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              {submitting ? '확인 중입니다.' : '확인하고 계속'}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

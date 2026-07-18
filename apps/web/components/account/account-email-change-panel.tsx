'use client';

import { Loader2, MailCheck, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  fetchAccountEmailChangeState,
  requestAccountEmailChange,
  resendAccountEmailChange,
  type AccountEmailChangeState,
} from '../../lib/auth-client';

export function AccountEmailChangePanel() {
  const [state, setState] = useState<AccountEmailChangeState | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<'request' | 'resend' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [feedback, setFeedback] = useState<{ readonly type: 'success' | 'error'; readonly text: string } | null>(null);

  const refresh = useCallback(async () => {
    const next = await fetchAccountEmailChangeState();
    setState(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchAccountEmailChangeState()
      .then((next) => { if (!cancelled) setState(next); })
      .catch((error) => { if (!cancelled) setFeedback({ type: 'error', text: problemText(error) }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  async function requestChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working) return;
    setWorking('request');
    setFeedback(null);
    try {
      await requestAccountEmailChange({ email: email.trim(), password: state?.hasPassword ? password : undefined });
      await refresh();
      setEmail('');
      setPassword('');
      setFeedback({ type: 'success', text: '새 이메일로 24시간 동안 유효한 확인 링크를 보냈습니다.' });
    } catch (error) {
      setFeedback({ type: 'error', text: problemText(error) });
    } finally {
      setWorking(null);
    }
  }

  async function resend() {
    if (working || !state?.pending || Date.parse(state.pending.nextResendAt) > now) return;
    setWorking('resend');
    setFeedback(null);
    try {
      await resendAccountEmailChange();
      await refresh();
      setFeedback({ type: 'success', text: '확인 메일을 다시 보냈습니다. 기존 링크는 사용할 수 없습니다.' });
    } catch (error) {
      setFeedback({ type: 'error', text: problemText(error) });
    } finally {
      setWorking(null);
    }
  }

  const resendSeconds = state?.pending
    ? Math.max(0, Math.ceil((Date.parse(state.pending.nextResendAt) - now) / 1_000))
    : 0;

  return (
    <section className="mb-6 rounded-lg border border-[#30363d] bg-[#181a1d] p-5 shadow-sm sm:p-6" aria-labelledby="contact-email-title">
      <div className="flex items-start gap-3">
        <span className="rounded-lg border border-[#13ec80]/25 bg-[#13ec80]/10 p-2 text-[#13ec80]"><MailCheck className="size-5" aria-hidden /></span>
        <div className="min-w-0"><h2 id="contact-email-title" className="text-lg font-bold text-white">검증된 연락 이메일 변경</h2><p className="mt-1 text-sm leading-6 text-[#a0a0a0]">로그인·복구에 쓰이는 이메일을 새 주소 확인 후 변경합니다. 완료되면 모든 기기에서 로그아웃됩니다.</p></div>
      </div>
      {loading ? <p className="mt-5 flex items-center gap-2 text-sm text-[#a0a0a0]" role="status"><Loader2 className="size-4 animate-spin" />이메일 상태를 확인하는 중입니다.</p> : null}
      {!loading && state ? <>
        <div className="mt-5 rounded-lg border border-white/10 bg-black/15 p-4"><p className="text-xs font-semibold text-[#8f98a3]">현재 검증 이메일</p><p className="mt-1 break-all text-sm font-bold text-white">{state.currentEmail ?? '설정되지 않음'}</p></div>
        {state.currentEmail ? <form onSubmit={requestChange} className="mt-5 grid gap-4 lg:grid-cols-2">
          <label className="block text-xs font-semibold text-[#a0a0a0]">새 이메일
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required disabled={working !== null} autoComplete="email" className="mt-1.5 min-h-11 w-full rounded-md border border-[#30363d] bg-[#111315] px-3 text-sm text-white outline-none focus:border-[#13ec80] disabled:opacity-50" />
          </label>
          {state.hasPassword ? <label className="block text-xs font-semibold text-[#a0a0a0]">현재 비밀번호
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={working !== null} autoComplete="current-password" className="mt-1.5 min-h-11 w-full rounded-md border border-[#30363d] bg-[#111315] px-3 text-sm text-white outline-none focus:border-[#13ec80] disabled:opacity-50" />
          </label> : <p className="rounded-md border border-sky-300/20 bg-sky-300/10 px-3 py-2 text-xs leading-5 text-sky-100">OAuth 전용 계정은 다시 로그인한 뒤 15분 안에 요청할 수 있습니다.</p>}
          <button type="submit" disabled={working !== null || !email.trim() || (state.hasPassword && !password)} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-[#13ec80] px-4 text-sm font-bold text-[#07120f] disabled:opacity-40 sm:w-fit lg:col-span-2">{working === 'request' ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}새 이메일 확인 요청</button>
        </form> : <p className="mt-4 text-sm text-amber-200">먼저 위의 이메일 로그인 설정에서 검증 이메일을 등록해 주세요.</p>}
        {state.pending ? <div className="mt-5 rounded-lg border border-amber-300/20 bg-amber-300/[0.06] p-4">
          <p className="text-sm font-semibold text-amber-100">확인 대기: {state.pending.emailMasked}</p>
          <p className="mt-1 text-xs leading-5 text-[#a0a0a0]">만료: {formatDate(state.pending.expiresAt)} · 확인 전까지 현재 이메일은 바뀌지 않습니다.</p>
          <button type="button" onClick={() => void resend()} disabled={working !== null || resendSeconds > 0} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-md border border-amber-200/30 px-3 text-sm font-semibold text-amber-100 disabled:opacity-40">{working === 'resend' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}{resendSeconds > 0 ? `${resendSeconds}초 후 재전송` : '확인 메일 재전송'}</button>
        </div> : null}
      </> : null}
      {feedback ? <p role="alert" className={`mt-4 text-sm leading-6 ${feedback.type === 'success' ? 'text-emerald-300' : 'text-red-300'}`}>{feedback.text}</p> : null}
    </section>
  );
}

function problemText(error: unknown): string {
  return error instanceof Error ? error.message : '이메일 변경 요청을 처리하지 못했습니다.';
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

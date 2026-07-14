'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { cancelAccountDeletion } from '../../../lib/auth-client';
import {
  CallbackCard,
  CallbackShell,
  CallbackSideStat,
} from '../../../components/auth/callback-shell';

type CancelState = 'ready' | 'submitting' | 'success' | 'error' | 'missing';

export function AccountDeletionCancelClient() {
  const [token, setToken] = useState('');
  const [state, setState] = useState<CancelState>('ready');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/u, ''));
    const fragmentToken = fragment.get('token')?.trim() ?? '';
    setToken(fragmentToken);
    setState(fragmentToken ? 'ready' : 'missing');
    window.history.replaceState(window.history.state, '', '/account-deletion/cancel');
  }, []);

  async function cancel() {
    if (!token || state === 'submitting' || state === 'success') return;
    setState('submitting');
    setMessage(null);
    try {
      await cancelAccountDeletion(token);
      setState('success');
    } catch (problem) {
      setState('error');
      setMessage(problem instanceof Error ? problem.message : '계정 종료 요청을 취소하지 못했습니다.');
    }
  }

  const status = state === 'success' ? 'success' : state === 'error' || state === 'missing' ? 'error' : 'warning';
  return (
    <CallbackShell
      eyebrow="계정 보호"
      title={state === 'success' ? '계정 종료 요청을 취소했습니다.' : '계정 종료 요청을 취소하시겠습니까?'}
      subtitle="이 화면은 링크를 여는 것만으로 처리하지 않습니다. 아래 버튼을 직접 눌러야 계정이 다시 활성 상태로 전환됩니다."
      status={status}
      aside={
        <>
          <CallbackSideStat label="유예기간" value="14일" />
          <CallbackSideStat label="처리 방식" value="명시적 취소" />
          <CallbackSideStat label="보호" value="일회성 링크" />
        </>
      }
    >
      <CallbackCard status={status} progressWidth={state === 'success' ? '100%' : '72%'} footerLabel="MineWiki Account Safety">
        {state === 'success' ? (
          <div className="text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-[#13ec80]" />
            <p className="mt-4 text-lg font-semibold text-white">계정 종료 예약이 해제되었습니다.</p>
            <p className="mt-2 text-sm leading-6 text-[#a9b0ba]">
              보안을 위해 기존 세션과 연동 토큰은 복구하지 않습니다. 다시 로그인해 새 세션을 만들어 주세요.
            </p>
            <Link href="/login?returnTo=/me" className="mt-6 inline-flex rounded-md bg-[#13ec80] px-5 py-2.5 text-sm font-bold text-[#07110e]">
              다시 로그인
            </Link>
          </div>
        ) : (
          <div>
            <div className="flex items-start gap-3 rounded-md border border-amber-300/25 bg-amber-300/10 p-4 text-sm leading-6 text-amber-100">
              {state === 'missing' ? <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" /> : <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />}
              <p>{state === 'missing' ? '취소 토큰이 없습니다. 신청 직후 제공된 링크 또는 안내 이메일의 원본 링크를 다시 열어 주세요.' : '취소하면 계정 비식별화 예약이 해제됩니다. 이미 폐기된 로그인 세션과 인증 토큰은 새로 발급받아야 합니다.'}</p>
            </div>
            {message ? <p role="alert" className="mt-4 rounded-md border border-rose-400/25 bg-rose-400/10 p-3 text-sm text-rose-200">{message}</p> : null}
            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button type="button" onClick={() => void cancel()} disabled={!token || state === 'submitting'} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-[#13ec80] px-5 py-2.5 text-sm font-bold text-[#07110e] disabled:cursor-not-allowed disabled:opacity-40">
                {state === 'submitting' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {state === 'submitting' ? '취소 처리 중' : '계정 종료 요청 취소'}
              </button>
              <Link href="/" className="inline-flex min-h-11 items-center justify-center rounded-md border border-[#30363d] px-5 py-2.5 text-sm font-semibold text-white">홈으로 돌아가기</Link>
            </div>
          </div>
        )}
      </CallbackCard>
    </CallbackShell>
  );
}

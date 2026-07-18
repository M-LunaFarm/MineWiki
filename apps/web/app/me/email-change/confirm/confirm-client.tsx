'use client';

import { CheckCircle2, Loader2, MailCheck, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { confirmAccountEmailChange } from '../../../../lib/auth-client';

export function EmailChangeConfirmClient({ token }: { readonly token: string }) {
  const [working, setWorking] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!token || working) return;
    setWorking(true);
    setError(null);
    try {
      await confirmAccountEmailChange(token);
      setSuccess(true);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '확인 링크를 처리하지 못했습니다.');
    } finally {
      setWorking(false);
    }
  }

  return <main className="mx-auto flex min-h-[70vh] max-w-xl items-center px-4 py-12">
    <section className="surface-card w-full p-6 text-center sm:p-8">
      {success ? <><CheckCircle2 className="mx-auto size-12 text-emerald-300" /><h1 className="mt-4 text-2xl font-extrabold text-white">이메일을 변경했습니다</h1><p className="mt-3 text-sm leading-6 text-slate-300">보안을 위해 모든 기기의 세션을 종료했습니다. 새 이메일로 다시 로그인해 주세요.</p><Link href="/login?returnTo=%2Fme" className="btn-primary mt-6 min-h-11">새 이메일로 로그인</Link></> : <><MailCheck className="mx-auto size-12 text-emerald-300" /><h1 className="mt-4 text-2xl font-extrabold text-white">새 이메일 확인</h1><p className="mt-3 text-sm leading-6 text-slate-300">버튼을 누르면 연락 이메일과 이메일 로그인 주소가 변경되고 모든 기기에서 로그아웃됩니다.</p>{!token ? <p role="alert" className="mt-4 flex items-center justify-center gap-2 text-sm text-red-300"><ShieldAlert className="size-4" />확인 토큰이 없습니다.</p> : null}{error ? <p role="alert" className="mt-4 text-sm text-red-300">{error}</p> : null}<button type="button" onClick={() => void confirm()} disabled={!token || working} className="btn-primary mt-6 min-h-11 gap-2 disabled:opacity-40">{working ? <Loader2 className="size-4 animate-spin" /> : <MailCheck className="size-4" />}이메일 변경 확인</button></>}
    </section>
  </main>;
}

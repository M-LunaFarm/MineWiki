'use client';

import { AtSign, Loader2, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import {
  changeWikiUsername,
  fetchWikiUsernameState,
  type WikiUsernameState,
} from '../../lib/wiki-api';

export function WikiUsernamePanel({ hasPassword }: { readonly hasPassword: boolean }) {
  const [state, setState] = useState<WikiUsernameState | null>(null);
  const [username, setUsername] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly type: 'success' | 'error'; readonly text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchWikiUsernameState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((error) => {
        if (!cancelled) setFeedback({ type: 'error', text: error instanceof Error ? error.message : 'Wiki 아이디를 불러오지 못했습니다.' });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state || working || confirmation !== state.username) return;
    setWorking(true);
    setFeedback(null);
    try {
      const result = await changeWikiUsername({
        username: username.trim(),
        confirmation,
        password: hasPassword ? password : undefined,
      });
      setState(result);
      setUsername('');
      setConfirmation('');
      setPassword('');
      setFeedback({
        type: 'success',
        text: `Wiki 아이디를 ${result.username}(으)로 변경하고 사용자 문서 ${result.movedDocumentCount}개를 안전하게 이동했습니다.`,
      });
    } catch (error) {
      setFeedback({ type: 'error', text: error instanceof Error ? error.message : 'Wiki 아이디를 변경하지 못했습니다.' });
    } finally {
      setWorking(false);
    }
  }

  const nextChange = state?.nextChangeAt ? formatDate(state.nextChangeAt) : null;
  return (
    <section className="mb-6 rounded-lg border border-[#30363d] bg-[#181a1d] p-5 shadow-sm sm:p-6" aria-labelledby="wiki-username-title">
      <div className="flex items-start gap-3">
        <span className="rounded-lg border border-[#13ec80]/25 bg-[#13ec80]/10 p-2 text-[#13ec80]"><AtSign className="size-5" aria-hidden /></span>
        <div className="min-w-0">
          <h2 id="wiki-username-title" className="text-lg font-bold text-white">Wiki 아이디</h2>
          <p className="mt-1 text-sm leading-6 text-[#a0a0a0]">공개 프로필과 사용자 문서 주소에 쓰입니다. 변경하면 소유한 사용자 문서 트리도 한 번에 이동하며, 이전 아이디는 새 프로필을 안내합니다.</p>
        </div>
      </div>

      {loading ? <p className="mt-5 flex items-center gap-2 text-sm text-[#a0a0a0]" role="status"><Loader2 className="size-4 animate-spin" />Wiki 아이디를 확인하는 중입니다.</p> : null}
      {!loading && state ? <>
        <div className="mt-5 flex flex-col gap-3 rounded-lg border border-white/10 bg-black/15 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0"><p className="text-xs font-semibold text-[#8f98a3]">현재 아이디</p><p className="mt-1 break-all font-mono text-sm font-bold text-white">@{state.username}</p></div>
          <Link href={`/user/${encodeURIComponent(state.username)}`} className="inline-flex min-h-11 items-center justify-center rounded-md border border-white/15 px-3 text-sm font-semibold text-white hover:border-[#13ec80]/50">공개 프로필 보기</Link>
        </div>
        <p className="mt-3 text-xs leading-5 text-[#8f98a3]">소유 문서 {state.documentCount}개 · 변경 후 {state.cooldownDays}일 동안 다시 변경할 수 없습니다.{!state.canChange && nextChange ? ` 다음 변경 가능: ${nextChange}` : ''}</p>

        <form onSubmit={submit} className="mt-5 grid gap-4 lg:grid-cols-2">
          <label className="block text-xs font-semibold text-[#a0a0a0]">새 Wiki 아이디
            <input value={username} onChange={(event) => setUsername(event.target.value)} minLength={2} maxLength={32} pattern="[A-Za-z0-9가-힣_-]+" required disabled={!state.canChange || working} placeholder="한글, 영문, 숫자, _, -" className="mt-1.5 min-h-11 w-full rounded-md border border-[#30363d] bg-[#111315] px-3 text-sm text-white outline-none focus:border-[#13ec80] disabled:opacity-50" />
          </label>
          <label className="block text-xs font-semibold text-[#a0a0a0]">현재 아이디 확인
            <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required disabled={!state.canChange || working} placeholder={state.username} className="mt-1.5 min-h-11 w-full rounded-md border border-[#30363d] bg-[#111315] px-3 text-sm text-white outline-none focus:border-[#13ec80] disabled:opacity-50" />
          </label>
          {hasPassword ? <label className="block text-xs font-semibold text-[#a0a0a0] lg:col-span-2">현재 비밀번호
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={!state.canChange || working} autoComplete="current-password" className="mt-1.5 min-h-11 w-full rounded-md border border-[#30363d] bg-[#111315] px-3 text-sm text-white outline-none focus:border-[#13ec80] disabled:opacity-50" />
          </label> : <p className="rounded-md border border-sky-300/20 bg-sky-300/10 px-3 py-2 text-xs leading-5 text-sky-100 lg:col-span-2">OAuth 전용 계정은 다시 로그인한 뒤 15분 안에 변경할 수 있습니다.</p>}
          <button type="submit" disabled={!state.canChange || working || username.trim().length < 2 || confirmation !== state.username || (hasPassword && !password)} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-[#13ec80] px-4 text-sm font-bold text-[#07120f] disabled:cursor-not-allowed disabled:opacity-40 sm:w-fit lg:col-span-2">
            {working ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}아이디와 사용자 문서 이동
          </button>
        </form>
      </> : null}
      {feedback ? <p role="alert" className={`mt-4 text-sm leading-6 ${feedback.type === 'success' ? 'text-emerald-300' : 'text-red-300'}`}>{feedback.text}</p> : null}
    </section>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

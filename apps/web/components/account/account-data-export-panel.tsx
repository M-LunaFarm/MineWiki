'use client';

import { Download, Loader2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { ApiClientError, downloadAccountData } from '../../lib/auth-client';
import { MfaStepUpDialog } from '../auth/mfa-step-up-dialog';

export function AccountDataExportPanel({ hasPassword }: { readonly hasPassword: boolean }) {
  const [password, setPassword] = useState('');
  const [working, setWorking] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly type: 'success' | 'error'; readonly text: string } | null>(null);

  async function download(passwordOverride = password): Promise<void> {
    setWorking(true);
    setFeedback(null);
    try {
      const result = await downloadAccountData(passwordOverride || undefined);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setPassword('');
      setFeedback({ type: 'success', text: '현재 읽을 수 있는 계정 데이터를 JSON 파일로 저장했습니다.' });
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'ACCOUNT_EXPORT_REAUTH_REQUIRED') {
        setFeedback({ type: 'error', text: `${error.message} 다중 인증을 설정했다면 아래 버튼으로 확인할 수 있습니다.` });
      } else {
        setFeedback({ type: 'error', text: error instanceof Error ? error.message : '계정 데이터를 내보내지 못했습니다.' });
      }
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="rounded-xl border border-sky-300/20 bg-sky-300/[0.06] p-5">
      <div className="flex items-start gap-3">
        <span className="rounded-lg border border-sky-300/25 bg-sky-300/10 p-2 text-sky-200"><Download className="h-5 w-5" /></span>
        <div>
          <h3 className="text-lg font-bold text-sky-100">내 데이터 내보내기</h3>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[#b8c3cc]">
            연결된 로그인 계정, 공개 프로필, 서버·투표·리뷰, 지원 기록과 현재 읽을 수 있는 위키 기여를 하나의 버전 지정 JSON 파일로 받습니다. 비밀번호, 세션 토큰, OAuth 토큰, MFA 비밀키와 서버 비밀값은 포함하지 않습니다.
          </p>
        </div>
      </div>
      <div className="mt-4 flex max-w-2xl flex-col gap-3">
        {hasPassword ? (
          <label className="text-xs font-medium text-[#c6d0d8]">
            현재 비밀번호
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 block w-full rounded-md border border-[#30363d] bg-[#111315] px-3 py-2.5 text-sm text-white outline-none focus:border-sky-300"
              placeholder="내보내기 전에 다시 확인합니다"
            />
          </label>
        ) : (
          <p className="rounded-md border border-sky-300/20 bg-black/15 px-3 py-2 text-xs text-sky-100">
            OAuth 전용 계정은 로그인 후 15분 안에 바로 받을 수 있습니다. 시간이 지났다면 다시 로그인하거나 다중 인증으로 확인해 주세요.
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => void download()}
            disabled={working || (hasPassword && password.length === 0)}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-sky-300 px-4 py-2 text-sm font-bold text-[#07131a] disabled:opacity-40"
          >
            {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {working ? '파일을 준비하는 중' : 'JSON 파일 받기'}
          </button>
          <button
            type="button"
            onClick={() => setStepUpOpen(true)}
            disabled={working}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-sky-300/30 px-4 py-2 text-sm font-semibold text-sky-100 disabled:opacity-40"
          >
            <ShieldCheck className="h-4 w-4" />다중 인증으로 확인
          </button>
        </div>
        {feedback ? <p role="status" className={`text-xs ${feedback.type === 'success' ? 'text-emerald-300' : 'text-red-300'}`}>{feedback.text}</p> : null}
      </div>
      <MfaStepUpDialog
        open={stepUpOpen}
        purpose="account_export"
        onClose={() => setStepUpOpen(false)}
        onSuccess={() => { setStepUpOpen(false); void download(''); }}
      />
    </section>
  );
}

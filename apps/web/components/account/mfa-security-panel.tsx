'use client';

import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { Check, Clipboard, Download, Fingerprint, KeyRound, Loader2, RefreshCw, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import Image from 'next/image';
import QRCode from 'qrcode';
import { useCallback, useEffect, useState } from 'react';
import {
  beginPasskeyRegistration,
  beginTotpEnrollment,
  confirmTotpEnrollment,
  deletePasskey,
  disableTotp,
  fetchMfaStatus,
  finishPasskeyRegistration,
  regenerateMfaRecoveryCodes,
  type MfaStatus,
  type TotpEnrollment,
} from '../../lib/auth-client';
import { MfaStepUpDialog } from '../auth/mfa-step-up-dialog';

type ProtectedAction = 'regenerate' | 'disable' | 'register_passkey' | 'delete_passkey' | null;

export function MfaSecurityPanel() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [confirmationCode, setConfirmationCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [protectedAction, setProtectedAction] = useState<ProtectedAction>(null);
  const [passkeyName, setPasskeyName] = useState('');
  const [passkeyToDelete, setPasskeyToDelete] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await fetchMfaStatus());
    } catch (error) {
      setFeedback({ type: 'error', text: error instanceof Error ? error.message : '다중 인증 상태를 불러오지 못했습니다.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  useEffect(() => {
    let active = true;
    if (!enrollment) { setQrCode(null); return; }
    void QRCode.toDataURL(enrollment.otpauthUri, {
      width: 220,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#101614', light: '#ffffff' },
    }).then((value) => { if (active) setQrCode(value); });
    return () => { active = false; };
  }, [enrollment]);

  const startEnrollment = async () => {
    setWorking(true); setFeedback(null); setRecoveryCodes(null);
    try {
      setEnrollment(await beginTotpEnrollment());
      setConfirmationCode('');
      setFeedback({ type: 'success', text: '인증 앱에 새 키를 등록한 뒤 6자리 코드를 입력해 주세요.' });
    } catch (error) {
      setFeedback({ type: 'error', text: error instanceof Error ? error.message : 'TOTP 등록을 시작하지 못했습니다.' });
    } finally { setWorking(false); }
  };

  const confirmEnrollment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setWorking(true); setFeedback(null);
    try {
      const result = await confirmTotpEnrollment(confirmationCode);
      setRecoveryCodes(result.recoveryCodes);
      setEnrollment(null); setConfirmationCode('');
      await loadStatus();
      setFeedback({ type: 'success', text: '다중 인증이 활성화되었습니다. 아래 복구 코드는 지금 한 번만 표시됩니다.' });
    } catch (error) {
      setFeedback({ type: 'error', text: error instanceof Error ? error.message : '인증 코드를 확인하지 못했습니다.' });
    } finally { setWorking(false); }
  };

  const runProtectedAction = async () => {
    const action = protectedAction;
    if (!action) return;
    setWorking(true); setFeedback(null);
    try {
      if (action === 'regenerate') {
        const result = await regenerateMfaRecoveryCodes();
        setRecoveryCodes(result.recoveryCodes);
        setFeedback({ type: 'success', text: '기존 복구 코드를 폐기하고 새 코드를 발급했습니다.' });
      } else if (action === 'disable') {
        await disableTotp();
        setRecoveryCodes(null);
        setFeedback({ type: 'success', text: status?.passkeyCount ? '인증 앱을 해제했습니다. 등록된 패스키는 계속 사용할 수 있습니다.' : '다중 인증을 해제하고 다른 기기의 세션을 종료했습니다.' });
      } else if (action === 'register_passkey') {
        if (!browserSupportsWebAuthn()) throw new Error('이 브라우저에서는 패스키를 사용할 수 없습니다.');
        const ceremony = await beginPasskeyRegistration();
        const response = await startRegistration({
          optionsJSON: ceremony.options as Parameters<typeof startRegistration>[0]['optionsJSON'],
        });
        await finishPasskeyRegistration({
          ceremonyId: ceremony.ceremonyId,
          name: passkeyName.trim(),
          response,
        });
        setPasskeyName('');
        setFeedback({ type: 'success', text: '패스키를 등록했습니다. 이제 관리자 작업 확인에 사용할 수 있습니다.' });
      } else if (passkeyToDelete) {
        await deletePasskey(passkeyToDelete);
        setPasskeyToDelete(null);
        setFeedback({ type: 'success', text: '패스키를 삭제하고 다른 기기의 세션을 종료했습니다.' });
      }
      await loadStatus();
    } catch (error) {
      setFeedback({ type: 'error', text: error instanceof Error ? error.message : '보안 설정을 변경하지 못했습니다.' });
    } finally {
      setWorking(false);
      setProtectedAction(null);
    }
  };

  const copyText = async (value: string, successText: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback({ type: 'success', text: successText });
    } catch {
      setFeedback({ type: 'error', text: '클립보드에 복사하지 못했습니다.' });
    }
  };

  const downloadRecoveryCodes = () => {
    if (!recoveryCodes) return;
    const contents = ['MineWiki recovery codes', 'Each code can be used once.', '', ...recoveryCodes].join('\n');
    const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'minewiki-recovery-codes.txt'; link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="mb-6 rounded-lg border border-[#30363d] bg-[#181a1d] p-5 shadow-sm sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-bold text-white">
            <ShieldCheck className="h-5 w-5 text-[#13ec80]" /> 다중 인증
          </h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-[#9aa5b1]">
            인증 앱, 패스키와 일회용 복구 코드로 관리자 작업과 계정 보안 변경을 한 번 더 보호합니다.
          </p>
        </div>
        <span className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${status?.mfaEnabled ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-amber-400/30 bg-amber-400/10 text-amber-200'}`}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : status?.mfaEnabled ? <Check className="h-3.5 w-3.5" /> : <ShieldOff className="h-3.5 w-3.5" />}
          {loading ? '확인 중' : status?.mfaEnabled ? '사용 중' : '사용 안 함'}
        </span>
      </div>

      {feedback ? <p role={feedback.type === 'error' ? 'alert' : undefined} className={`mt-4 rounded-lg border px-3 py-2 text-sm ${feedback.type === 'success' ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100' : 'border-red-400/30 bg-red-400/10 text-red-200'}`}>{feedback.text}</p> : null}

      {!loading && !status?.totpEnabled ? (
        <div className="mt-5">
          {!enrollment ? (
            <div className="rounded-lg border border-[#30363d] bg-[#111315] p-4">
              <p className="text-sm text-white">Google Authenticator, Microsoft Authenticator, 1Password 등 TOTP 앱을 사용할 수 있습니다.</p>
              <p className="mt-1 text-xs leading-5 text-[#8f98a3]">등록에는 최근 15분 이내의 로그인이 필요합니다. 시간이 지났다면 다시 로그인해 주세요.</p>
              <button type="button" onClick={() => void startEnrollment()} disabled={working} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#13ec80] px-4 py-2.5 text-sm font-bold text-[#07130d] disabled:opacity-50">
                {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                {status?.pendingEnrollment ? '새 키로 등록 다시 시작' : '인증 앱 등록 시작'}
              </button>
            </div>
          ) : (
            <div className="mt-5 grid gap-5 lg:grid-cols-[240px_1fr]">
              <div className="flex min-h-[220px] items-center justify-center rounded-xl bg-white p-2">
                {qrCode ? <Image src={qrCode} alt="MineWiki TOTP 등록 QR 코드" width={220} height={220} unoptimized /> : <Loader2 className="h-6 w-6 animate-spin text-black" />}
              </div>
              <div>
                <h4 className="text-base font-bold text-white">1. QR 코드를 인증 앱으로 스캔하세요</h4>
                <p className="mt-1 text-sm text-[#9aa5b1]">스캔할 수 없다면 아래 키를 직접 입력할 수 있습니다.</p>
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-[#3a424a] bg-[#101214] px-3 py-2.5">
                  <code className="min-w-0 flex-1 break-all font-mono text-xs tracking-wide text-[#d7e0e8]">{enrollment.secret}</code>
                  <button type="button" onClick={() => void copyText(enrollment.secret, '등록 키를 복사했습니다.')} className="shrink-0 rounded-md p-2 text-[#9aa5b1] hover:bg-white/5 hover:text-white" aria-label="TOTP 등록 키 복사"><Clipboard className="h-4 w-4" /></button>
                </div>
                <form className="mt-5" onSubmit={confirmEnrollment}>
                  <label className="block text-sm font-semibold text-white">2. 앱에 표시된 6자리 코드로 확인하세요</label>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <input value={confirmationCode} onChange={(event) => setConfirmationCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" pattern="\d{6}" required className="min-w-0 flex-1 rounded-lg border border-[#3a424a] bg-[#101214] px-3 py-2.5 font-mono text-base tracking-[0.25em] text-white outline-none focus:border-[#13ec80]" />
                    <button type="submit" disabled={working || confirmationCode.length !== 6} className="rounded-lg bg-[#13ec80] px-5 py-2.5 text-sm font-bold text-[#07130d] disabled:opacity-50">{working ? '확인 중' : '등록 완료'}</button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {status?.totpEnabled ? (
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-[#30363d] bg-[#111315] p-4">
            <p className="text-sm font-semibold text-white">인증 앱</p>
            <p className="mt-1 text-xs leading-5 text-[#8f98a3]">관리 작업마다 새 코드를 입력하면 해당 목적에만 5분 동안 허용됩니다.</p>
          </div>
          <div className="rounded-lg border border-[#30363d] bg-[#111315] p-4">
            <p className="text-sm font-semibold text-white">남은 복구 코드 {status.recoveryCodesRemaining}개</p>
            <p className="mt-1 text-xs leading-5 text-[#8f98a3]">각 코드는 한 번만 사용할 수 있습니다. 3개 이하라면 새로 발급하세요.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row md:col-span-2">
            <button type="button" disabled={working} onClick={() => setProtectedAction('regenerate')} className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#13ec80]/35 bg-[#13ec80]/10 px-4 py-2.5 text-sm font-semibold text-[#71f5b1] disabled:opacity-50"><RefreshCw className="h-4 w-4" />복구 코드 새로 발급</button>
            <button type="button" disabled={working} onClick={() => setProtectedAction('disable')} className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-400/35 bg-red-400/10 px-4 py-2.5 text-sm font-semibold text-red-200 disabled:opacity-50"><ShieldOff className="h-4 w-4" />인증 앱 해제</button>
          </div>
        </div>
      ) : null}

      {!loading && status ? (
        <section className="mt-5 rounded-xl border border-[#30363d] bg-[#111315] p-4 sm:p-5" aria-labelledby="passkey-settings-title">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h4 id="passkey-settings-title" className="flex items-center gap-2 font-bold text-white"><Fingerprint className="h-4 w-4 text-[#71f5b1]" />패스키</h4>
              <p className="mt-1 text-xs leading-5 text-[#8f98a3]">지문, 얼굴 인식, 화면 잠금 또는 보안 키로 목적별 관리자 확인을 완료합니다. 비밀번호 없는 로그인에는 아직 사용하지 않습니다.</p>
            </div>
            <span className="shrink-0 rounded-full border border-white/10 px-2.5 py-1 text-xs text-[#aab3bd]">{status.passkeyCount}/10</span>
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <label className="min-w-0 flex-1">
              <span className="sr-only">새 패스키 이름</span>
              <input
                value={passkeyName}
                onChange={(event) => setPasskeyName(event.target.value.slice(0, 64))}
                maxLength={64}
                autoComplete="off"
                placeholder="예: 업무용 MacBook"
                disabled={!status.mfaEnabled || status.passkeyCount >= 10 || working}
                className="min-h-11 w-full rounded-lg border border-[#3a424a] bg-[#101214] px-3 text-sm text-white outline-none transition focus:border-[#13ec80] disabled:opacity-50"
              />
            </label>
            <button
              type="button"
              onClick={() => setProtectedAction('register_passkey')}
              disabled={!status.mfaEnabled || status.passkeyCount >= 10 || !passkeyName.trim() || working}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#13ec80]/35 bg-[#13ec80]/10 px-4 text-sm font-semibold text-[#71f5b1] disabled:opacity-50"
            >
              <Fingerprint className="h-4 w-4" />패스키 추가
            </button>
          </div>
          {!status.mfaEnabled ? <p className="mt-2 text-xs text-amber-200">첫 패스키를 안전하게 등록하려면 먼저 인증 앱을 활성화해 주세요.</p> : null}

          {status.passkeys.length ? (
            <ul className="mt-5 divide-y divide-white/10 border-t border-white/10">
              {status.passkeys.map((passkey) => (
                <li key={passkey.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">{passkey.name}</p>
                    <p className="mt-1 text-xs text-[#8f98a3]">{passkey.backedUp ? '동기화 가능한 패스키' : '이 기기 또는 보안 키'} · 등록 {formatSecurityDate(passkey.createdAt)}{passkey.lastUsedAt ? ` · 최근 사용 ${formatSecurityDate(passkey.lastUsedAt)}` : ' · 아직 사용하지 않음'}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setPasskeyToDelete(passkey.id); setProtectedAction('delete_passkey'); }}
                    disabled={working}
                    className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-red-400/30 bg-red-400/10 px-3 text-xs font-semibold text-red-200 disabled:opacity-50"
                  ><Trash2 className="h-4 w-4" />삭제</button>
                </li>
              ))}
            </ul>
          ) : <p className="mt-5 border-t border-white/10 pt-4 text-sm text-[#8f98a3]">등록된 패스키가 없습니다.</p>}
        </section>
      ) : null}

      {recoveryCodes ? (
        <div className="mt-5 rounded-xl border border-amber-300/30 bg-amber-300/10 p-4">
          <h4 className="font-bold text-amber-100">복구 코드를 지금 저장하세요</h4>
          <p className="mt-1 text-xs leading-5 text-amber-100/80">이 코드는 다시 표시되지 않습니다. 비밀번호 관리자나 오프라인 보관소에 저장하고 누구에게도 보내지 마세요.</p>
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {recoveryCodes.map((code) => <code key={code} className="rounded-md border border-amber-100/15 bg-black/20 px-3 py-2 text-center font-mono text-sm tracking-wide text-amber-50">{code}</code>)}
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button type="button" onClick={() => void copyText(recoveryCodes.join('\n'), '복구 코드를 모두 복사했습니다.')} className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-100/30 px-3 py-2 text-xs font-semibold text-amber-50"><Clipboard className="h-4 w-4" />모두 복사</button>
            <button type="button" onClick={downloadRecoveryCodes} className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-100/30 px-3 py-2 text-xs font-semibold text-amber-50"><Download className="h-4 w-4" />텍스트 파일 저장</button>
          </div>
        </div>
      ) : null}

      <MfaStepUpDialog open={protectedAction !== null} purpose="mfa_manage" onClose={() => { setProtectedAction(null); setPasskeyToDelete(null); }} onSuccess={runProtectedAction} />
    </section>
  );
}

function formatSecurityDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' }).format(new Date(value));
}

'use client';

import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  History,
  Link2,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  fetchAdminAccountModeration,
  restoreAdminAccount,
  suspendAdminAccount,
  type AdminAccountDetail,
  type AdminAccountLifecycleStatus,
} from '../../lib/account-moderation-api';
import { useAuth } from '../providers/auth-context';

const STATUS_LABELS: Record<AdminAccountLifecycleStatus, string> = {
  active: '활성',
  suspended: '긴급 정지',
  deletion_pending: '종료 대기',
  anonymized: '비식별화 완료',
  mixed: '상태 불일치',
};

type ModerationAction = 'suspend' | 'restore';

export function AdminAccountSecurity({ accountId }: { readonly accountId: string }) {
  const { account: currentAccount } = useAuth();
  const [account, setAccount] = useState<AdminAccountDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [action, setAction] = useState<ModerationAction | null>(null);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
    if (mode === 'initial') setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      setAccount(await fetchAdminAccountModeration(accountId));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '계정 보안 정보를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isSelf = useMemo(
    () => Boolean(currentAccount && account?.accountIds.includes(currentAccount.id)),
    [account, currentAccount],
  );
  const expectedAction = account?.lifecycleStatus === 'active'
    ? 'suspend'
    : account?.lifecycleStatus === 'suspended'
      ? 'restore'
      : null;
  const confirmationMatches = confirmation === account?.confirmationValue;
  const reasonLength = reason.trim().length;
  const canSubmit = Boolean(
    action &&
    action === expectedAction &&
    !isSelf &&
    reasonLength >= 5 &&
    reasonLength <= 1000 &&
    confirmationMatches &&
    !submitting,
  );

  const beginAction = (nextAction: ModerationAction) => {
    setAction(nextAction);
    setReason('');
    setConfirmation('');
    setError(null);
    setNotice(null);
  };

  const cancelAction = () => {
    if (submitting) return;
    setAction(null);
    setReason('');
    setConfirmation('');
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!account || !action || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const result = action === 'suspend'
        ? await suspendAdminAccount(account.canonicalAccountId, {
            reason: reason.trim(),
            confirmation: account.confirmationValue,
            expectedStatus: 'active',
          })
        : await restoreAdminAccount(account.canonicalAccountId, {
            reason: reason.trim(),
            confirmation: account.confirmationValue,
            expectedStatus: 'suspended',
          });
      setAccount(result.account);
      setAction(null);
      setReason('');
      setConfirmation('');
      setNotice(action === 'suspend'
        ? `계정 그룹을 긴급 정지했습니다. 세션 ${result.revokedSessionCount}개와 Wiki API 토큰 ${result.revokedWikiApiTokenCount}개를 해지했습니다.`
        : '계정 그룹을 활성 상태로 복구했습니다. 사용자는 다시 로그인해야 합니다.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '계정 상태를 변경하지 못했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[45vh] items-center justify-center gap-2 text-sm text-slate-400" aria-live="polite">
        <Loader2 className="h-5 w-5 animate-spin text-[#35e5b7]" /> 계정 보안 정보를 불러오는 중
      </div>
    );
  }

  if (!account) {
    return (
      <div className="space-y-5">
        <BackToUsers />
        <section className="rounded-2xl border border-red-400/20 bg-red-500/10 p-6 text-red-100" role="alert">
          <h1 className="text-lg font-bold text-white">계정 정보를 표시할 수 없습니다</h1>
          <p className="mt-2 text-sm leading-6">{error ?? '계정을 찾을 수 없습니다.'}</p>
          <button type="button" onClick={() => void load()} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg border border-white/15 px-4 text-sm font-bold hover:bg-white/5">
            <RefreshCw className="h-4 w-4" /> 다시 시도
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-6" aria-busy={submitting || refreshing}>
      <BackToUsers />

      <header className="rounded-2xl border border-white/[0.08] bg-[radial-gradient(circle_at_top_right,rgba(239,68,68,0.12),transparent_42%),#17191c] p-5 sm:p-7">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-red-400/20 bg-red-500/10 text-red-200">
              <ShieldAlert className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-red-200">Emergency Account Control</p>
              <h1 className="mt-2 break-words text-2xl font-extrabold text-white sm:text-3xl">
                {account.displayName || account.email || '이름 없는 계정'}
              </h1>
              <p className="mt-2 break-all font-mono text-xs text-slate-400">{account.canonicalAccountId}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:flex-col sm:items-end">
            <StatusBadge status={account.lifecycleStatus} />
            <button
              type="button"
              onClick={() => void load('refresh')}
              disabled={refreshing || submitting}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/10 px-3 text-xs font-bold text-slate-300 transition hover:bg-white/5 disabled:opacity-40"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> 새로고침
            </button>
          </div>
        </div>
      </header>

      {error ? <p role="alert" className="rounded-xl border border-red-400/25 bg-red-500/10 p-4 text-sm text-red-100">{error}</p> : null}
      {notice ? <p role="status" className="rounded-xl border border-[#35e5b7]/25 bg-[#35e5b7]/10 p-4 text-sm text-[#b6f8e5]">{notice}</p> : null}

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
        <article className="rounded-2xl border border-white/[0.08] bg-[#17191c] p-5 sm:p-6">
          <div className="flex items-center gap-2 text-sm font-bold text-white"><UserRound className="h-4 w-4 text-[#35e5b7]" /> 계정 그룹</div>
          <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
            <Detail label="대표 이메일" value={account.email ?? '-'} />
            <Detail label="연결 로그인" value={`${account.providers.map(providerLabel).join(', ')} · ${account.accountIds.length}개 계정`} />
            <Detail label="가입" value={formatDate(account.createdAt)} />
            <Detail label="최근 로그인" value={formatDate(account.lastLoginAt)} />
            <Detail label="역할" value={account.roles.length ? account.roles.join(', ') : '역할 없음'} />
            <Detail label="정지 시각" value={formatDate(account.suspendedAt)} />
          </dl>
          {account.suspensionReason ? (
            <div className="mt-5 rounded-xl border border-red-400/20 bg-red-500/5 p-4">
              <p className="text-xs font-bold text-red-200">최근 정지 사유</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-red-100/85">{account.suspensionReason}</p>
              {account.suspendedBy ? <p className="mt-2 break-all text-xs text-red-200/60">처리자 {account.suspendedBy}</p> : null}
            </div>
          ) : null}
        </article>

        <article className="rounded-2xl border border-white/[0.08] bg-[#17191c] p-5 sm:p-6">
          <div className="flex items-center gap-2 text-sm font-bold text-white"><ShieldCheck className="h-4 w-4 text-[#35e5b7]" /> 보안 조치</div>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            정지는 연결된 계정 그룹 전체에 적용되며 활성 세션과 장기 Wiki API 토큰을 즉시 해지합니다.
          </p>
          {isSelf ? <p className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">현재 로그인한 본인 계정 그룹에는 보안 조치를 실행할 수 없습니다.</p> : null}
          {expectedAction === 'suspend' ? (
            <button type="button" onClick={() => beginAction('suspend')} disabled={isSelf || submitting} className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-4 text-sm font-extrabold text-red-100 transition hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-40">
              <Ban className="h-4 w-4" /> 긴급 정지 시작
            </button>
          ) : expectedAction === 'restore' ? (
            <button type="button" onClick={() => beginAction('restore')} disabled={isSelf || submitting} className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#35e5b7] px-4 text-sm font-extrabold text-[#07120f] transition hover:bg-[#79f2cf] disabled:cursor-not-allowed disabled:opacity-40">
              <RotateCcw className="h-4 w-4" /> 활성 상태로 복구
            </button>
          ) : (
            <p className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-sm leading-6 text-amber-100">
              종료 대기·비식별화·상태 불일치 계정은 이 화면에서 정지하거나 복구할 수 없습니다.
            </p>
          )}
        </article>
      </section>

      {action ? (
        <form onSubmit={submit} className={`rounded-2xl border p-5 sm:p-6 ${action === 'suspend' ? 'border-red-400/30 bg-red-500/[0.07]' : 'border-[#35e5b7]/25 bg-[#35e5b7]/[0.06]'}`}>
          <div className="flex gap-3">
            <AlertTriangle className={`mt-0.5 h-5 w-5 shrink-0 ${action === 'suspend' ? 'text-red-200' : 'text-[#79f2cf]'}`} />
            <div>
              <h2 className="text-lg font-extrabold text-white">{action === 'suspend' ? '계정 그룹 긴급 정지 확인' : '계정 그룹 복구 확인'}</h2>
              <p className="mt-1 text-sm leading-6 text-slate-300">
                {action === 'suspend'
                  ? '로그인과 API 접근이 즉시 차단됩니다. 조사와 인수인계에 충분한 사유를 남기세요.'
                  : '정지 원인이 해결되었는지 확인하고 복구 근거를 남기세요. 기존 세션과 토큰은 복원되지 않습니다.'}
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-5">
            <label className="block">
              <span className="text-sm font-bold text-white">조치 사유</span>
              <textarea
                value={reason}
                onChange={(event) => { setReason(event.target.value); setError(null); }}
                minLength={5}
                maxLength={1000}
                required
                disabled={submitting}
                rows={5}
                aria-describedby="moderation-reason-guidance"
                className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-black/25 px-3 py-3 text-sm leading-6 text-white outline-none transition placeholder:text-slate-600 focus:border-[#35e5b7]/50 focus:ring-2 focus:ring-[#35e5b7]/10 disabled:opacity-50"
                placeholder="확인된 위험, 조치 근거, 관련 티켓 또는 복구 판단 근거를 입력하세요."
              />
              <span id="moderation-reason-guidance" className="mt-1.5 flex justify-between gap-3 text-xs text-slate-500">
                <span>앞뒤 공백 제외 5~1000자</span><span>{reasonLength}/1000</span>
              </span>
            </label>

            <label className="block">
              <span className="text-sm font-bold text-white">대표 계정 ID 직접 입력</span>
              <span className="mt-1 block text-xs leading-5 text-slate-400">아래 값을 정확히 입력해야 실행할 수 있습니다.</span>
              <code className="mt-2 block break-all rounded-lg border border-white/10 bg-black/25 p-3 text-xs text-amber-100">{account.confirmationValue}</code>
              <input
                value={confirmation}
                onChange={(event) => { setConfirmation(event.target.value.trim()); setError(null); }}
                required
                disabled={submitting}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={confirmation.length > 0 && !confirmationMatches}
                className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-black/25 px-3 font-mono text-sm text-white outline-none transition focus:border-[#35e5b7]/50 focus:ring-2 focus:ring-[#35e5b7]/10 disabled:opacity-50"
                placeholder="대표 계정 ID"
              />
              {confirmation.length > 0 && !confirmationMatches ? <span className="mt-1.5 block text-xs text-red-200">대표 계정 ID가 일치하지 않습니다.</span> : null}
            </label>
          </div>

          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={cancelAction} disabled={submitting} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-white/10 px-4 text-sm font-bold text-slate-200 transition hover:bg-white/5 disabled:opacity-40">취소</button>
            <button type="submit" disabled={!canSubmit} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-5 text-sm font-extrabold transition disabled:cursor-not-allowed disabled:opacity-40 ${action === 'suspend' ? 'bg-red-500 text-white hover:bg-red-400' : 'bg-[#35e5b7] text-[#07120f] hover:bg-[#79f2cf]'}`}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : action === 'suspend' ? <Ban className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
              {submitting ? '처리 중입니다' : action === 'suspend' ? '계정 그룹 즉시 정지' : '계정 그룹 복구 실행'}
            </button>
          </div>
        </form>
      ) : null}

      <section className="rounded-2xl border border-white/[0.08] bg-[#17191c]">
        <div className="flex items-center gap-2 border-b border-white/[0.08] px-5 py-4 text-sm font-bold text-white"><Link2 className="h-4 w-4 text-[#35e5b7]" /> 연결 계정 {account.accounts.length}개</div>
        <div className="divide-y divide-white/[0.06]">
          {account.accounts.map((member) => (
            <article key={member.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-white">{member.displayName || member.email || providerLabel(member.provider)}</p>
                <p className="mt-1 break-all font-mono text-xs text-slate-500">{member.id}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-xs text-slate-300">{providerLabel(member.provider)}</span>
                <StatusBadge status={member.lifecycleStatus} compact />
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-white/[0.08] bg-[#17191c]">
        <div className="flex items-center gap-2 border-b border-white/[0.08] px-5 py-4 text-sm font-bold text-white"><History className="h-4 w-4 text-[#35e5b7]" /> 최근 정지·복구 이력</div>
        {account.moderationHistory.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">기록된 계정 보안 조치가 없습니다.</p> : (
          <ol className="divide-y divide-white/[0.06]">
            {account.moderationHistory.map((entry) => (
              <li key={entry.id} className="px-5 py-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-sm font-bold text-white">{entry.action === 'account.suspended' ? '계정 그룹 정지' : '계정 그룹 복구'}</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-400">{entry.reason ?? '사유 없음'}</p>
                  </div>
                  <time className="shrink-0 text-xs text-slate-500" dateTime={entry.createdAt}>{formatDate(entry.createdAt)}</time>
                </div>
                <p className="mt-2 break-all text-xs text-slate-600">{entry.previousStatus ?? '-'} → {entry.newStatus ?? '-'} · 처리자 {entry.actorAccountId ?? '-'}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function BackToUsers() {
  return <Link href="/admin/users" className="inline-flex min-h-11 items-center gap-2 text-sm text-slate-400 transition hover:text-white"><ArrowLeft className="h-4 w-4" /> 사용자 목록</Link>;
}

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt className="text-xs font-semibold text-slate-500">{label}</dt><dd className="mt-1 break-words text-sm text-slate-200">{value}</dd></div>;
}

function StatusBadge({ status, compact = false }: { readonly status: AdminAccountLifecycleStatus; readonly compact?: boolean }) {
  const color = status === 'active'
    ? 'border-[#35e5b7]/25 bg-[#35e5b7]/10 text-[#79f2cf]'
    : status === 'suspended'
      ? 'border-red-400/25 bg-red-500/10 text-red-100'
      : 'border-amber-400/25 bg-amber-500/10 text-amber-100';
  return <span className={`inline-flex items-center rounded-full border font-bold ${compact ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs'} ${color}`}>{STATUS_LABELS[status]}</span>;
}

function providerLabel(provider: AdminAccountDetail['providers'][number]): string {
  if (provider === 'discord') return 'Discord';
  if (provider === 'naver') return 'NAVER';
  return 'Email';
}

function formatDate(value: string | null): string {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleString('ko-KR');
}

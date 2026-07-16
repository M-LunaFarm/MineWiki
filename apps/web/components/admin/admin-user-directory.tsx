'use client';

import Link from 'next/link';
import {
  ArrowLeft,
  KeyRound,
  Loader2,
  Search,
  ShieldAlert,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import {
  fetchAdminAccounts,
  type AccountLifecycleStatus,
  type AdminAccountLifecycleStatus,
  type AdminAccountSummary,
} from '../../lib/account-moderation-api';
import { useAuth } from '../providers/auth-context';

const STATUS_FILTERS: ReadonlyArray<{ readonly value: AccountLifecycleStatus | ''; readonly label: string }> = [
  { value: '', label: '모든 상태' },
  { value: 'active', label: '활성' },
  { value: 'suspended', label: '긴급 정지' },
  { value: 'deletion_pending', label: '종료 대기' },
  { value: 'anonymized', label: '비식별화 완료' },
];

const STATUS_LABELS: Record<AdminAccountLifecycleStatus, string> = {
  active: '활성',
  suspended: '긴급 정지',
  deletion_pending: '종료 대기',
  anonymized: '비식별화 완료',
  mixed: '상태 불일치',
};

export function AdminUserDirectory() {
  const { account: currentAccount } = useAuth();
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [status, setStatus] = useState<AccountLifecycleStatus | ''>('');
  const [accounts, setAccounts] = useState<AdminAccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canManageRoles = Boolean(currentAccount?.access?.roles.some((role) => role === 'owner' || role === 'admin'));
  const canModerateAccounts = Boolean(currentAccount?.access?.permissions.includes('admin.account.suspend'));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchAdminAccounts({
      q: submittedQuery || undefined,
      status: status || undefined,
      limit: 50,
    })
      .then((result) => {
        if (!cancelled) setAccounts(result.accounts);
      })
      .catch((requestError) => {
        if (!cancelled) {
          setAccounts([]);
          setError(requestError instanceof Error ? requestError.message : '사용자를 불러오지 못했습니다.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status, submittedQuery]);

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmittedQuery(query.trim());
  };

  return (
    <div className="space-y-6">
      <Link href="/admin" className="inline-flex min-h-11 items-center gap-2 text-sm text-slate-400 transition hover:text-white">
        <ArrowLeft className="h-4 w-4" /> 관리자 센터
      </Link>

      <header className="flex flex-col gap-4 border-b border-white/[0.08] pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#35e5b7]">Account Operations</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-white">사용자 및 계정 보안</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">이메일, 표시 이름 또는 계정 ID로 계정 그룹을 찾고 상태·역할·긴급 보안 조치를 확인하세요.</p>
        </div>
        <div className="flex w-fit items-center gap-2 rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-100">
          <ShieldCheck className="h-4 w-4" /> 모든 보안 조치는 감사 로그에 기록됩니다
        </div>
      </header>

      <form onSubmit={handleSearch} className="grid gap-3 rounded-2xl border border-white/[0.08] bg-[#17191c] p-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto]">
        <label className="relative min-w-0">
          <span className="sr-only">사용자 검색</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-h-11 w-full rounded-xl border border-white/[0.08] bg-black/25 pl-10 pr-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-[#35e5b7]/50 focus:ring-2 focus:ring-[#35e5b7]/10"
            placeholder="이메일, 표시 이름, 계정 ID"
          />
        </label>
        <label>
          <span className="sr-only">계정 상태</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as AccountLifecycleStatus | '')}
            className="min-h-11 w-full rounded-xl border border-white/[0.08] bg-[#101214] px-3 text-sm text-white outline-none focus:border-[#35e5b7]/50 focus:ring-2 focus:ring-[#35e5b7]/10"
          >
            {STATUS_FILTERS.map((filter) => <option key={filter.value || 'all'} value={filter.value}>{filter.label}</option>)}
          </select>
        </label>
        <button type="submit" disabled={loading} className="min-h-11 rounded-xl bg-[#35e5b7] px-5 text-sm font-extrabold text-[#07120f] transition hover:bg-[#79f2cf] disabled:cursor-wait disabled:opacity-50">
          검색
        </button>
      </form>

      {error ? <div role="alert" className="rounded-xl border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">{error}</div> : null}

      <section className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#17191c]" aria-busy={loading}>
        <div className="flex items-center justify-between gap-4 border-b border-white/[0.08] px-5 py-4">
          <h2 className="text-sm font-bold text-white">{submittedQuery || status ? '필터 결과' : '최근 가입 계정 그룹'}</h2>
          <span className="text-xs text-slate-500">최대 50개 · {accounts.length}개 표시</span>
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-400" aria-live="polite"><Loader2 className="h-4 w-4 animate-spin text-[#35e5b7]" /> 불러오는 중</div>
        ) : accounts.length === 0 ? (
          <div className="py-16 text-center text-sm text-slate-500">조건에 맞는 계정이 없습니다.</div>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {accounts.map((account) => (
              <article key={account.canonicalAccountId} className="px-4 py-5 transition hover:bg-white/[0.02] sm:px-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-black/20 text-slate-300"><UserRound className="h-5 w-5" /></span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="break-words text-sm font-bold text-white">{account.displayName || account.email || '이름 없는 계정'}</h3>
                        <StatusBadge status={account.lifecycleStatus} />
                      </div>
                      <p className="mt-1 break-all text-xs text-slate-500">{account.email || account.canonicalAccountId}</p>
                      <p className="mt-2 text-xs text-slate-500">{account.providers.map(providerLabel).join(', ')} · 연결 계정 {account.accountIds.length}개 · 최근 로그인 {formatDate(account.lastLoginAt)}</p>
                      {account.lifecycleStatus === 'suspended' && account.suspensionReason ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-red-200/80">정지 사유: {account.suspensionReason}</p> : null}
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center lg:justify-end">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {account.roles.length ? account.roles.map((role) => <span key={role} className="rounded-full border border-[#35e5b7]/20 bg-[#35e5b7]/10 px-2.5 py-1 text-[11px] font-semibold text-[#79f2cf]">{role}</span>) : <span className="text-xs text-slate-600">역할 없음</span>}
                    </div>
                    <div className="grid grid-cols-1 gap-2 min-[390px]:grid-cols-2 sm:flex">
                      {canManageRoles ? (
                        <Link href={`/admin/users/${account.canonicalAccountId}/roles`} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/10 px-3 text-xs font-bold text-slate-200 transition hover:bg-white/5">
                          <KeyRound className="h-4 w-4" /> 역할 관리
                        </Link>
                      ) : null}
                      {canModerateAccounts ? (
                        <Link href={`/admin/users/${account.canonicalAccountId}/security`} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-400/20 bg-red-500/10 px-3 text-xs font-bold text-red-100 transition hover:bg-red-500/15">
                          <ShieldAlert className="h-4 w-4" /> 계정 보안
                        </Link>
                      ) : null}
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { readonly status: AdminAccountLifecycleStatus }) {
  const color = status === 'active'
    ? 'border-[#35e5b7]/25 bg-[#35e5b7]/10 text-[#79f2cf]'
    : status === 'suspended'
      ? 'border-red-400/25 bg-red-500/10 text-red-100'
      : 'border-amber-400/25 bg-amber-500/10 text-amber-100';
  return <span className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${color}`}>{STATUS_LABELS[status]}</span>;
}

function providerLabel(provider: AdminAccountSummary['providers'][number]): string {
  if (provider === 'discord') return 'Discord';
  if (provider === 'naver') return 'NAVER';
  return 'Email';
}

function formatDate(value: string | null): string {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleDateString('ko-KR');
}

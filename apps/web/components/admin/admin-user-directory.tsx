'use client';

import Link from 'next/link';
import { ArrowLeft, Loader2, Search, ShieldCheck, UserRound } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { searchAdminAccounts, type AdminAccountRoleSummary } from '../../lib/role-admin-api';

export function AdminUserDirectory() {
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [accounts, setAccounts] = useState<AdminAccountRoleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void searchAdminAccounts(submittedQuery, 50)
      .then((result) => {
        if (!cancelled) setAccounts(result);
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
  }, [submittedQuery]);

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmittedQuery(query.trim());
  };

  return (
    <div className="space-y-6">
      <Link href="/admin" className="inline-flex items-center gap-2 text-sm text-slate-400 transition hover:text-white">
        <ArrowLeft className="h-4 w-4" /> 관리자 센터
      </Link>

      <header className="flex flex-col gap-4 border-b border-white/[0.08] pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#35e5b7]">Access Control</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-white">사용자 및 역할</h1>
          <p className="mt-2 text-sm text-slate-400">이메일, 표시 이름 또는 계정 ID로 사용자를 찾으세요.</p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-100">
          <ShieldCheck className="h-4 w-4" /> 권한 변경은 감사 로그에 기록됩니다
        </div>
      </header>

      <form onSubmit={handleSearch} className="flex gap-2 rounded-2xl border border-white/[0.08] bg-[#17191c] p-3">
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-11 w-full rounded-xl border border-white/[0.08] bg-black/25 pl-10 pr-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-[#35e5b7]/50 focus:ring-2 focus:ring-[#35e5b7]/10"
            placeholder="이메일, 표시 이름, 계정 ID"
          />
        </label>
        <button type="submit" className="rounded-xl bg-[#35e5b7] px-5 text-sm font-extrabold text-[#07120f] transition hover:bg-[#79f2cf]">
          검색
        </button>
      </form>

      {error ? <div className="rounded-xl border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">{error}</div> : null}

      <section className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#17191c]">
        <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
          <h2 className="text-sm font-bold text-white">{submittedQuery ? '검색 결과' : '최근 가입 사용자'}</h2>
          <span className="text-xs text-slate-500">{accounts.length}명</span>
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin text-[#35e5b7]" /> 불러오는 중</div>
        ) : accounts.length === 0 ? (
          <div className="py-16 text-center text-sm text-slate-500">조건에 맞는 사용자가 없습니다.</div>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {accounts.map((account) => (
              <Link key={account.id} href={`/admin/users/${account.id}/roles`} className="flex flex-col gap-4 px-5 py-4 transition hover:bg-white/[0.025] sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-black/20 text-slate-300"><UserRound className="h-5 w-5" /></span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-white">{account.displayName || account.email || '이름 없는 계정'}</p>
                    <p className="mt-1 truncate text-xs text-slate-500">{account.email || account.id}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  {account.roles.length ? account.roles.map((role) => <span key={role} className="rounded-full border border-[#35e5b7]/20 bg-[#35e5b7]/10 px-2.5 py-1 text-[11px] font-semibold text-[#79f2cf]">{role}</span>) : <span className="text-xs text-slate-600">역할 없음</span>}
                  <span className="ml-1 text-xs font-bold text-[#35e5b7]">관리 →</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

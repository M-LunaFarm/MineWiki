'use client';

import Link from 'next/link';
import { ArrowLeft, Check, KeyRound, Loader2, ShieldAlert, UserRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  assignAdminRole,
  fetchAdminRoles,
  removeAdminRole,
  searchAdminAccounts,
  type AdminAccountRoleSummary,
  type AdminRole,
} from '../../lib/role-admin-api';

export function AdminRoleEditor({ accountId }: { readonly accountId: string }) {
  const [account, setAccount] = useState<AdminAccountRoleSummary | null>(null);
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutatingRole, setMutatingRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [roleList, matches] = await Promise.all([fetchAdminRoles(), searchAdminAccounts(accountId, 10)]);
      const exact = matches.find((candidate) => candidate.id === accountId) ?? null;
      if (!exact) throw new Error('사용자 계정을 찾을 수 없습니다.');
      setRoles(roleList);
      setAccount(exact);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '역할 정보를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);

  const activeRoles = useMemo(() => new Set(account?.roles ?? []), [account?.roles]);

  const toggleRole = async (role: AdminRole) => {
    if (!account || mutatingRole) return;
    const assigned = activeRoles.has(role.code);
    setMutatingRole(role.code);
    setError(null);
    setNotice(null);
    try {
      const access = assigned
        ? await removeAdminRole(account.id, role.code)
        : await assignAdminRole(account.id, role.code);
      setAccount({ ...account, roles: access.roles });
      setNotice(`${role.displayName} 역할을 ${assigned ? '제거' : '부여'}했습니다.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '역할을 변경하지 못했습니다.');
    } finally {
      setMutatingRole(null);
    }
  };

  return (
    <div className="space-y-6">
      <Link href="/admin/users" className="inline-flex items-center gap-2 text-sm text-slate-400 transition hover:text-white"><ArrowLeft className="h-4 w-4" /> 사용자 목록</Link>

      {loading ? <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin text-[#35e5b7]" /> 권한 정보를 불러오는 중</div> : null}
      {!loading && error && !account ? <div className="rounded-2xl border border-red-400/20 bg-red-500/10 p-6 text-sm text-red-100">{error}</div> : null}

      {account ? (
        <>
          <section className="flex flex-col gap-5 rounded-2xl border border-white/[0.08] bg-[radial-gradient(circle_at_top_right,rgba(20,199,148,0.12),transparent_42%),#17191c] p-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-4">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-[#35e5b7]/20 bg-[#35e5b7]/10 text-[#79f2cf]"><UserRound className="h-7 w-7" /></span>
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#35e5b7]">Role Assignment</p>
                <h1 className="mt-1 truncate text-2xl font-extrabold text-white">{account.displayName || '이름 없는 계정'}</h1>
                <p className="mt-1 truncate text-sm text-slate-400">{account.email || account.id}</p>
              </div>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-black/20 px-4 py-3 text-right">
              <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">현재 역할</p>
              <p className="mt-1 text-lg font-bold text-white">{account.roles.length}개</p>
            </div>
          </section>

          <div className="rounded-xl border border-amber-400/20 bg-amber-400/10 p-4 text-sm leading-6 text-amber-100"><div className="flex gap-3"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" /><p><strong>최소 권한 원칙:</strong> 업무에 필요한 역할만 부여하세요. owner와 admin 역할은 서비스 전체에 영향을 줄 수 있습니다.</p></div></div>
          {error ? <div className="rounded-xl border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">{error}</div> : null}
          {notice ? <div className="rounded-xl border border-[#35e5b7]/20 bg-[#35e5b7]/10 p-4 text-sm text-[#b6f8e5]">{notice}</div> : null}

          <section className="grid gap-4 md:grid-cols-2">
            {roles.map((role) => {
              const assigned = activeRoles.has(role.code);
              const busy = mutatingRole === role.code;
              return (
                <article key={role.id} className={`rounded-2xl border p-5 transition ${assigned ? 'border-[#35e5b7]/30 bg-[#10231e]' : 'border-white/[0.08] bg-[#17191c]'}`}>
                  <div className="flex items-start justify-between gap-4">
                    <span className={`rounded-xl p-2.5 ${assigned ? 'bg-[#35e5b7]/15 text-[#79f2cf]' : 'bg-black/20 text-slate-400'}`}><KeyRound className="h-5 w-5" /></span>
                    <button type="button" onClick={() => void toggleRole(role)} disabled={Boolean(mutatingRole)} className={`inline-flex min-w-24 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-extrabold transition disabled:cursor-wait disabled:opacity-50 ${assigned ? 'border border-red-400/20 bg-red-500/10 text-red-100 hover:bg-red-500/15' : 'bg-[#35e5b7] text-[#07120f] hover:bg-[#79f2cf]'}`}>
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : assigned ? <Check className="h-3.5 w-3.5" /> : null}
                      {assigned ? '역할 제거' : '역할 부여'}
                    </button>
                  </div>
                  <h2 className="mt-4 text-base font-bold text-white">{role.displayName}</h2>
                  <p className="mt-1 font-mono text-xs text-slate-500">{role.code}</p>
                  <p className="mt-3 min-h-10 text-sm leading-5 text-slate-400">{role.description || '이 역할에 연결된 운영 권한입니다.'}</p>
                  <div className="mt-4 flex flex-wrap gap-1.5">{role.permissions.length ? role.permissions.map((permission) => <span key={permission} className="rounded-md border border-white/[0.08] bg-black/20 px-2 py-1 font-mono text-[10px] text-slate-400">{permission}</span>) : <span className="text-xs text-slate-600">연결된 세부 권한 없음</span>}</div>
                </article>
              );
            })}
          </section>
        </>
      ) : null}
    </div>
  );
}

'use client';

import { Loader2, ShieldX } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useMemo } from 'react';
import { useAuth } from '../providers/auth-context';
import { PrivilegedActionGate } from '../auth/privileged-action-gate';
import type { MfaStepUpPurpose } from '../../lib/auth-client';

export function AdminAccessGate({ children }: { readonly children: ReactNode }) {
  const { account, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const purpose = useMemo(() => adminStepUpPurpose(pathname), [pathname]);
  const hasAccess = useMemo(() => {
    if (!account) return false;
    const roles = account.access?.roles ?? [];
    const permissions = account.access?.permissions ?? [];
    const isGlobalAdmin = Boolean(
      roles.includes('owner') || roles.includes('admin'),
    );
    if (pathname.startsWith('/admin/users/') && pathname.endsWith('/security')) {
      return permissions.includes('admin.account.suspend');
    }
    if (pathname.startsWith('/admin/users/') && pathname.endsWith('/roles')) return isGlobalAdmin;
    if (pathname === '/admin/users') return isGlobalAdmin || permissions.includes('admin.account.suspend');
    if (isGlobalAdmin || pathname === '/admin') {
      return isGlobalAdmin || permissions.some((permission) => permission.endsWith('.admin')) || permissions.includes('admin.account.suspend');
    }
    if (pathname.startsWith('/admin/support')) return roles.includes('support_agent') || permissions.includes('support.admin');
    if (pathname.startsWith('/admin/reviews')) return roles.includes('moderator') || permissions.includes('review.moderate');
    if (pathname.startsWith('/admin/account-deletions')) return permissions.includes('admin.account.delete');
    if (pathname.startsWith('/admin/account-merges')) return permissions.includes('admin.account.merge');
    if (pathname.startsWith('/admin/wiki/users')) return permissions.includes('wiki.user.block');
    if (pathname.startsWith('/admin/wiki/batch-rollback')) return permissions.includes('wiki.batch_rollback');
    if (pathname.startsWith('/admin/wiki/reports')) return permissions.includes('wiki.report.moderate');
    if (pathname.startsWith('/admin/wiki/acl')) return permissions.includes('wiki.acl.manage');
    if (pathname.startsWith('/admin/wiki')) return permissions.includes('wiki.admin');
    if (pathname.startsWith('/admin/audit')) return isGlobalAdmin || permissions.includes('admin.audit.read');
    return false;
  }, [account, pathname]);

  useEffect(() => {
    if (loading) return;
    if (!account) {
      router.replace(`/login?returnTo=${encodeURIComponent(pathname)}`);
    }
  }, [account, loading, pathname, router]);

  if (loading || !account) {
    return (
      <div className="flex min-h-[55vh] items-center justify-center gap-2 text-sm text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin text-[#35e5b7]" /> 운영 권한을 확인하는 중
      </div>
    );
  }

  if (!hasAccess) {
    return (
      <section className="mx-auto max-w-xl rounded-2xl border border-red-400/20 bg-red-500/10 p-8 text-center">
        <ShieldX className="mx-auto h-10 w-10 text-red-200" />
        <h1 className="mt-4 text-xl font-extrabold text-white">접근 권한이 없습니다</h1>
        <p className="mt-2 text-sm leading-6 text-red-100/80">
          이 운영 화면에 필요한 역할 또는 세부 권한이 계정에 없습니다.
        </p>
        <button type="button" onClick={() => router.replace('/')} className="mt-5 rounded-lg border border-white/10 bg-black/20 px-4 py-2 text-sm font-bold text-white transition hover:bg-black/30">
          홈으로 돌아가기
        </button>
      </section>
    );
  }

  if (purpose) {
    return (
      <PrivilegedActionGate
        purpose={purpose}
        title="관리 작업 잠금 해제"
        description="권한은 확인되었습니다. 민감한 정보와 변경 작업을 보호하기 위해 등록된 인증 앱 또는 복구 코드로 한 번 더 확인해 주세요."
      >
        {children}
      </PrivilegedActionGate>
    );
  }

  return children;
}

function adminStepUpPurpose(pathname: string): MfaStepUpPurpose | null {
  if (pathname.startsWith('/admin/wiki')) return 'wiki_admin';
  if (pathname.startsWith('/admin/users/') && pathname.endsWith('/roles')) return 'role_admin';
  if (pathname.startsWith('/admin/users')) return 'account_moderation';
  if (pathname.startsWith('/admin/reviews')) return 'review_moderation';
  if (pathname.startsWith('/admin/account-deletions')) return 'account_delete_admin';
  if (pathname.startsWith('/admin/account-merges')) return 'account_merge_admin';
  if (pathname.startsWith('/admin/billing')) return 'server_admin';
  if (pathname.startsWith('/admin/audit')) return 'audit_read';
  return null;
}

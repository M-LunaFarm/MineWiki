import type { Metadata } from 'next';
import { AdminRoleEditor } from '../../../../../components/admin/admin-role-editor';

export const metadata: Metadata = {
  title: '사용자 역할 관리',
  robots: { index: false, follow: false },
};

interface AdminUserRolesPageProps {
  readonly params: Promise<{ accountId: string }>;
}

export default async function AdminUserRolesPage({ params }: AdminUserRolesPageProps) {
  const { accountId } = await params;
  return <AdminRoleEditor accountId={accountId} />;
}

import type { Metadata } from 'next';
import { AdminAccountSecurity } from '../../../../../components/admin/admin-account-security';

export const metadata: Metadata = {
  title: '계정 보안 조치',
  robots: { index: false, follow: false },
};

interface AdminUserSecurityPageProps {
  readonly params: Promise<{ accountId: string }>;
}

export default async function AdminUserSecurityPage({ params }: AdminUserSecurityPageProps) {
  const { accountId } = await params;
  return <AdminAccountSecurity accountId={accountId} />;
}

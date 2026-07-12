import type { Metadata } from 'next';
import { AdminUserDirectory } from '../../../components/admin/admin-user-directory';

export const metadata: Metadata = {
  title: '사용자 및 역할',
  robots: { index: false, follow: false },
};

export default function AdminUsersPage() {
  return <AdminUserDirectory />;
}

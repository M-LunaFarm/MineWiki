import type { Metadata } from 'next';
import { AccountDeletionConsole } from '../../../components/admin/account-deletion-console';

export const metadata: Metadata = {
  title: '계정 종료 운영',
  robots: { index: false, follow: false },
};

export default function AdminAccountDeletionsPage() {
  return <AccountDeletionConsole />;
}

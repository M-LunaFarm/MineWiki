import type { Metadata } from 'next';
import { AccountMergeConsole } from '../../../components/admin/account-merge-console';

export const metadata: Metadata = {
  title: '계정 연결 검토',
  robots: { index: false, follow: false },
};

export default function AdminAccountMergesPage() {
  return <AccountMergeConsole />;
}

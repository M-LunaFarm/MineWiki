import type { Metadata } from 'next';
import { AuditConsole } from '../../../components/admin/audit-console';

export const metadata: Metadata = {
  title: '감사 이벤트',
  robots: { index: false, follow: false }
};

export default function AdminAuditPage() {
  return <AuditConsole />;
}

import type { Metadata } from 'next';
import { ServerWikiEntitlementConsole } from '../../../components/admin/server-wiki-entitlement-console';

export const metadata: Metadata = {
  title: '서버 위키 요금제 권한',
  robots: { index: false, follow: false },
};

export default function AdminBillingPage() {
  return <ServerWikiEntitlementConsole />;
}

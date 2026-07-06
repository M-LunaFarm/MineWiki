import type { Metadata } from 'next';
import { WikiAdminConsole } from '../../../components/wiki/wiki-admin-console';

export const metadata: Metadata = {
  title: '위키 관리',
  robots: { index: false, follow: false }
};

export default function AdminWikiPage() {
  return <WikiAdminConsole view="overview" />;
}

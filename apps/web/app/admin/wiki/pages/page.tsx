import type { Metadata } from 'next';
import { WikiAdminConsole } from '../../../../components/wiki/wiki-admin-console';

export const metadata: Metadata = {
  title: '위키 문서 관리',
  robots: { index: false, follow: false }
};

export default function AdminWikiPagesPage() {
  return <WikiAdminConsole view="pages" />;
}

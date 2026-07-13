import type { Metadata } from 'next';
import { WikiUserAdmin } from '../../../../components/wiki/wiki-user-admin';

export const metadata: Metadata = { title: '위키 사용자 차단', robots: { index: false, follow: false } };

export default function AdminWikiUsersPage() {
  return <WikiUserAdmin />;
}

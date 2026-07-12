import type { Metadata } from 'next';

import { WikiAclConsole } from '../../../../components/wiki/wiki-acl-console';

export const metadata: Metadata = {
  title: '위키 ACL 관리',
  robots: { index: false, follow: false },
};

export default function AdminWikiAclPage() {
  return <WikiAclConsole />;
}

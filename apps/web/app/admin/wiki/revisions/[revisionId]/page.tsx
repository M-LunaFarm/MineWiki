import type { Metadata } from 'next';
import { WikiAdminRevisionDetailConsole } from '../../../../../components/wiki/wiki-admin-revision-console';

export const metadata: Metadata = {
  title: '위키 판 상세 관리',
  robots: { index: false, follow: false }
};

export default async function AdminWikiRevisionPage({ params }: { readonly params: Promise<{ revisionId: string }> }) {
  const { revisionId } = await params;
  return <WikiAdminRevisionDetailConsole revisionId={revisionId} />;
}

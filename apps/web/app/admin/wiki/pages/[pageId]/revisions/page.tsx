import type { Metadata } from 'next';
import { WikiAdminRevisionList } from '../../../../../../components/wiki/wiki-admin-revision-console';

export const metadata: Metadata = {
  title: '위키 판 관리',
  robots: { index: false, follow: false }
};

export default async function AdminWikiPageRevisionsPage({ params }: { readonly params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  return <WikiAdminRevisionList pageId={pageId} />;
}

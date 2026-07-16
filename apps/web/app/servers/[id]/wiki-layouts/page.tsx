import type { Metadata } from 'next';

import { ServerWikiSettings } from '../../../../components/wiki/server-wiki-settings';
import { SiteHeader } from '../../../../components/layout/site-header';

export const metadata: Metadata = {
  title: '서버 위키 설정',
  robots: { index: false, follow: false },
};

export default async function ServerWikiLayoutsPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <><SiteHeader /><main className="mx-auto w-full max-w-[1440px] px-4 pb-16 pt-28 sm:px-6 lg:px-8"><ServerWikiSettings serverId={id} /></main></>;
}

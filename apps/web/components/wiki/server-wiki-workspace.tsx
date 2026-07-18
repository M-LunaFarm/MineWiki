import Link from 'next/link';
import type { ReactNode } from 'react';
import type { WikiPageResponse } from '../../lib/wiki-api';
import { ServerWikiHeader } from './server-wiki-header';
import { ServerWikiSidebar } from './server-wiki-sidebar';
import { fetchServerWikiNavigation } from '../../lib/wiki-server-api';

export async function ServerWikiWorkspace({
  page,
  section,
  children
}: {
  readonly page: WikiPageResponse;
  readonly section: string;
  readonly children: ReactNode;
}) {
  const wiki = page.serverWiki;
  const navigationResponse = wiki
    ? await fetchServerWikiNavigation(wiki.contentSlug, wiki.navigationKey).catch(() => null)
    : null;
  const pageWithNavigation: WikiPageResponse = wiki ? {
    ...page,
    serverWiki: {
      ...wiki,
      navigation: (navigationResponse?.items ?? wiki.navigation).map((item) => ({
        ...item,
        current: item.kind === 'page' && item.id === page.id,
      })),
    },
  } : page;
  return (
    <div className="server-wiki-layout min-h-screen bg-white text-[#333]">
      <ServerWikiHeader page={pageWithNavigation} />
      <main className="mx-auto grid w-full max-w-[1440px] grid-cols-[minmax(0,1fr)] lg:grid-cols-[288px_minmax(0,1fr)]">
        <ServerWikiSidebar page={pageWithNavigation} />
        <section className="min-w-0 px-5 py-8 sm:px-8 lg:px-12 lg:py-10 xl:px-16">
          <nav className="mb-6 flex flex-wrap items-center gap-2 text-sm text-[#777]" aria-label="현재 위치">
            <Link href={`/serverWiki/${encodeURIComponent(pageWithNavigation.serverWiki?.slug ?? '')}`} className="hover:text-[#346ddb]">{pageWithNavigation.serverWiki?.name}</Link>
            <span>/</span>
            <Link href={serverDocumentPath(pageWithNavigation)} className="hover:text-[#346ddb]">{page.displayTitle}</Link>
            <span>/</span>
            <span className="text-[#333]">{section}</span>
          </nav>
          {children}
        </section>
      </main>
    </div>
  );
}

function serverDocumentPath(page: WikiPageResponse): string {
  return page.serverWiki?.navigation.find((item) => item.current)?.path
    ?? `/serverWiki/${encodeURIComponent(page.serverWiki?.slug ?? '')}`;
}

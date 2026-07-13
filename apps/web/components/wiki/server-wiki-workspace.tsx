import Link from 'next/link';
import type { ReactNode } from 'react';
import type { WikiPageResponse } from '../../lib/wiki-api';
import { ServerWikiSidebar } from './server-wiki-sidebar';

export function ServerWikiWorkspace({
  page,
  section,
  children
}: {
  readonly page: WikiPageResponse;
  readonly section: string;
  readonly children: ReactNode;
}) {
  return (
    <main className="server-wiki-layout min-h-[calc(100vh-4rem)] bg-[#0b0e12] text-slate-200">
      <div className="mx-auto grid w-full max-w-[1600px] grid-cols-[minmax(0,1fr)] lg:grid-cols-[330px_minmax(0,1fr)]">
        <ServerWikiSidebar page={page} />
        <section className="min-w-0 px-4 py-7 sm:px-8 lg:px-12 lg:py-10 xl:px-16">
          <nav className="mb-6 flex flex-wrap items-center gap-2 text-sm text-slate-500" aria-label="현재 위치">
            <Link href={`/server/${encodeURIComponent(page.serverWiki?.slug ?? '')}`} className="hover:text-emerald-300">{page.serverWiki?.name}</Link>
            <span>/</span>
            <Link href={serverDocumentPath(page)} className="hover:text-emerald-300">{page.displayTitle}</Link>
            <span>/</span>
            <span className="text-slate-300">{section}</span>
          </nav>
          {children}
        </section>
      </div>
    </main>
  );
}

function serverDocumentPath(page: WikiPageResponse): string {
  return page.serverWiki?.navigation.find((item) => item.current)?.path
    ?? `/server/${encodeURIComponent(page.serverWiki?.slug ?? '')}`;
}

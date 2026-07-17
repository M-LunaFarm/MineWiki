import Link from 'next/link';
import { BookOpen, ExternalLink, Search } from 'lucide-react';
import type { WikiPageResponse } from '../../lib/wiki-api';

export function ServerWikiHeader({ page }: { readonly page: WikiPageResponse }) {
  const wiki = page.serverWiki;
  if (!wiki) return null;

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-[#0b0e12]/95 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-[1600px] items-center gap-3 px-4 sm:px-6">
        <Link
          href={`/server/${encodeURIComponent(wiki.slug)}`}
          className="flex min-w-0 items-center gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-emerald-400/25 bg-emerald-400/10 text-emerald-300">
            <BookOpen className="size-4.5" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold text-white sm:text-base">{wiki.name}</span>
            <span className="hidden text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 sm:block">Documentation</span>
          </span>
        </Link>

        <form action={`/server/${encodeURIComponent(wiki.slug)}/_search`} className="ml-auto hidden w-full max-w-md md:block">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
            <span className="sr-only">서버 문서 검색</span>
            <input
              type="search"
              name="q"
              placeholder={`${wiki.name} 문서 검색`}
              className="h-10 w-full rounded-lg border border-white/10 bg-white/[0.035] pl-10 pr-3 text-sm text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-emerald-300/40 focus:bg-white/[0.055]"
            />
          </label>
        </form>

        <Link
          href={page.serverDirectoryPath ?? '/servers'}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-white/10 px-3 text-xs font-semibold text-slate-400 transition hover:border-white/20 hover:text-white sm:text-sm"
        >
          서버 정보
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
    </header>
  );
}

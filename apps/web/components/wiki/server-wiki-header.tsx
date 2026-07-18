import Link from 'next/link';
import { BookOpen, ExternalLink, History, Menu, Search } from 'lucide-react';
import type { WikiPageResponse } from '../../lib/wiki-api';
import { ServerWikiNavigation } from './server-wiki-navigation';

export function ServerWikiHeader({ page }: { readonly page: WikiPageResponse }) {
  const wiki = page.serverWiki;
  if (!wiki) return null;
  const rootPath = `/serverWiki/${encodeURIComponent(wiki.slug)}`;

  return (
    <header className="sticky top-0 z-50 border-b border-[#e6e6e6] bg-white/95 text-[#1f1f1f] backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-[1440px] items-center gap-3 px-4 sm:px-6">
        <details className="group relative lg:hidden">
          <summary className="grid size-10 cursor-pointer list-none place-items-center rounded-lg text-[#666] transition hover:bg-[#f5f5f5] hover:text-[#1f1f1f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#346ddb]/30 [&::-webkit-details-marker]:hidden">
            <Menu className="size-5" aria-hidden="true" />
            <span className="sr-only">문서 메뉴 열기</span>
          </summary>
          <div className="fixed inset-x-0 top-16 max-h-[calc(100vh-4rem)] overflow-y-auto border-b border-[#e6e6e6] bg-white px-4 py-4 shadow-xl">
            <form action={`${rootPath}/_search`} className="mb-4">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#888]" aria-hidden="true" />
                <span className="sr-only">서버 문서 검색</span>
                <input type="search" name="q" placeholder={`${wiki.name} 문서 검색`} className="h-10 w-full rounded-lg border border-[#dedede] bg-[#fafafa] pl-10 pr-3 text-sm outline-none placeholder:text-[#999] focus:border-[#9ab5ef] focus:bg-white" />
              </label>
            </form>
            <ServerWikiNavigation items={wiki.navigation} storageKey={`minewiki:server-wiki:${wiki.slug}:mobile-collapsed`} />
          </div>
        </details>
        <Link
          href={rootPath}
          className="flex min-w-0 items-center gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[#346ddb]/30"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#346ddb] text-white">
            <BookOpen className="size-4.5" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-[#202020] sm:text-base">{wiki.name}</span>
            <span className="hidden text-[11px] text-[#7a7a7a] sm:block">Documentation</span>
          </span>
        </Link>

        <form action={`${rootPath}/_search`} className="ml-auto hidden w-full max-w-md md:block">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#888]" aria-hidden="true" />
            <span className="sr-only">서버 문서 검색</span>
            <input
              type="search"
              name="q"
              placeholder={`${wiki.name} 문서 검색`}
              className="h-10 w-full rounded-lg border border-[#dedede] bg-[#fafafa] pl-10 pr-3 text-sm text-[#252525] outline-none transition placeholder:text-[#999] focus:border-[#9ab5ef] focus:bg-white"
            />
          </label>
        </form>

        <Link
          href={`${rootPath}/_changes`}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-xs font-medium text-[#666] transition hover:bg-[#f5f5f5] hover:text-[#202020] sm:text-sm"
        >
          <History className="size-3.5" aria-hidden="true" />
          변경 기록
        </Link>

        <Link
          href={page.serverDirectoryPath ?? '/servers'}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-xs font-medium text-[#666] transition hover:bg-[#f5f5f5] hover:text-[#202020] sm:text-sm"
        >
          서버 정보
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
    </header>
  );
}

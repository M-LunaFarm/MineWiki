import Link from 'next/link';
import { ArrowLeft, BookOpen } from 'lucide-react';
import type { WikiPageResponse } from '../../lib/wiki-api';
import { ServerWikiCreateLink } from './server-wiki-create-link';
import { ServerWikiNavigation } from './server-wiki-navigation';

export function ServerWikiSidebar({ page }: { readonly page: WikiPageResponse }) {
  const wiki = page.serverWiki;
  if (!wiki) return null;
  const address = wiki.host ? `${wiki.host}${wiki.port && wiki.port !== 25565 ? `:${wiki.port}` : ''}` : null;

  return (
    <aside className="min-w-0 border-white/10 lg:sticky lg:top-16 lg:h-[calc(100vh-4rem)] lg:border-r">
      <div className="border-b border-white/10 px-5 py-5 lg:px-6 lg:py-7">
        <Link href={`/server/${encodeURIComponent(wiki.slug)}`} className="flex items-center gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60">
          <span className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-2 text-emerald-300">
            <BookOpen className="size-5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-display text-lg font-bold text-white">{wiki.name}</span>
            <span className="mt-0.5 block text-xs text-slate-500">서버 위키</span>
          </span>
        </Link>
        <div className="mt-4 flex items-center justify-between gap-3 text-xs">
          <span className={wiki.isOnline ? 'text-emerald-300' : 'text-slate-500'}>
            <span className={`mr-2 inline-block size-2 rounded-full ${wiki.isOnline ? 'bg-emerald-400' : 'bg-slate-600'}`} />
            {wiki.isOnline ? '온라인' : wiki.isOnline === false ? '오프라인' : '확인 중'}
          </span>
          <span className="truncate text-slate-400">
            {wiki.playersOnline !== null && wiki.playersMax !== null
              ? `${wiki.playersOnline} / ${wiki.playersMax}`
              : wiki.supportedVersions ?? wiki.edition}
          </span>
        </div>
      </div>

      <nav className="px-4 py-3 lg:max-h-[calc(100vh-18rem)] lg:overflow-y-auto lg:py-5" aria-label={`${wiki.name} 위키 문서 트리`}>
        <div className="hidden items-center gap-2 px-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 lg:flex">
          <BookOpen className="size-4" />
          문서
        </div>
        <ServerWikiNavigation items={wiki.navigation} storageKey={`minewiki:server-wiki:${wiki.slug}:collapsed`} />
        <div className="mt-3">
          <ServerWikiCreateLink serverSlug={wiki.slug} />
        </div>
        {address ? <p className="mt-4 hidden break-all px-2 font-mono text-xs text-slate-600 lg:block">{address}</p> : null}
      </nav>

      <div className="hidden px-6 pb-6 lg:absolute lg:inset-x-0 lg:bottom-0 lg:block">
        <Link
          href={page.serverDirectoryPath ?? '/servers'}
          className="flex items-center justify-center gap-2 rounded-lg border border-white/10 px-4 py-3 text-sm text-slate-400 transition hover:border-white/20 hover:text-white"
        >
          <ArrowLeft className="size-4" />
          서버 상세로 돌아가기
        </Link>
      </div>
    </aside>
  );
}

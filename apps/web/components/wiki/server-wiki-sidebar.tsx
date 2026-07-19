import Link from 'next/link';
import { BookOpen, Compass, MessagesSquare, Star } from 'lucide-react';
import type { ServerWikiPresentation, WikiPageResponse } from '../../lib/wiki-api';
import { ServerWikiCreateLink } from './server-wiki-create-link';
import { ServerWikiNavigation } from './server-wiki-navigation';
import { serverWikiPlatformUrl, serverWikiPublicPath, type ServerWikiPublicRouteContext } from '../../lib/server-wiki-public-route';

export function ServerWikiSidebar({ page, presentation, routeContext }: { readonly page: WikiPageResponse; readonly presentation?: ServerWikiPresentation | null; readonly routeContext?: ServerWikiPublicRouteContext | null }) {
  const wiki = page.serverWiki;
  if (!wiki) return null;
  const rootPath = serverWikiPublicPath(`/serverWiki/${encodeURIComponent(wiki.slug)}`, routeContext);
  const address = wiki.host ? `${wiki.host}${wiki.port && wiki.port !== 25565 ? `:${wiki.port}` : ''}` : null;
  const brand = presentation?.branding;
  const displayName = brand?.name || wiki.name;

  return (
    <aside className="hidden min-w-0 border-[#e8e8e8] bg-[#fbfbfb] lg:sticky lg:top-16 lg:block lg:h-[calc(100vh-4rem)] lg:border-r">
      <div className="border-b border-[#e8e8e8] px-6 py-6">
        <Link href={rootPath} className="flex items-center gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[#346ddb]/30">
          {brand?.logoUrl ? <img src={brand.logoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-9 rounded-lg object-contain" /> : <span className="rounded-lg bg-[#eef3ff] p-2 text-[#346ddb]" style={{ color: brand?.accentColor ?? undefined }}><BookOpen className="size-5" /></span>} {/* eslint-disable-line @next/next/no-img-element -- tenant-controlled HTTPS assets cannot use a static Next image allowlist */}
          <span className="min-w-0">
            <span className="block truncate text-base font-semibold text-[#242424]">{displayName}</span>
            <span className="mt-0.5 block text-xs text-[#777]">서버 위키</span>
          </span>
        </Link>
        <div className="mt-4 flex items-center justify-between gap-3 text-xs">
          <span className={wiki.isOnline ? 'text-[#25845a]' : 'text-[#777]'}>
            <span className={`mr-2 inline-block size-2 rounded-full ${wiki.isOnline ? 'bg-[#32a56f]' : 'bg-[#aaa]'}`} />
            {wiki.isOnline ? '온라인' : wiki.isOnline === false ? '오프라인' : '확인 중'}
          </span>
          <span className="truncate text-[#777]">
            {wiki.playersOnline !== null && wiki.playersMax !== null
              ? `${wiki.playersOnline} / ${wiki.playersMax}`
              : wiki.supportedVersions ?? wiki.edition}
          </span>
        </div>
      </div>

      <nav className="flex h-[calc(100vh-13rem)] flex-col px-4 py-5" aria-label={`${displayName} 위키 문서 트리`}>
        <div className="flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#888]">
          <BookOpen className="size-4" />
          문서
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1"><ServerWikiNavigation items={wiki.navigation} storageKey={`minewiki:server-wiki:${wiki.slug}:collapsed`} /></div>
        <div className="mt-3 space-y-1 border-t border-[#e8e8e8] pt-3">
          <Link href={serverWikiPublicPath(`/serverWiki/${encodeURIComponent(wiki.slug)}/_discussions`, routeContext)} className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-xs font-medium text-[#666] hover:bg-[#f0f3f8] hover:text-[#346ddb]"><MessagesSquare className="size-3.5" /> 토론</Link>
          <Link href={routeContext ? serverWikiPlatformUrl(`/serverWiki/${encodeURIComponent(wiki.slug)}/_watchlist`) : `/serverWiki/${encodeURIComponent(wiki.slug)}/_watchlist`} className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-xs font-medium text-[#666] hover:bg-[#f0f3f8] hover:text-[#346ddb]"><Star className="size-3.5" /> 관심 문서</Link>
          <Link href={serverWikiPublicPath(`/serverWiki/${encodeURIComponent(wiki.slug)}/_special`, routeContext)} className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-xs font-medium text-[#666] hover:bg-[#f0f3f8] hover:text-[#346ddb]"><Compass className="size-3.5" /> 특수 문서</Link>
        </div>
        <div className="mt-3">
          {routeContext ? <Link href={serverWikiPlatformUrl(`/serverWiki/${encodeURIComponent(wiki.slug)}/_tools/edit/새-문서`)} className="flex min-h-11 items-center rounded-lg px-2 text-xs font-semibold text-[#346ddb] hover:bg-[#edf3ff]">MineWiki에서 문서 작성</Link> : <ServerWikiCreateLink serverSlug={wiki.slug} />}
        </div>
        {address ? <p className="mt-4 break-all px-2 font-mono text-xs text-[#888]">{address}</p> : null}
        <a href="https://github.com/GitbookIO/gitbook" target="_blank" rel="noreferrer" className="mt-4 border-t border-[#e8e8e8] px-2 pt-4 text-xs text-[#888] hover:text-[#346ddb]">GitBook 스타일의 서버 문서</a>
      </nav>

    </aside>
  );
}

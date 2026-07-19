import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { WikiRoutePage } from '../../../components/wiki/wiki-route-page';
import { WikiEditRoutePage } from '../../../components/wiki/wiki-edit-route-page';
import { WikiHistoryRoutePage } from '../../../components/wiki/wiki-history-route-page';
import { ServerWikiToolRoutePage } from '../../../components/wiki/server-wiki-tool-route-page';
import { ServerWikiSearchPage } from '../../../components/wiki/server-wiki-search-page';
import { ServerWikiRecentPage } from '../../../components/wiki/server-wiki-recent-page';
import { parseServerWikiToolRoute } from '../../../lib/wiki-routes.mjs';
import { buildWikiRoutePath } from '../../../lib/wiki-routes.mjs';
import { fetchPublicServerWikiPresentation, fetchPublicWikiPageByPath } from '../../../lib/wiki-server-api';
import { createPageMetadata, DEFAULT_SITE_DESCRIPTION } from '../../../lib/metadata';
import {
  readServerWikiPublicRouteContext,
  serverWikiCanonicalUrl,
  serverWikiPublicPath,
} from '../../../lib/server-wiki-public-route';

interface PageProps {
  readonly params: Promise<{ path?: string[] }>;
  readonly searchParams: Promise<{ q?: string; target?: string; cursor?: string }>;
}

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Pick<PageProps, 'params'>): Promise<Metadata> {
  const path = (await params).path ?? [];
  const routePath = buildWikiRoutePath('serverWiki', path);
  const routeContext = readServerWikiPublicRouteContext(await headers(), path[0]);
  const canonicalPath = serverWikiCanonicalUrl(routePath, routeContext);
  if (path.length === 0 || path[1] === '_search' || path[1] === '_changes' || parseServerWikiToolRoute(path)) {
    return createPageMetadata({
      title: '서버 위키 도구',
      description: DEFAULT_SITE_DESCRIPTION,
      path: canonicalPath,
      noIndex: true,
    });
  }
  try {
    const page = await fetchPublicWikiPageByPath(routePath);
    if (!page?.serverWiki || page.serverWiki.publicationStatus !== 'published') {
      return createPageMetadata({ title: '서버 위키', description: DEFAULT_SITE_DESCRIPTION, path: canonicalPath, noIndex: true });
    }
    const presentation = await fetchPublicServerWikiPresentation(page.serverWiki.contentSlug);
    const siteTitle = presentation?.seoTitle ?? `${page.serverWiki.name} 위키`;
    const description = presentation?.seoDescription
      ?? metadataDescription(page.html, page.serverWiki.directoryOverview?.shortDescription);
    return createPageMetadata({
      title: `${page.displayTitle} | ${siteTitle}`,
      description,
      path: canonicalPath,
      imageTitle: page.displayTitle,
      imageDescription: description,
      noIndex: presentation?.seoIndexingEnabled === false,
    });
  } catch {
    return createPageMetadata({ title: '서버 위키', description: DEFAULT_SITE_DESCRIPTION, path: canonicalPath, noIndex: true });
  }
}

export default async function ServerWikiSitePage({ params, searchParams }: PageProps) {
  const resolvedParams = await params;
  const path = resolvedParams.path ?? [];
  const routeContext = readServerWikiPublicRouteContext(await headers(), path[0]);
  if (path.length === 2 && path[1] === '_search') {
    return <ServerWikiSearchPage slug={path[0] ?? ''} routePrefix="serverWiki" routeContext={routeContext} searchParams={await searchParams} />;
  }
  if (path.length === 2 && path[1] === '_changes') {
    return <ServerWikiRecentPage slug={path[0] ?? ''} routeContext={routeContext} />;
  }
  const toolRoute = parseServerWikiToolRoute(path);
  if (toolRoute?.tool === 'raw' || toolRoute?.tool === 'backlinks' || toolRoute?.tool === 'discuss' || toolRoute?.tool === 'requests' || toolRoute?.tool === 'blame' || toolRoute?.tool === 'acl') {
    return <ServerWikiToolRoutePage segments={toolRoute.documentSegments} routePrefix="serverWiki" tool={toolRoute.tool} />;
  }
  if (toolRoute?.tool === 'edit') {
    return <WikiEditRoutePage prefix="serverWiki" segments={toolRoute.documentSegments} />;
  }
  if (toolRoute?.tool === 'history') {
    return <WikiHistoryRoutePage prefix="serverWiki" segments={toolRoute.documentSegments} />;
  }
  return <WikiRoutePage prefix="serverWiki" segments={resolvedParams.path} serverWikiRouteContext={routeContext} />;
}

function metadataDescription(html: string, fallback?: string | null): string {
  const plain = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&(?:nbsp|#160);/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#(?:39|x27);/giu, "'")
    .replace(/[\u0000-\u001F\u007F]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return (plain || fallback?.trim() || DEFAULT_SITE_DESCRIPTION).slice(0, 200);
}

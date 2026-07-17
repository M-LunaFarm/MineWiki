import { notFound } from 'next/navigation';
import { fetchWikiBacklinks, fetchWikiCategory, fetchWikiPageByPath, fetchWikiPublicProfile, fetchWikiPublicStats, fetchWikiRecent, fetchWikiSpecial } from '../../lib/wiki-server-api';
import { buildWikiRoutePath, decodeWikiRouteSegment } from '../../lib/wiki-routes.mjs';
import { WikiArticleView } from './wiki-article-view';
import { WikiNamespaceFrontPage } from './wiki-namespace-front-page';
import { ServerWikiArticleView } from './server-wiki-article-view';
import { WikiUserProfileHeader, WikiUserProfileHub } from './wiki-user-profile-header';
import { WikiDocumentContext } from './wiki-document-context';

interface WikiRoutePageProps {
  readonly prefix: 'wiki' | 'mod' | 'modpack' | 'server' | 'dev' | 'guide' | 'data' | 'help' | 'project' | 'template' | 'user' | 'category' | 'file';
  readonly segments?: string[];
}

export async function WikiRoutePage({ prefix, segments = [] }: WikiRoutePageProps) {
  const routePath = buildWikiRoutePath(prefix, segments);
  const page = await fetchWikiPageByPath(routePath);
  if (prefix === 'user') {
    const username = segments[0] ? decodeWikiRouteSegment(segments[0]) : '';
    const profile = username ? await fetchWikiPublicProfile(username) : null;
    if (!profile) notFound();
    if (!page) return <WikiUserProfileHub profile={profile} requestedDocumentPath={segments.length > 1 ? routePath : undefined} />;
    return (
      <WikiArticleView
        page={page}
        routePath={routePath}
        beforeContent={<WikiUserProfileHeader profile={profile} current="document" />}
      />
    );
  }
  if (!page) {
    notFound();
  }
  if (prefix === 'server' && page.serverWiki) {
    return <ServerWikiArticleView page={page} routePath={routePath} />;
  }
  if (page.title === '대문' && isStandardFrontPagePrefix(prefix)) {
    const namespace = prefix === 'wiki' ? 'main' : prefix;
    const [statsResult, recentResult, featuredResult] = await Promise.allSettled([
      fetchWikiPublicStats(namespace),
      fetchWikiRecent({ namespace }),
      fetchWikiSpecial({ type: 'long', namespace, limit: 7 }),
    ]);
    const pageCount = statsResult.status === 'fulfilled' ? statsResult.value.pageCount : 0;
    const recent = recentResult.status === 'fulfilled' ? recentResult.value.items : [];
    const featured = featuredResult.status === 'fulfilled' ? featuredResult.value.items : [];
    return (
      <WikiArticleView
        page={page}
        routePath={routePath}
        afterContent={<WikiNamespaceFrontPage namespace={namespace} routePath={routePath} pageCount={pageCount} recent={recent} featured={featured} showSearch={!page.html.includes('class="search-page"')} />}
      />
    );
  }
  const [backlinksResults, categoryResults] = await Promise.all([
    Promise.allSettled([fetchWikiBacklinks(page.id, 8)]),
    Promise.allSettled(page.categories.slice(0, 3).map((category) => fetchWikiCategory({ category, limit: 8 }))),
  ]);
  const backlinksResult = backlinksResults[0];
  const backlinks = backlinksResult.status === 'fulfilled' ? backlinksResult.value.items : [];
  const related = categoryResults.flatMap((result) => result.status === 'fulfilled' ? result.value.items : []);
  return (
    <WikiArticleView
      page={page}
      routePath={routePath}
      afterContent={<WikiDocumentContext currentPageId={page.id} backlinks={backlinks} related={related} />}
    />
  );
}

function isStandardFrontPagePrefix(prefix: WikiRoutePageProps['prefix']): boolean {
  return !['server', 'user', 'category'].includes(prefix);
}

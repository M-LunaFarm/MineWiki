import { notFound } from 'next/navigation';
import { fetchWikiPageByPath, fetchWikiPublicProfile } from '../../lib/wiki-server-api';
import { buildWikiRoutePath, decodeWikiRouteSegment } from '../../lib/wiki-routes.mjs';
import { WikiArticleView } from './wiki-article-view';
import { ServerWikiArticleView } from './server-wiki-article-view';
import { WikiUserProfileHeader, WikiUserProfileHub } from './wiki-user-profile-header';

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
  return <WikiArticleView page={page} routePath={routePath} />;
}

import { notFound } from 'next/navigation';
import { fetchWikiPageByPath } from '../../lib/wiki-server-api';
import { buildWikiRoutePath } from '../../lib/wiki-routes.mjs';
import { WikiBacklinksClient } from './wiki-backlinks-client';
import { WikiBlameClient } from './wiki-blame-client';
import { WikiDiscussionClient } from './wiki-discussion-client';
import { WikiEditRequestsClient } from './wiki-edit-requests-client';
import { WikiRawClient } from './wiki-raw-client';
import { WikiPageAclClient } from './wiki-page-acl-client';
import { ServerWikiWorkspace } from './server-wiki-workspace';

export async function ServerWikiToolRoutePage({
  segments,
  tool
}: {
  readonly segments: string[];
  readonly tool: 'raw' | 'backlinks' | 'discuss' | 'requests' | 'blame' | 'acl';
}) {
  const routePath = buildWikiRoutePath('server', segments);
  const page = await fetchWikiPageByPath(routePath);
  if (!page?.serverWiki) notFound();

  const section = tool === 'raw' ? '원문' : tool === 'backlinks' ? '역링크' : tool === 'discuss' ? '토론' : tool === 'requests' ? '편집 요청' : tool === 'acl' ? 'ACL' : '행별 기여 기록';
  const content = tool === 'raw'
    ? <WikiRawClient pageId={page.id} returnTo={routePath} />
    : tool === 'backlinks'
      ? <WikiBacklinksClient pageId={page.id} returnTo={routePath} />
      : tool === 'discuss'
        ? <WikiDiscussionClient pageId={page.id} returnTo={routePath} />
        : tool === 'requests'
          ? <WikiEditRequestsClient pageId={page.id} returnTo={routePath} />
          : tool === 'acl'
            ? <WikiPageAclClient pageId={page.id} returnTo={routePath} compactHeader />
            : <WikiBlameClient pageId={page.id} returnTo={routePath} />;

  return <ServerWikiWorkspace page={page} section={section}>{content}</ServerWikiWorkspace>;
}

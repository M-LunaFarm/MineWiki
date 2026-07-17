import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaService } from '../common/prisma.service';
import { buildCanonicalServerWikiPath, WikiRoutePathResolver } from './wiki-route-path.resolver';

test('canonical server wiki paths remove only the owning server slug prefix', () => {
  assert.equal(buildCanonicalServerWikiPath('alpha', 'alpha'), '/server/alpha');
  assert.equal(buildCanonicalServerWikiPath('alpha', 'alpha/가이드/첫 문서'), '/server/alpha/%EA%B0%80%EC%9D%B4%EB%93%9C/%EC%B2%AB_%EB%AC%B8%EC%84%9C');
  assert.equal(buildCanonicalServerWikiPath('alpha', '운영/ACL'), '/server/alpha/%EC%9A%B4%EC%98%81/ACL');
  assert.equal(
    buildCanonicalServerWikiPath('luna-docs', 'alpha/가이드', 'alpha', '/serverWiki'),
    '/serverWiki/luna-docs/%EA%B0%80%EC%9D%B4%EB%93%9C',
  );
});

test('route resolver batch-loads namespaces and server slugs without cross-space collisions', async () => {
  let namespaceQueries = 0;
  let serverWikiQueries = 0;
  const prisma = {
    wikiNamespace: {
      async findMany() {
        namespaceQueries += 1;
        return [{ id: 1, code: 'server' }, { id: 2, code: 'help' }];
      }
    },
    serverWiki: {
      async findMany() {
        serverWikiQueries += 1;
        return [{ spaceId: 10n, slug: 'alpha', siteSlug: 'alpha-docs' }, { spaceId: 20n, slug: 'beta', siteSlug: 'beta-docs' }];
      }
    }
  } as unknown as PrismaService;
  const pages = [
    { id: 1n, namespaceId: 1, spaceId: 10n, title: '규칙', localPath: 'alpha/규칙' },
    { id: 2n, namespaceId: 1, spaceId: 20n, title: '규칙', localPath: 'beta/규칙' },
    { id: 3n, namespaceId: 2, spaceId: 30n, title: '도움말', localPath: '도움말' }
  ];

  const routes = await new WikiRoutePathResolver(prisma).preload(pages);

  assert.equal(routes.routePath(pages[0]), '/serverWiki/alpha-docs/%EA%B7%9C%EC%B9%99');
  assert.equal(routes.routePath(pages[1]), '/serverWiki/beta-docs/%EA%B7%9C%EC%B9%99');
  assert.equal(routes.routePath(pages[2]), '/help/%EB%8F%84%EC%9B%80%EB%A7%90');
  assert.equal(namespaceQueries, 1);
  assert.equal(serverWikiQueries, 1);
});

test('route resolver reuses known namespaces and contextualizes unresolved server targets', async () => {
  let namespaceQueries = 0;
  const prisma = {
    wikiNamespace: {
      async findMany() {
        namespaceQueries += 1;
        return [];
      }
    },
    serverWiki: {
      async findMany() { return [{ spaceId: 10n, slug: 'alpha', siteSlug: 'alpha-docs' }]; }
    }
  } as unknown as PrismaService;
  const page = { id: 1n, namespaceId: 1, spaceId: 10n, title: '대문', localPath: 'alpha' };

  const routes = await new WikiRoutePathResolver(prisma).preload([page], new Map([[1, 'server']]));

  assert.equal(routes.targetRoutePath('server', 'alpha/없는 문서', page), '/serverWiki/alpha-docs/%EC%97%86%EB%8A%94_%EB%AC%B8%EC%84%9C');
  assert.equal(namespaceQueries, 0);
});

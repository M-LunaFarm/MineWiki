import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundException } from '@nestjs/common';

import { ServerWikiPresentationController } from './server-wiki-presentation.controller';

test('presentation applies the shared space publication policy before returning tenant content', async () => {
  const calls: string[] = [];
  const controller = new ServerWikiPresentationController(
    { async getWikiPresentationBySlug() { calls.push('presentation'); return { slug: 'example' }; } } as never,
    {
      serverWiki: { async findUnique() { calls.push('lookup'); return { spaceId: 10n, publicationStatus: 'published', publishedReleaseId: 50n }; } },
      wikiProfile: { async findUnique() { calls.push('profile'); return { id: 20n, status: 'active' }; } },
    } as never,
    { async assertCanReadSpace(input: { accountId: string | null; spaceId: bigint }) {
      calls.push(`policy:${input.accountId}:${input.spaceId}`);
    }, actorFromSession() { return { profileId: 20n, status: 'active' }; }, async canPreviewServerWikiSpace() {
      calls.push('preview'); return false;
    } } as never,
  );

  const result = await controller.presentation('example', {
    sessionPayload: { userId: 'account-1' },
    clientIp: '203.0.113.8',
  } as never);

  assert.deepEqual(calls, ['lookup', 'policy:account-1:10', 'profile', 'preview', 'presentation']);
  assert.deepEqual(result, { slug: 'example' });
});

test('presentation never calls the renderer when an unpublished tenant is unreadable', async () => {
  let rendered = false;
  const controller = new ServerWikiPresentationController(
    { async getWikiPresentationBySlug() { rendered = true; return {}; } } as never,
    { serverWiki: { async findUnique() { return { spaceId: 10n }; } } } as never,
    { async assertCanReadSpace() { throw new NotFoundException('Wiki space not found.'); } } as never,
  );

  await assert.rejects(
    controller.presentation('example', { sessionPayload: null, clientIp: '203.0.113.8' } as never),
    NotFoundException,
  );
  assert.equal(rendered, false);
});

test('sitemap index only exposes active published release snapshots that allow indexing', async () => {
  const eligible = {
    id: 1n, voteServerId: 'server-1', spaceId: 10n, slug: 'docs', siteSlug: 'example',
    publishedReleaseId: 50n, publishedRelease: { serverWikiId: 1n, presentationSnapshot: { seoIndexingEnabled: true } },
    space: { status: 'active', spaceType: 'server_wiki', rootPageId: 100n },
  };
  const controller = new ServerWikiPresentationController({} as never, {
    serverWiki: { async findMany() { return [eligible, { ...eligible, id: 2n, siteSlug: 'private', publishedRelease: { serverWikiId: 2n, presentationSnapshot: { seoIndexingEnabled: false } } }]; } },
    server: { async findMany() { return [{ id: 'server-1', wikiSpaceId: 10n, wikiPageId: 100n, wikiSlug: 'docs' }]; } },
  } as never, {} as never);

  assert.deepEqual(await controller.sitemapIndex(), { items: [{ slug: 'example', releaseId: '50' }] });
});

test('wiki sitemap is pinned to the published release and rejects cross-tenant release ownership', async () => {
  const wiki = {
    id: 1n, voteServerId: 'server-1', spaceId: 10n, slug: 'docs', siteSlug: 'example', status: 'active',
    publicationStatus: 'published', publishedReleaseId: 50n,
    publishedRelease: {
      serverWikiId: 1n, presentationSnapshot: {},
      items: [
        { serverWikiId: 1n, spaceId: 10n, title: '시작하기', pageUpdatedAt: new Date('2026-07-19T00:00:00.000Z') },
        { serverWikiId: 2n, spaceId: 20n, title: '다른 위키', pageUpdatedAt: new Date('2026-07-19T00:00:00.000Z') },
      ],
    },
    space: { status: 'active', spaceType: 'server_wiki', rootPageId: 100n },
  };
  const prisma = {
    serverWiki: { async findUnique() { return wiki; } },
    server: { async findUnique() { return { listingStatus: 'active', wikiSpaceId: 10n, wikiPageId: 100n, wikiSlug: 'docs' }; } },
  };
  const controller = new ServerWikiPresentationController({} as never, prisma as never, {} as never);

  assert.deepEqual(await controller.sitemap('example'), {
    releaseId: '50',
    items: [{ path: '/serverWiki/example/%EC%8B%9C%EC%9E%91%ED%95%98%EA%B8%B0', lastModified: '2026-07-19T00:00:00.000Z' }],
  });

  wiki.publishedRelease.serverWikiId = 999n;
  await assert.rejects(controller.sitemap('example'), NotFoundException);
});

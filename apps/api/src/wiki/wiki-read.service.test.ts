import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WIKI_RENDERER_VERSION } from '@minewiki/wiki-core';
import type { PrismaService } from '../common/prisma.service';
import type { WikiPermissionService } from './wiki-permission.service';
import { WikiReadService } from './wiki-read.service';

function createReadService(options: {
  readonly cacheHtml?: string | null;
  readonly onCacheLookup?: (where: unknown) => void;
  readonly onCacheCreate?: (data: unknown) => void;
}) {
  const now = new Date('2026-07-05T00:00:00.000Z');
  const prisma = {
    wikiNamespace: {
      async findUnique() {
        return { id: 1, code: 'main' };
      }
    },
    wikiPage: {
      async findUnique() {
        return {
          id: 10n,
          spaceId: 20n,
          slug: '대문',
          title: '대문',
          displayTitle: '대문',
          currentRevisionId: 30n,
          pageType: 'article',
          protectionLevel: 'open',
          status: 'normal',
          updatedAt: now
        };
      }
    },
    wikiPageRevision: {
      async findFirst() {
        return {
          id: 30n,
          pageId: 10n,
          revisionNo: 1,
          contentHash: 'a'.repeat(64),
          contentRaw: "'''현재''' 문서",
          createdAt: now,
          createdBy: 40n,
          visibility: 'public'
        };
      }
    },
    wikiPageRenderCache: {
      async findUnique(args: { where: unknown }) {
        options.onCacheLookup?.(args.where);
        return options.cacheHtml ? { html: options.cacheHtml } : null;
      },
      async create(args: { data: unknown }) {
        options.onCacheCreate?.(args.data);
        return { id: 1n };
      }
    },
    serverWiki: {
      async findFirst() {
        return null;
      }
    },
    server: {
      async findUnique() {
        return null;
      }
    }
  };
  const permissions = {
    async assertCanReadPage() {
      return undefined;
    }
  };
  return new WikiReadService(
    prisma as unknown as PrismaService,
    permissions as unknown as WikiPermissionService
  );
}

test('wiki read uses matching renderer cache version', async () => {
  let lookupWhere: unknown;
  let created = false;
  const service = createReadService({
    cacheHtml: '<p>cached current renderer</p>',
    onCacheLookup(where) {
      lookupWhere = where;
    },
    onCacheCreate() {
      created = true;
    }
  });

  const page = await service.getPage('main', '대문');

  assert.equal(page.html, '<p>cached current renderer</p>');
  assert.deepEqual(lookupWhere, {
    revisionId_rendererVersion: {
      revisionId: 30n,
      rendererVersion: WIKI_RENDERER_VERSION
    }
  });
  assert.equal(created, false);
});

test('wiki read ignores stale renderer cache and writes current version', async () => {
  let createdData: unknown;
  const service = createReadService({
    cacheHtml: null,
    onCacheCreate(data) {
      createdData = data;
    }
  });

  const page = await service.getPage('main', '대문');

  assert.notEqual(page.html, '<p>legacy renderer</p>');
  assert.equal(page.html.includes('<strong>현재</strong> 문서'), true);
  const data = createdData as {
    pageId: bigint;
    revisionId: bigint;
    rendererVersion: string;
    html: string;
    createdAt: Date;
  };
  assert.equal(data.pageId, 10n);
  assert.equal(data.revisionId, 30n);
  assert.equal(data.rendererVersion, WIKI_RENDERER_VERSION);
  assert.equal(data.html, page.html);
  assert.equal(data.createdAt instanceof Date, true);
});

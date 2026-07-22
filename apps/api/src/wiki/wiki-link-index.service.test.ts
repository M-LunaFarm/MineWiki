import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaService } from '../common/prisma.service';
import { WikiLinkIndexService } from './wiki-link-index.service';

const category = (title: string, label: string | null = null, blurred = false) => ({ title, label, blurred });

function createStore(namespaceCode: string, localPath: string) {
  const calls: Array<Record<string, unknown>> = [];
  const metricUpdates: Array<Record<string, unknown>> = [];
  const searchUpdates: Array<Record<string, unknown>> = [];
  const store = {
    wikiPage: {
      async findUnique() {
        return { namespaceId: 1, localPath, slug: localPath, title: '서버 안내', displayTitle: '서버 안내' };
      },
      async update(input: { data: Record<string, unknown> }) {
        metricUpdates.push(input.data);
        return { id: 10n };
      }
    },
    wikiNamespace: {
      async findUnique() { return { code: namespaceCode }; }
    },
    wikiPageLink: {
      async deleteMany() { return { count: 0 }; },
      async createMany(input: { data: Array<Record<string, unknown>> }) {
        calls.push(...input.data);
        return { count: input.data.length };
      }
    },
    wikiSearchDocument: {
      async upsert(input: { create: Record<string, unknown> }) {
        searchUpdates.push(input.create);
        return input.create;
      }
    }
  } as unknown as Pick<PrismaService, 'wikiPage' | 'wikiNamespace' | 'wikiPageLink' | 'wikiSearchDocument'>;
  return { store, calls, metricUpdates, searchUpdates };
}

test('link index normalizes and deduplicates generic wiki targets', async () => {
  const { store, calls } = createStore('main', '대문');
  await new WikiLinkIndexService().replaceForRevision(store, 10n, 20n, ['문서 A', '문서 A', 'server:서버/규칙'], [category('가이드', '처음'), category('가이드', '나중')]);

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((item) => [item.targetNamespaceCode, item.targetSlug]),
    [['main', '문서_A'], ['server', '서버/규칙'], ['category', '가이드']]
  );
  assert.equal(calls.at(-1)?.linkType, 'category');
  assert.equal(calls.at(-1)?.categoryLabel, '처음');
  assert.ok(calls.every((item) => item.sourceRevisionId === 20n));
});

test('link index atomically materializes current source metrics', async () => {
  const { store, calls, metricUpdates } = createStore('main', '대문');
  await new WikiLinkIndexService().replaceForRevision(
    store,
    10n,
    20n,
    [],
    [category('가이드'), category('운영')],
    [],
    { contentSize: 4096, fileNames: ['image.webp', 'image.webp'] }
  );

  assert.deepEqual(metricUpdates, [{ currentContentSize: 4096, currentCategoryCount: 2 }]);
  assert.deepEqual(
    calls.filter((item) => item.linkType === 'file').map((item) => [item.targetNamespaceCode, item.targetSlug]),
    [['file', 'image.webp']]
  );
});

test('link index persists category presentation metadata only on category relations', async () => {
  const { store, calls } = createStore('main', '대문');
  await new WikiLinkIndexService().replaceForRevision(
    store,
    10n,
    20n,
    ['일반 문서'],
    [category('스포일러', '숨겨진 분류', true)],
    ['틀:안내'],
  );

  const categoryLink = calls.find((item) => item.linkType === 'category');
  assert.equal(categoryLink?.categoryLabel, '숨겨진 분류');
  assert.equal(categoryLink?.categoryBlurred, true);
  assert.equal(calls.filter((item) => item.linkType !== 'category').every((item) => (
    item.categoryLabel === null && item.categoryBlurred === false
  )), true);
});

test('link index clears every derived page artifact when no public revision remains', async () => {
  const calls: string[] = [];
  const store = {
    wikiPageLink: { async deleteMany() { calls.push('links'); return { count: 3 }; } },
    wikiSearchDocument: { async deleteMany() { calls.push('search'); return { count: 1 }; } },
    wikiPage: {
      async update(input: { data: Record<string, unknown> }) {
        calls.push('metrics');
        assert.deepEqual(input.data, { currentContentSize: 0, currentCategoryCount: 0 });
        return { id: 10n };
      }
    }
  } as unknown as Pick<PrismaService, 'wikiPage' | 'wikiNamespace' | 'wikiPageLink' | 'wikiSearchDocument'>;

  await new WikiLinkIndexService().clearForPage(store, 10n);
  assert.deepEqual(calls, ['links', 'search', 'metrics']);
});

test('link index materializes redirects as a distinct backlink type', async () => {
  const { store, calls } = createStore('main', '옛 문서');
  await new WikiLinkIndexService().replaceForRevision(
    store,
    10n,
    20n,
    [],
    [],
    [],
    { contentSize: 24, redirectTarget: '새 문서' }
  );

  assert.deepEqual(
    calls.map((item) => [item.targetNamespaceCode, item.targetSlug, item.linkType]),
    [['main', '새_문서', 'redirect']]
  );
});

test('link index replaces the current Korean search vector with its revision', async () => {
  const { store, searchUpdates } = createStore('main', '서버/안내');
  await new WikiLinkIndexService().replaceForRevision(
    store, 10n, 20n, [], [], [],
    { contentSize: 12, contentRaw: '마인크래프트 서버 안내' }
  );

  assert.equal(searchUpdates.length, 1);
  assert.equal(searchUpdates[0]?.pageId, 10n);
  assert.equal(searchUpdates[0]?.revisionId, 20n);
  assert.equal(typeof searchUpdates[0]?.searchVector, 'string');
  assert.equal((searchUpdates[0]?.searchVector as string).includes('마인크래프트'), false);
});

test('link index skips unresolved template placeholders', async () => {
  const { store, calls } = createStore('template', '서버 안내');
  await new WikiLinkIndexService().replaceForRevision(
    store,
    10n,
    20n,
    ['가이드/@문서@', '공통'],
    [category('@분류=기타@'), category('틀')],
    []
  );

  assert.deepEqual(
    calls.map((item) => [item.targetNamespaceCode, item.targetSlug, item.linkType]),
    [['main', '공통', 'link'], ['category', '틀', 'category']]
  );
});

test('server wiki links without a namespace stay in the current server space', async () => {
  const { store, calls } = createStore('server', 'mine-server/시작하기');
  await new WikiLinkIndexService().replaceForRevision(
    store,
    10n,
    20n,
    ['규칙', 'mod:공용 모드'],
    [],
    ['틀:공지', '시작하기']
  );

  assert.deepEqual(
    calls.map((item) => [item.targetNamespaceCode, item.targetSlug, item.linkType]),
    [
      ['server', 'mine-server/규칙', 'link'],
      ['mod', '공용_모드', 'link'],
      ['template', '공지', 'include'],
      ['server', 'mine-server/시작하기', 'include']
    ]
  );
});

test('link index resolves parent, child, and fragment targets in the source page context', async () => {
  const { store, calls } = createStore('server', 'mine-server/가이드/설치');
  await new WikiLinkIndexService().replaceForRevision(
    store,
    10n,
    20n,
    ['../규칙', '/문제 해결', '#설치'],
  );

  assert.deepEqual(
    calls.map((item) => [item.targetNamespaceCode, item.targetSlug]),
    [
      ['server', 'mine-server/가이드/규칙'],
      ['server', 'mine-server/가이드/설치/문제_해결'],
    ],
  );
});

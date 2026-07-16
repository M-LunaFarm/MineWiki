import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkup, renderDocument } from '@minewiki/wiki-core';
import { WikiIncludeService } from './wiki-include.service';

interface FixturePage {
  id: bigint;
  namespaceId: number;
  spaceId: bigint;
  localPath: string;
  slug: string;
  title: string;
  currentRevisionId: bigint;
  status: string;
  protectionLevel: string;
  createdBy: bigint | null;
  contentRaw: string;
  visibility?: string;
}

function createFixture(pages: FixturePage[], deniedPageIds = new Set<bigint>()) {
  const namespaces = new Map([['main', 1], ['template', 2], ['server', 3]]);
  let pageLookups = 0;
  const prisma = {
    wikiNamespace: {
      async findUnique(input: { where: { code: string } }) {
        const id = namespaces.get(input.where.code);
        return id ? { id } : null;
      }
    },
    wikiPage: {
      async findUnique(input: { where: { namespaceId_slug: { namespaceId: number; slug: string } } }) {
        pageLookups += 1;
        const key = input.where.namespaceId_slug;
        return pages.find((page) => page.namespaceId === key.namespaceId && page.slug === key.slug) ?? null;
      }
    },
    wikiPageRevision: {
      async findFirst(input: { where: { id: bigint; pageId: bigint; visibility: string } }) {
        const page = pages.find((item) => item.id === input.where.pageId && item.currentRevisionId === input.where.id);
        if (!page || (page.visibility ?? 'public') !== input.where.visibility) return null;
        return {
          id: page.currentRevisionId,
          pageId: page.id,
          contentRaw: page.contentRaw,
          visibility: page.visibility ?? 'public'
        };
      }
    }
  };
  const permissionCalls: Array<{ accountId?: string | null; actor?: unknown; requestIp?: string | null; page?: { id: bigint } | null }> = [];
  const permissions = {
    async assertCanReadPage(input: { accountId?: string | null; actor?: unknown; requestIp?: string | null; page?: { id: bigint } | null }) {
      permissionCalls.push(input);
      if (input.page && deniedPageIds.has(input.page.id)) throw new Error('denied');
    }
  };
  return {
    service: new WikiIncludeService(prisma as never, permissions as never),
    permissionCalls,
    pageLookups: () => pageLookups
  };
}

const basePage = {
  spaceId: 1n,
  status: 'normal',
  protectionLevel: 'open',
  createdBy: null
};

test('expands a readable include with AST-safe parameters and disables nested includes', async () => {
  const template: FixturePage = {
    ...basePage,
    id: 2n,
    namespaceId: 2,
    localPath: '안내',
    slug: '안내',
    title: '안내',
    currentRevisionId: 20n,
    contentRaw: '== @제목=기본@ ==\n안녕하세요, @이름@\n[include(틀:중첩)]\n{{{\n@이름@\n}}}'
  };
  const { service, permissionCalls } = createFixture([template]);
  const actor = { profileId: 7n, groups: ['trusted'], permissions: ['wiki.read.private'] };
  const parent = parseMarkup('[include(틀:안내,제목=<script>소개</script>,이름=루나)]');
  const result = await service.expand({
    ast: parent.ast,
    accountId: 'account-1',
    actor: actor as never,
    requestIp: '192.0.2.44',
    sourcePageId: 1n,
    sourceNamespace: 'main',
    sourceLocalPath: '대문'
  });
  const include = result.ast[0];

  assert.equal(include?.type, 'include');
  if (include?.type !== 'include') return;
  assert.equal(include.state, 'resolved');
  assert.equal(include.children?.[0]?.type, 'heading');
  if (include.children?.[0]?.type === 'heading') {
    assert.equal(include.children[0].text, '<script>소개</script>');
    assert.match(include.children[0].id, /^inc-1-/);
  }
  const nested = include.children?.find((node) => node.type === 'include');
  assert.equal(nested?.type === 'include' ? nested.state : null, 'unavailable');
  const code = include.children?.find((node) => node.type === 'codeblock');
  assert.equal(code?.type === 'codeblock' ? code.code : null, '@이름@');
  const html = renderDocument(result.ast);
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;소개&lt;\/script&gt;/);
  assert.equal(permissionCalls[0]?.accountId, 'account-1');
  assert.equal(permissionCalls[0]?.actor, actor);
  assert.equal(permissionCalls[0]?.requestIp, '192.0.2.44');
});

test('renders denied and missing include targets identically without target disclosure', async () => {
  const privateTemplate: FixturePage = {
    ...basePage,
    id: 9n,
    namespaceId: 2,
    localPath: '비공개',
    slug: '비공개',
    title: '비공개',
    currentRevisionId: 90n,
    contentRaw: '비밀 본문'
  };
  const { service } = createFixture([privateTemplate], new Set([9n]));
  const denied = await service.expand({
    ast: parseMarkup('[include(틀:비공개)]').ast,
    accountId: null,
    sourcePageId: 1n,
    sourceNamespace: 'main',
    sourceLocalPath: '대문'
  });
  const missing = await service.expand({
    ast: parseMarkup('[include(틀:없음)]').ast,
    accountId: null,
    sourcePageId: 1n,
    sourceNamespace: 'main',
    sourceLocalPath: '대문'
  });

  assert.equal(renderDocument(denied.ast), renderDocument(missing.ast));
  assert.equal(renderDocument(denied.ast).includes('비공개'), false);
  assert.equal(renderDocument(denied.ast).includes('비밀 본문'), false);
});

test('memoizes duplicate targets but accounts for each included source occurrence', async () => {
  const template: FixturePage = {
    ...basePage,
    id: 3n,
    namespaceId: 2,
    localPath: '공통',
    slug: '공통',
    title: '공통',
    currentRevisionId: 30n,
    contentRaw: '== 공통 ==\n공통 본문'
  };
  const { service, pageLookups } = createFixture([template]);
  const result = await service.expand({
    ast: parseMarkup('[include(틀:공통)]\n[include(틀:공통)]').ast,
    accountId: null,
    sourcePageId: 1n,
    sourceNamespace: 'main',
    sourceLocalPath: '대문'
  });

  assert.equal(pageLookups(), 1);
  assert.equal(result.includedSourceBytes, Buffer.byteLength(template.contentRaw, 'utf8') * 2);
  assert.ok(result.ast.every((node) => node.type === 'include' && node.state === 'resolved'));
  const headingIds = result.ast.map((node) => node.type === 'include' && node.children?.[0]?.type === 'heading'
    ? node.children[0].id
    : null);
  assert.deepEqual(headingIds, ['inc-1-공통', 'inc-2-공통']);
});

test('resolves unqualified includes inside the caller server subwiki', async () => {
  const serverPage: FixturePage = {
    ...basePage,
    id: 4n,
    namespaceId: 3,
    localPath: 'soul/규칙',
    slug: 'soul/규칙',
    title: 'soul/규칙',
    currentRevisionId: 40n,
    contentRaw: '서버 규칙'
  };
  const { service } = createFixture([serverPage]);
  const result = await service.expand({
    ast: parseMarkup('[include(규칙)]').ast,
    accountId: null,
    sourcePageId: 5n,
    sourceNamespace: 'server',
    sourceLocalPath: 'soul/시작'
  });

  assert.match(renderDocument(result.ast), /서버 규칙/);
});

test('does not follow redirects and blocks direct self-includes', async () => {
  const redirect: FixturePage = {
    ...basePage,
    id: 6n,
    namespaceId: 2,
    localPath: '넘겨주기',
    slug: '넘겨주기',
    title: '넘겨주기',
    currentRevisionId: 60n,
    contentRaw: '#REDIRECT [[틀:대상]]'
  };
  const { service } = createFixture([redirect]);
  const redirected = await service.expand({
    ast: parseMarkup('[include(틀:넘겨주기)]').ast,
    accountId: null,
    sourcePageId: 1n,
    sourceNamespace: 'main',
    sourceLocalPath: '대문'
  });
  const self = await service.expand({
    ast: parseMarkup('[include(대문)]').ast,
    accountId: null,
    sourcePageId: 1n,
    sourceNamespace: 'main',
    sourceLocalPath: '대문'
  });

  assert.ok([redirected.ast[0], self.ast[0]].every((node) => node?.type === 'include' && node.state === 'unavailable'));
});

test('caps the aggregate included source size at one MiB', async () => {
  const largeBody = '가'.repeat(190_000);
  const pages: FixturePage[] = [1, 2].map((index) => ({
    ...basePage,
    id: BigInt(20 + index),
    namespaceId: 2,
    localPath: `큰틀${index}`,
    slug: `큰틀${index}`,
    title: `큰틀${index}`,
    currentRevisionId: BigInt(200 + index),
    contentRaw: largeBody
  }));
  const { service } = createFixture(pages);
  const result = await service.expand({
    ast: parseMarkup('[include(틀:큰틀1)]\n[include(틀:큰틀2)]').ast,
    accountId: null,
    sourcePageId: 1n,
    sourceNamespace: 'main',
    sourceLocalPath: '대문'
  });

  assert.equal(result.ast[0]?.type === 'include' ? result.ast[0].state : null, 'resolved');
  assert.equal(result.ast[1]?.type === 'include' ? result.ast[1].state : null, 'unavailable');
  assert.ok(result.includedSourceBytes <= 1024 * 1024);
});

test('expands includes inside wiki style blocks and injects non-overridable calleeTitle', async () => {
  const template: FixturePage = {
    ...basePage,
    id: 31n,
    namespaceId: 2,
    localPath: '호출자',
    slug: '호출자',
    title: '호출자',
    currentRevisionId: 310n,
    contentRaw: '@calleeTitle@ / @값@'
  };
  const { service } = createFixture([template]);
  const parent = parseMarkup([
    '{{{#!wiki style="writing-mode:vertical-rl"',
    '[include(틀:호출자,calleeTitle=위조,값=정상)]',
    '}}}'
  ].join('\n'));
  const result = await service.expand({
    ast: parent.ast,
    accountId: null,
    sourcePageId: 1n,
    sourceNamespace: 'server',
    sourceLocalPath: 'luna/대문'
  });
  const html = renderDocument(result.ast);

  assert.match(html, /class="wiki-style" style="writing-mode:vertical-rl"/);
  assert.match(html, /서버:luna\/대문 \/ 정상/);
  assert.equal(html.includes('위조'), false);
  assert.equal(html.includes('저장한 뒤'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMarkup, renderDocument, WIKI_RENDERER_VERSION } from '../src/markup.js';
import { resolveWikiPath, wikiLinkKey, wikiUrl } from '../src/namespaces.js';
import { hashContent, normalizeSearch, normalizeTitle, slugifyTitle } from '../src/normalize.js';

test('normalizes titles, slugs, search text, and content hashes', () => {
  assert.equal(normalizeTitle('  엔더_진주  '), '엔더 진주');
  assert.equal(slugifyTitle('엔더 진주'), '엔더_진주');
  assert.equal(normalizeSearch('엔더 진주'), '엔더진주');
  assert.match(hashContent('MineWiki'), /^[a-f0-9]{64}$/);
  assert.match(WIKI_RENDERER_VERSION, /^minewiki-bwm-\d+\.\d+\.\d+$/);
});

test('resolves canonical wiki route mappings', () => {
  assert.deepEqual(resolveWikiPath('/wiki/대문'), {
    namespace: 'main',
    title: '대문',
    slug: '대문'
  });
  assert.deepEqual(resolveWikiPath('/mod/JEI'), { namespace: 'mod', title: 'JEI', slug: 'JEI' });
  assert.deepEqual(resolveWikiPath('/server/luna'), { namespace: 'server', title: 'luna', slug: 'luna' });
  assert.deepEqual(resolveWikiPath('/dev/API'), { namespace: 'dev', title: 'API', slug: 'API' });
  assert.equal(wikiUrl('server', 'luna'), '/server/luna');
});

test('parses links, categories, components, and safe HTML', () => {
  const parsed = parseMarkup(`{{문서 상태
|기준=Java Edition 1.21
|상태=검증 필요
}}

'''엔더맨'''은 [[엔드]]에서 흔하다.<script>alert(1)</script>

== 관련 문서 ==
* [[엔더 진주]]

[[분류:중립적 몹]]`);

  assert.deepEqual(parsed.links, ['엔드', '엔더 진주']);
  assert.deepEqual(parsed.categories, ['중립적 몹']);
  assert.equal(parsed.components.some((component) => component.name === 'document_status'), true);
  const html = renderDocument(parsed.ast, { missingLinks: new Set([wikiLinkKey('엔더 진주')]) });
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('class="wiki-link missing"'), true);
});

test('rejects oversized documents before parsing their contents', () => {
  const parsed = parseMarkup('가'.repeat(400_000));

  assert.deepEqual(parsed.ast, []);
  assert.deepEqual(parsed.blockingErrors, ['문서 크기 제한을 초과했습니다.']);
});

test('limits recursive folding blocks', () => {
  const nested = `${'{{{#!folding nested\n'.repeat(32)}body\n}}}`;
  const parsed = parseMarkup(nested);

  assert.equal(parsed.blockingErrors.includes('접기 블록 중첩 제한을 초과했습니다.'), true);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [client, api] = await Promise.all([
  readFile(new URL('../components/wiki/wiki-backlinks-client.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8'),
]);

test('backlink browser exposes all thetree-compatible relation filters', () => {
  for (const type of ['link', 'file', 'include', 'redirect']) {
    assert.match(client, new RegExp(`type: '${type}'`, 'u'));
  }
  assert.match(client, /aria-label="역링크 유형"/u);
  assert.match(client, /aria-label="역링크 이름공간"/u);
  assert.match(client, /summary\.namespaceCounts/u);
  assert.match(client, /summary\?\.typeCounts/u);
  assert.match(client, /최근 \$\{summary\.total/u);
});

test('backlink requests preserve filters while loading additional pages', () => {
  assert.match(api, /params\.set\('types', input\.types\.join\(','\)\)/u);
  assert.match(api, /params\.set\('namespace', input\.namespace\)/u);
  assert.match(client, /cursor: targetCursor, types: selectedTypes, namespace: selectedNamespace/u);
  assert.match(client, /result\.prevCursor/u);
  assert.match(client, /aria-label="역링크 페이지 이동"/u);
});

test('backlink rows identify their relation type', () => {
  assert.match(client, /item\.linkTypes\.map/u);
  assert.match(client, /if \(value === 'redirect'\) return '넘겨주기'/u);
  assert.match(client, /if \(value === 'category'\) return '분류'/u);
});

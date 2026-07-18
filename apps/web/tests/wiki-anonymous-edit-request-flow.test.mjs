import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('anonymous wiki editing is captcha-bound and grants controls only through the browser capability', async () => {
  const [editor, api, detail, queue] = await Promise.all([
    readFile(new URL('../components/wiki/wiki-editor-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/wiki/wiki-edit-requests-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/wiki/wiki-edit-request-queue-client.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(editor, /NEXT_PUBLIC_WIKI_ANONYMOUS_EDIT_REQUESTS_ENABLED === 'true'/u);
  assert.match(editor, /captchaToken: anonymousReviewEnabled \? captchaToken/u);
  assert.match(editor, /IP 주소는 악용 방지와 감사 목적으로만 제한 보관/u);
  assert.match(editor, /account && \(page \|\| createContext\?\.canCreate\)/u);
  assert.match(api, /createWikiEditRequest\(input: \{[^}]*captchaToken\?: string/u);
  assert.match(editor, /내 요청 보기/u);
  assert.match(api, /claimWikiEditRequest/u);
  assert.match(detail, /const isAuthor = item\.viewerOwns/u);
  assert.match(detail, /계정에 연결/u);
  assert.match(queue, /item\.viewerOwns/u);
});

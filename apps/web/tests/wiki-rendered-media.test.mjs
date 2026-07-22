import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rewriteWikiRenderedMedia } from '../lib/wiki-rendered-media.mjs';

test('rewrites every API-backed rendered media attribute on the platform host', () => {
  const html = [
    '<img src="/v1/files/public/a.webp/raw">',
    "<video src='/v1/files/public/a.webm/raw' poster=\"/v1/files/public/poster.webp/raw\"></video>",
    '<button data-wiki-file-src="/v1/files/public/large.webp/raw"></button>',
    '<noscript><a href="/v1/files/public/large.webp/raw">open</a></noscript>',
  ].join('');

  const rewritten = rewriteWikiRenderedMedia(html);
  assert.equal((rewritten.match(/\/api\/v1\/files\//gu) ?? []).length, 5);
  assert.equal(rewritten.includes('="/v1/files/'), false);
  assert.equal(rewritten.includes("='/v1/files/"), false);
});

test('uses an absolute MineWiki origin for custom-domain media without touching unrelated URLs', () => {
  const html = [
    '<img src="/v1/files/public/a.webp/raw">',
    '<img src="https://cdn.example/a.webp">',
    '<img src="data:image/gif;base64,AAAA">',
    '<a href="/wiki/guide">guide</a>',
    '<img src="/api/v1/files/public/already.webp/raw">',
  ].join('');

  const rewritten = rewriteWikiRenderedMedia(html, { platformOrigin: 'https://minewiki.kr/' });
  assert.match(rewritten, /src="https:\/\/minewiki\.kr\/api\/v1\/files\/public\/a\.webp\/raw"/u);
  assert.match(rewritten, /src="https:\/\/cdn\.example\/a\.webp"/u);
  assert.match(rewritten, /src="data:image\/gif;base64,AAAA"/u);
  assert.match(rewritten, /href="\/wiki\/guide"/u);
  assert.match(rewritten, /src="\/api\/v1\/files\/public\/already\.webp\/raw"/u);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [client, apiTypes, styles] = await Promise.all([
  readFile(new URL('../components/wiki/wiki-discussion-client.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
]);

test('discussion comments prefer API-sanitized markup and retain a rolling-deploy plaintext fallback', () => {
  assert.match(apiTypes, /readonly contentHtml\?: string \| null/u);
  assert.match(client, /contentHtml=\{item\.contentHtml\}/u);
  assert.match(client, /wiki-rendered wiki-discussion-markup/u);
  assert.match(client, /dangerouslySetInnerHTML=\{\{ __html: contentHtml \}\}/u);
  assert.match(client, /if \(valid\.length === 0\) return <p className="whitespace-pre-wrap">\{content\}<\/p>/u);
  assert.doesNotMatch(client, /<p[^>]*>\s*\{item\.content \?/u);
});

test('discussion tables fill the comment column and overflow only when necessary', () => {
  assert.match(styles, /\.wiki-rendered\.wiki-discussion-markup\s*\{[^}]*border-0[^}]*bg-transparent[^}]*p-0/su);
  assert.match(styles, /\.wiki-rendered\.wiki-discussion-markup \.table-scroll\s*\{[^}]*max-w-full[^}]*overflow-x-auto/su);
  assert.match(styles, /\.wiki-rendered\.wiki-discussion-markup \.table-scroll table\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*table-layout:\s*auto/su);
  assert.match(styles, /\.wiki-rendered\.wiki-discussion-markup :is\(th, td\)\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/su);
});

test('discussion comment references expose permalinks, focused loading, and reply insertion', () => {
  assert.match(client, /a\[href\^="#comment-"\]/u);
  assert.match(client, /fetchWikiThread\(selected\.id, undefined, commentId\)/u);
  assert.match(client, /setThreadInUrl\(selected\.id, commentId\)/u);
  assert.match(client, /aria-label=\{`댓글 #\$\{item\.id\} 바로가기`\}/u);
  assert.match(client, /referenceComment\(item\.id, item\.createdByUsername\)/u);
  assert.match(client, /`#\$\{commentId\}\$\{username \? ` @\$\{username\}` : ''\} `/u);
});

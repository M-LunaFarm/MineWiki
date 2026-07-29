import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractMarkdownImageUrls,
  renderSafeMarkdown,
} from '../lib/markdown-runtime.mjs';

test('renders the formatting offered by the server and support editors', () => {
  const html = renderSafeMarkdown(
    '## 제목\n\n**굵게** *기울임*\n\n- 목록\n\n> 인용\n\n`코드`\n\n[링크](https://minewiki.kr)',
  );

  assert.match(html, /<h2>제목<\/h2>/u);
  assert.match(html, /<strong>굵게<\/strong>/u);
  assert.match(html, /<em>기울임<\/em>/u);
  assert.match(html, /<ul>/u);
  assert.match(html, /<blockquote>/u);
  assert.match(html, /<code>코드<\/code>/u);
  assert.match(
    html,
    /<a href="https:\/\/minewiki\.kr" rel="noopener noreferrer nofollow" target="_blank">링크<\/a>/u,
  );
});

test('removes executable HTML and unsafe link protocols', () => {
  const html = renderSafeMarkdown(
    '<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">위험</a>',
  );

  assert.doesNotMatch(html, /script|onerror|javascript:|<img/iu);
  assert.doesNotMatch(html, /alert\(1\)/u);
  assert.match(html, /<a rel="noopener noreferrer nofollow" target="_blank">위험<\/a>/u);
  assert.doesNotMatch(html, /href=/u);
});

test('rejects protocol-relative and backslash image URL bypasses', () => {
  assert.deepEqual(
    extractMarkdownImageUrls(
      '![외부](//tracker.example/pixel.png)\n<img src="\\\\tracker.example\\pixel.png">\n![업로드](/v1/files/public/id/raw)',
    ),
    ['/v1/files/public/id/raw'],
  );
});

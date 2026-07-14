import test from 'node:test';
import assert from 'node:assert/strict';

import { applyIncludeParametersToAst, parseMarkup, renderDocument, WIKI_RENDERER_VERSION } from '../src/markup.js';
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
  assert.deepEqual(resolveWikiPath('/wiki/가이드/서버 접속'), { namespace: 'guide', title: '서버 접속', slug: '서버_접속' });
  assert.deepEqual(resolveWikiPath('/guide/서버 접속'), { namespace: 'guide', title: '서버 접속', slug: '서버_접속' });
  assert.deepEqual(resolveWikiPath('/wiki/category/게임플레이/몹'), { namespace: 'category', title: '게임플레이/몹', slug: '게임플레이/몹' });
  assert.equal(wikiUrl('server', 'luna'), '/server/luna');
  assert.equal(wikiUrl('guide', '서버 접속'), '/guide/%EC%84%9C%EB%B2%84_%EC%A0%91%EC%86%8D');
  assert.equal(wikiUrl('category', '게임플레이/몹'), '/wiki/category/%EA%B2%8C%EC%9E%84%ED%94%8C%EB%A0%88%EC%9D%B4/%EB%AA%B9');
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

test('extracts inline categories without rendering them as document links', () => {
  const parsed = parseMarkup('본문 끝 [[분류:가이드|정렬 키]] [[분류:초보자]]');

  assert.deepEqual(parsed.categories, ['가이드', '초보자']);
  assert.deepEqual(parsed.links, []);
  assert.equal(renderDocument(parsed.ast).includes('분류:'), false);
  assert.match(renderDocument(parsed.ast), /본문 끝/);
});

test('resolves unqualified links inside a server subwiki', () => {
  const parsed = parseMarkup('[[규칙]] · [[도움말:문법]]');
  const html = renderDocument(parsed.ast, {
    internalLinkBasePath: '/server/luna-main',
  });

  assert.match(html, /href="\/server\/luna-main\/%EA%B7%9C%EC%B9%99"/);
  assert.match(html, /href="\/help\/%EB%AC%B8%EB%B2%95"/);
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

test('duplicate heading anchors are blocking markup errors', () => {
  const parsed = parseMarkup('== Intro ==\n첫 번째\n\n== Intro ==\n두 번째');

  assert.equal(parsed.headings.filter((heading) => heading.anchor === 'Intro').length, 2);
  assert.equal(
    parsed.blockingErrors.some((error) => error.includes('중복 제목 앵커')),
    true,
  );
});

test('parses standalone include macros and bounded parameters', () => {
  const parsed = parseMarkup('[include(틀:서버 안내,서버=소울 온라인,설명=쉽게\\,빠르게)]');

  assert.deepEqual(parsed.includes, ['틀:서버 안내']);
  assert.deepEqual(parsed.ast[0], {
    type: 'include',
    target: '틀:서버 안내',
    params: { 서버: '소울 온라인', 설명: '쉽게,빠르게' },
    state: 'unresolved'
  });
  assert.match(renderDocument(parsed.ast), /포함 문서는 저장한 뒤/);
});

test('does not parse include syntax inside literal code blocks or inline prose', () => {
  const parsed = parseMarkup('{{{\n[include(틀:비밀)]\n}}}\n문장 안 [include(틀:인라인)]');

  assert.deepEqual(parsed.includes, []);
  assert.equal(parsed.ast[0]?.type, 'codeblock');
  assert.equal(parsed.ast[1]?.type, 'paragraph');
});

test('rejects malformed, duplicate, and excessive include parameters', () => {
  const malformed = parseMarkup('[include(틀:안내,키)]');
  const duplicate = parseMarkup('[include(틀:안내,키=1,키=2)]');
  const excessive = parseMarkup(`[include(틀:안내,${Array.from({ length: 33 }, (_, index) => `k${index}=v`).join(',')})]`);

  assert.match(malformed.blockingErrors[0] ?? '', /키=값/);
  assert.match(duplicate.blockingErrors[0] ?? '', /중복/);
  assert.match(excessive.blockingErrors[0] ?? '', /32개/);
});

test('interpolates include parameters only after parsing and prefixes heading ids', () => {
  const template = parseMarkup('== @제목=기본@ ==\n[[가이드/@문서@|@표시@]]\n{{{\n@제목@ [[비밀]]\n}}}');
  const expanded = applyIncludeParametersToAst(template.ast, {
    제목: '<script>안전</script>',
    문서: '시작',
    표시: "'''<b>주입 불가</b>'''"
  }, 'inc-2-');
  const html = renderDocument(expanded);

  assert.equal(expanded[0]?.type, 'heading');
  if (expanded[0]?.type === 'heading') assert.match(expanded[0].id, /^inc-2-/);
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;안전&lt;\/script&gt;/);
  assert.match(html, /'''&lt;b&gt;주입 불가&lt;\/b&gt;'''/);
  assert.match(html, /@제목@ \[\[비밀\]\]/);
});

test('renders resolved and unavailable includes without exposing a target', () => {
  const resolved = renderDocument([{
    type: 'include', target: '틀:안내', params: {}, state: 'resolved',
    children: [{ type: 'paragraph', children: [{ type: 'text', text: '포함된 본문' }] }]
  }]);
  const unavailable = renderDocument([{
    type: 'include', target: '틀:비공개', params: {}, state: 'unavailable'
  }]);

  assert.match(resolved, /class="wiki-transclusion"/);
  assert.match(resolved, /포함된 본문/);
  assert.match(unavailable, /포함 문서를 불러올 수 없습니다/);
  assert.equal(unavailable.includes('비공개'), false);
});

test('renders open and collapsed table-of-contents macros with stable numbering', () => {
  const open = parseMarkup('[목차]\n== 소개 ==\n=== 설치 ===\n== 사용법 ==');
  const collapsed = parseMarkup('[tableofcontents(hide)]\n== 제목 ==');
  const openHtml = renderDocument(open.ast);
  const collapsedHtml = renderDocument(collapsed.ast);

  assert.equal(open.ast[0]?.type, 'toc');
  assert.match(openHtml, /<nav class="wiki-toc" aria-label="문서 목차"><details open>/);
  assert.match(openHtml, /<span>1<\/span>소개/);
  assert.match(openHtml, /<span>1\.1<\/span>설치/);
  assert.match(openHtml, /<span>2<\/span>사용법/);
  assert.match(collapsedHtml, /<details><summary>목차/);
});

test('parent table of contents excludes transcluded headings', () => {
  const ast = parseMarkup('[목차]\n== 부모 제목 ==').ast;
  ast.push({
    type: 'include',
    target: '틀:안내',
    params: {},
    state: 'resolved',
    children: [{ type: 'heading', level: 2, text: '포함 제목', id: 'inc-1-포함-제목' }]
  });
  const html = renderDocument(ast);
  const toc = html.slice(html.indexOf('<nav class="wiki-toc"'), html.indexOf('</nav>') + 6);

  assert.match(toc, /부모 제목/);
  assert.equal(toc.includes('포함 제목'), false);
  assert.match(html, /id="inc-1-포함-제목"/);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { applyIncludeParametersToAst, collectWikiFileNames, collectWikiLinkTargets, parseMarkup, renderDiscussionMarkup, renderDocument, WIKI_RENDERER_VERSION } from '../src/markup.js';
import { parseLinkTarget, resolveWikiPath, wikiLinkKey, wikiUrl } from '../src/namespaces.js';
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
  assert.deepEqual(resolveWikiPath('/user/owner_name/작업실'), { namespace: 'user', title: 'owner_name/작업실', slug: 'owner_name/작업실' });
  assert.deepEqual(resolveWikiPath('/wiki/사용자/owner_name'), { namespace: 'user', title: 'owner_name', slug: 'owner_name' });
  assert.deepEqual(resolveWikiPath('/wiki/category/게임플레이/몹'), { namespace: 'category', title: '게임플레이/몹', slug: '게임플레이/몹' });
  assert.equal(wikiUrl('server', 'luna'), '/server/luna');
  assert.equal(wikiUrl('guide', '서버 접속'), '/guide/%EC%84%9C%EB%B2%84_%EC%A0%91%EC%86%8D');
  assert.equal(wikiUrl('user', 'owner_name/작업실'), '/user/owner_name/%EC%9E%91%EC%97%85%EC%8B%A4');
  assert.equal(wikiUrl('category', '게임플레이/몹'), '/wiki/category/%EA%B2%8C%EC%9E%84%ED%94%8C%EB%A0%88%EC%9D%B4/%EB%AA%B9');
  assert.deepEqual(parseLinkTarget('main:대문'), { namespace: 'main', title: '대문' });
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

test('keeps front-page search interactive and supports legacy card link targets', () => {
  const parsed = parseMarkup([
    '{{대문 검색|예시=블록, 명령어, 서버 이름 검색}}',
    '{{대문 카드|제목=서버 찾기|설명=인증된 서버를 확인하세요.|링크=/servers}}',
  ].join('\n\n'));
  const html = renderDocument(parsed.ast);

  assert.match(html, /<form class="search-page" action="\/search" method="get" role="search" aria-label="위키 검색">/u);
  assert.match(html, /<input class="search-page-input" type="search" name="q"[^>]+aria-label="검색어"/u);
  assert.match(html, /<button class="search-page-submit" type="submit">검색<\/button>/u);
  assert.match(html, /class="front-wiki-component front-wiki-card"/u);
  assert.match(html, /<a href="\/servers">서버 찾기<\/a>/u);
  assert.equal(html.includes('<form action="https://example.com">'), false);
});

test('renders nested inline markup and collects dependencies inside wrappers', () => {
  const parsed = parseMarkup("'''굵게 ''기울임 [[내부 문서]]''와 ~~취소 [[파일:아이콘.png|설명]]~~'''\n{{{#336699 색상 __밑줄 [math(x^2)]__}}}");
  const html = renderDocument(parsed.ast, {
    files: {
      '아이콘.png': { url: '/files/icon.png', originalName: '아이콘.png', license: null, sourceUrl: null, sourceText: null }
    }
  });

  assert.match(html, /<strong>굵게 <em>기울임 <a[^>]+>내부 문서<\/a><\/em>와 <s>취소 <span class="wiki-file wiki-file-inline">/);
  assert.match(html, /<span class="wiki-color wiki-color-dark-unsafe" style="color:#336699">색상 <u>밑줄 <span class="wiki-math wiki-math-inline">/);
  assert.deepEqual(parsed.links, ['내부 문서']);
  assert.deepEqual([...collectWikiLinkTargets(parsed.ast)], ['내부 문서']);
  assert.deepEqual([...collectWikiFileNames(parsed.ast)], ['아이콘.png']);
});

test('groups consecutive source lines into one paragraph with explicit line breaks', () => {
  const parsed = parseMarkup('첫 줄\n둘째 줄\n\n셋째 문단');
  const html = renderDocument(parsed.ast);

  assert.equal(parsed.ast.filter((node) => node.type === 'paragraph').length, 2);
  assert.match(html, /^<p>첫 줄<br \/>둘째 줄<\/p>\n<p>셋째 문단<\/p>/u);
});

test('parses blockquotes recursively and preserves nested block metadata', () => {
  const parsed = parseMarkup([
    '> 바깥 [[가이드]]',
    '>> 안쪽 [[파일:inside.png]] [*note 인용 각주]',
    '>>  * 목록',
    '> 끝',
  ].join('\n'));
  const html = renderDocument(parsed.ast, {
    files: {
      'inside.png': { url: '/files/inside.png', originalName: 'inside.png' },
    },
  });

  assert.equal(parsed.ast[0]?.type, 'blockquote');
  assert.equal((html.match(/<blockquote class="wiki-quote">/g) ?? []).length, 2);
  assert.match(html, /<blockquote class="wiki-quote"><p>바깥 <a[^>]+>가이드<\/a><\/p>\n<blockquote/u);
  assert.match(html, /<ul class="wiki-list">[^]*<li>목록<\/li>[^]*<\/ul>/u);
  assert.deepEqual([...collectWikiLinkTargets(parsed.ast)], ['가이드']);
  assert.deepEqual([...collectWikiFileNames(parsed.ast)], ['inside.png']);
  assert.match(html, /<section class="footnotes">/u);
});

test('keeps literal HTML escaped inside nested inline markup', () => {
  const parsed = parseMarkup("'''안전 ''<img src=x onerror=alert(1)>''''' ");
  const html = renderDocument(parsed.ast);

  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(parsed.blockingErrors.some((error) => error.includes('허용되지 않은 HTML')), true);
});

test('skips canonical full-line comments without hiding comment text inside literal blocks', () => {
  const parsed = parseMarkup([
    '## [[숨은 링크]] <script>alert(1)</script>',
    '#REDIRECT [[공개 문서]]',
    '{{{',
    '## 리터럴 본문',
    '}}}',
  ].join('\n'));
  const html = renderDocument(parsed.ast);

  assert.equal(parsed.redirectTarget, '공개 문서');
  assert.deepEqual(parsed.links, []);
  assert.equal(parsed.plainText.includes('숨은 링크'), false);
  assert.equal(parsed.blockingErrors.some((error) => error.includes('허용되지 않은 HTML')), false);
  assert.match(html, /<pre class="codeblock"[^>]*><code>## 리터럴 본문<\/code><\/pre>/u);
});

test('renders triple-brace spans literally and honors canonical backslash escapes', () => {
  const parsed = parseMarkup(String.raw`{{{'''그대로''' [[링크 아님]]}}} \[[링크 아님]] \[br] \\ 끝`);
  const html = renderDocument(parsed.ast);

  assert.deepEqual(parsed.links, []);
  assert.match(html, /<code>'''그대로''' \[\[링크 아님\]\]<\/code>/u);
  assert.match(html, /\[\[링크 아님\]\] \[br\] \\ 끝/u);
  assert.equal(html.includes('<br>'), false);
});

test('collects internal links introduced by expanded nested AST containers', () => {
  const parent = parseMarkup('[[직접 링크]]');
  const included = parseMarkup('본문 [[포함 링크]]');
  const ast = [...parent.ast, { type: 'include', target: '틀:링크', params: {}, state: 'resolved', children: included.ast } as const];

  assert.deepEqual([...collectWikiLinkTargets(ast)], ['직접 링크', '포함 링크']);
});

test('renders inline, block, and legacy math with accessible KaTeX output', () => {
  const parsed = parseMarkup([
    '피타고라스 [math(x^2 + y^2 = z^2)]',
    '<math>\\sqrt{x}</math>',
    '{{{#!latex',
    '\\frac{a}{b}',
    '}}}'
  ].join('\n'));
  const html = renderDocument(parsed.ast);

  assert.equal(parsed.blockingErrors.length, 0);
  assert.match(html, /wiki-math-inline/);
  assert.match(html, /wiki-math-block/);
  assert.match(html, /<math[^>]*>/);
  assert.match(html, /<annotation encoding="application\/x-tex">/);
  assert.match(html, /aria-hidden="true"/);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 3);
});

test('math rendering fails locally and rejects trusted HTML or dangerous URLs', () => {
  const invalid = renderDocument(parseMarkup('[math(\\frac{)] 뒤의 본문').ast);
  const dangerous = renderDocument(parseMarkup('[math(\\href{javascript:alert(1)}{click})] <script>alert(1)</script>').ast);

  assert.match(invalid, /수식 문법 오류/);
  assert.match(invalid, /뒤의 본문/);
  assert.equal(dangerous.includes('javascript:'), false);
  assert.equal(dangerous.includes('<script>'), false);
  assert.match(dangerous, /수식 문법 오류/);
});

test('math parsing enforces per-formula and per-document resource bounds', () => {
  const oversized = parseMarkup(`[math(${'x'.repeat(4097)})]`);
  const excessive = parseMarkup(Array.from({ length: 51 }, () => '[math(x)]').join('\n'));
  const transcluded = renderDocument([{
    type: 'include',
    target: '수식 모음',
    params: {},
    state: 'resolved',
    children: excessive.ast
  }]);

  assert.equal(oversized.errors.some((error) => error.includes('4096 bytes')), true);
  assert.match(renderDocument(oversized.ast), /수식 문법 오류/);
  assert.equal(excessive.blockingErrors.includes('수식은 문서당 50개까지 사용할 수 있습니다.'), true);
  assert.equal(transcluded.includes('class="katex"'), false);
  assert.match(transcluded, /수식 문법 오류/);
});

test('extracts inline categories without rendering them as document links', () => {
  const parsed = parseMarkup('본문 끝 [[분류:가이드|정렬 키]] [[분류:초보자]]');

  assert.deepEqual(parsed.categories, ['가이드', '초보자']);
  assert.deepEqual(parsed.links, []);
  assert.equal(renderDocument(parsed.ast).includes('분류:'), false);
  assert.match(renderDocument(parsed.ast), /본문 끝/);
});

test('renders validated wiki file license and source attribution', () => {
  const parsed = parseMarkup('[[파일:guide.webp|섬네일|설치 화면]]');
  const html = renderDocument(parsed.ast, {
    files: {
      'guide.webp': {
        url: '/v1/files/public/guide.webp/raw',
        mimeType: 'image/webp',
        originalName: 'guide.png',
        license: 'cc-by-sa-4.0',
        sourceUrl: 'https://example.com/original',
        sourceText: 'Example 제작자'
      }
    }
  });

  assert.match(html, /라이선스: CC BY-SA 4\.0/);
  assert.match(html, /href="https:\/\/example\.com\/original"/);
  assert.match(html, /Example 제작자/);
  assert.match(html, /^<figure class="wiki-file thumb">/);
  assert.equal(html.includes('wiki-file-inline'), false);
  assert.match(html, /rel="nofollow noopener"/);
});

test('resolves unqualified links inside a server subwiki', () => {
  const parsed = parseMarkup('[[규칙]] · [[도움말:문법]]');
  const html = renderDocument(parsed.ast, {
    internalLinkBasePath: '/server/luna-main',
  });

  assert.match(html, /href="\/server\/luna-main\/%EA%B7%9C%EC%B9%99"/);
  assert.match(html, /href="\/help\/%EB%AC%B8%EB%B2%95"/);
});

test('resolves NamuMark parent and child links against a main-wiki document', () => {
  const linkResolution = {
    currentDocumentPath: '가이드/설치/리눅스',
    namespace: 'main' as const,
  };
  const parsed = parseMarkup(
    '[[../윈도우]] · [[/문제 해결|해결하기]] · [[절대/문서]] · [[도움말:문법]]',
    { linkResolution },
  );
  const html = renderDocument(parsed.ast, {
    missingLinks: new Set([wikiLinkKey('가이드/설치/리눅스/문제 해결')]),
  });

  assert.deepEqual(parsed.links, [
    '가이드/설치/윈도우',
    '가이드/설치/리눅스/문제 해결',
    '절대/문서',
    '도움말:문법',
  ]);
  assert.deepEqual([...collectWikiLinkTargets(parsed.ast)], parsed.links);
  assert.match(html, /href="\/wiki\/%EA%B0%80%EC%9D%B4%EB%93%9C\/%EC%84%A4%EC%B9%98\/%EC%9C%88%EB%8F%84%EC%9A%B0">\.\.\/윈도우<\/a>/);
  assert.match(html, /class="wiki-link missing" href="\/wiki\/%EA%B0%80%EC%9D%B4%EB%93%9C\/%EC%84%A4%EC%B9%98\/%EB%A6%AC%EB%88%85%EC%8A%A4\/%EB%AC%B8%EC%A0%9C_%ED%95%B4%EA%B2%B0" title="문서 없음">해결하기<\/a>/);
  assert.match(html, /href="\/wiki\/%EC%A0%88%EB%8C%80\/%EB%AC%B8%EC%84%9C">절대\/문서<\/a>/);
  assert.match(html, /href="\/help\/%EB%AC%B8%EB%B2%95">도움말:문법<\/a>/);
});

test('inherits non-main namespaces only for relative links', () => {
  const parsed = parseMarkup('[[../윈도우]] · [[main:대문]] · [[도움말:문법]]', {
    linkResolution: {
      currentDocumentPath: '설치/리눅스',
      namespace: 'guide',
    },
  });
  const html = renderDocument(parsed.ast);

  assert.deepEqual(parsed.links, ['guide:설치/윈도우', 'main:대문', '도움말:문법']);
  assert.match(html, /href="\/guide\/%EC%84%A4%EC%B9%98\/%EC%9C%88%EB%8F%84%EC%9A%B0"/);
  assert.match(html, /href="\/wiki\/%EB%8C%80%EB%AC%B8"/);
  assert.match(html, /href="\/help\/%EB%AC%B8%EB%B2%95"/);
});

test('keeps relative links inside an isolated server-wiki route base', () => {
  const linkResolution = {
    currentDocumentPath: '가이드/설치',
    namespace: 'main' as const,
  };
  const parsed = parseMarkup('[[../규칙]] · [[/문제 해결]] · [[공지]] · [[도움말:문법]]', {
    linkResolution,
  });
  const options = {
    internalLinkBasePath: '/server/luna-main',
    linkResolution,
    missingLinks: new Set([wikiLinkKey('가이드/규칙')]),
  };
  const html = renderDocument(parsed.ast, options);

  assert.deepEqual(parsed.links, ['가이드/규칙', '가이드/설치/문제 해결', '공지', '도움말:문법']);
  assert.match(html, /class="wiki-link missing" href="\/server\/luna-main\/%EA%B0%80%EC%9D%B4%EB%93%9C\/%EA%B7%9C%EC%B9%99"/);
  assert.match(html, /href="\/server\/luna-main\/%EA%B0%80%EC%9D%B4%EB%93%9C\/%EC%84%A4%EC%B9%98\/%EB%AC%B8%EC%A0%9C_%ED%95%B4%EA%B2%B0"/);
  assert.match(html, /href="\/server\/luna-main\/%EA%B3%B5%EC%A7%80"/);
  assert.match(html, /href="\/help\/%EB%AC%B8%EB%B2%95"/);

  const persisted = parseMarkup('[[../규칙|이전 AST]]');
  assert.match(renderDocument(persisted.ast, options), /href="\/server\/luna-main\/%EA%B0%80%EC%9D%B4%EB%93%9C\/%EA%B7%9C%EC%B9%99"[^>]*>이전 AST<\/a>/);

  const root = parseMarkup('[[/규칙]] · [[../탈출|차단]]', {
    linkResolution: { currentDocumentPath: '', namespace: 'main' },
  });
  assert.deepEqual(root.links, ['규칙']);
  assert.equal(root.blockingErrors.includes('상대 링크가 문서 루트를 벗어날 수 없습니다.'), true);
});

test('renders the safe discussion NamuMark subset with contextual links and tables', () => {
  const html = renderDiscussionMarkup([
    "'''굵게'''와 [[../규칙|규칙]]",
    ' * 첫 항목',
    '  * 하위 항목',
    '> 인용문',
    '||<tablewidth=100%><thead>항목||값||',
    '||상태||정상||',
    '{{{#!syntax js',
    '<script>alert(1)</script>',
    '}}}',
  ].join('\n'), {
    internalLinkBasePath: '/server/luna',
    linkResolution: { currentDocumentPath: '가이드/설치', namespace: 'main' },
  });

  assert.match(html, /<strong>굵게<\/strong>/u);
  assert.match(html, /href="\/server\/luna\/%EA%B0%80%EC%9D%B4%EB%93%9C\/%EA%B7%9C%EC%B9%99"/u);
  assert.match(html, /<ul class="wiki-list">/u);
  assert.match(html, /<blockquote class="wiki-quote">/u);
  assert.match(html, /<table class="component-table wiki-table"/u);
  assert.match(html, /<pre class="codeblock" data-lang="js"><code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code><\/pre>/u);
  assert.equal(html.includes('<script>'), false);
});

test('keeps document-level and dynamic markup inert in discussion comments', () => {
  const html = renderDiscussionMarkup([
    '[[include(비공개 문서)]]',
    '[[파일:secret.png]]',
    '[youtube(dQw4w9WgXcQ)]',
    '[pagecount]',
    '[* note secret]',
    '[목차]',
    '#redirect [[비공개 문서]]',
    '== 제목 ==',
    '표시할 문장',
  ].join('\n'));

  assert.equal(html.includes('wiki-transclusion'), false);
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('<iframe'), false);
  assert.equal(html.includes('wiki-dynamic'), false);
  assert.equal(html.includes('footnote'), false);
  assert.equal(html.includes('wiki-toc'), false);
  assert.equal(html.includes('넘겨주기'), false);
  assert.equal(html.includes('<h2'), false);
  assert.match(html, /<p>제목<\/p>/u);
  assert.match(html, /표시할 문장/u);
});

test('links only validated discussion mentions outside code and existing links', () => {
  const html = renderDiscussionMarkup([
    '@Alice 확인 @Unknown',
    '{{{@Alice}}}',
    '[[문서|@Alice]]',
    '[https://example.com/@Alice @Alice]',
    'mail@Alice.example',
  ].join('\n'), {
    mentions: [{ username: 'Alice', href: '/user/Alice' }],
  });

  assert.equal((html.match(/href="\/user\/Alice"/gu) ?? []).length, 1);
  assert.match(html, /<a href="\/user\/Alice">@Alice<\/a>/u);
  assert.match(html, /<code>@Alice<\/code>/u);
  assert.match(html, /href="\/wiki\/%EB%AC%B8%EC%84%9C">@Alice<\/a>/u);
  assert.match(html, /href="https:\/\/example\.com\/@Alice" rel="nofollow noopener" target="_blank">@Alice<\/a>/u);
  assert.match(html, /mail@Alice\.example/u);
  assert.match(html, /@Unknown/u);
});

test('renders fragments without indexing same-page anchors as page links', () => {
  const parsed = parseMarkup('[[#Anchor]] · [[#설치 안내|안내]] · [[다른 문서#세부 항목]]');
  const html = renderDocument(parsed.ast, {
    missingLinks: new Set([wikiLinkKey(''), wikiLinkKey('#Anchor'), wikiLinkKey('다른 문서')]),
  });

  assert.deepEqual(parsed.links, ['다른 문서']);
  assert.deepEqual([...collectWikiLinkTargets(parsed.ast)], ['다른 문서']);
  assert.match(html, /class="wiki-link" href="#Anchor">#Anchor<\/a>/);
  assert.match(html, /class="wiki-link" href="#%EC%84%A4%EC%B9%98-%EC%95%88%EB%82%B4">안내<\/a>/);
  assert.match(html, /class="wiki-link missing" href="\/wiki\/%EB%8B%A4%EB%A5%B8_%EB%AC%B8%EC%84%9C#%EC%84%B8%EB%B6%80-%ED%95%AD%EB%AA%A9" title="문서 없음">다른 문서#세부 항목<\/a>/);
  assert.equal((html.match(/class="wiki-link missing"/g) ?? []).length, 1);

  const persisted = [{
    type: 'paragraph' as const,
    children: [{ type: 'internal_link' as const, target: '#Anchor', label: '이전 앵커' }],
  }];
  assert.deepEqual([...collectWikiLinkTargets(persisted)], []);
  assert.match(renderDocument(persisted), /href="#Anchor">이전 앵커<\/a>/);
});

test('rejects relative root escapes while allowing the bounded root edge', () => {
  const parsed = parseMarkup([
    '[[../../../secret|escape]]',
    '[[..\\..\\..\\secret|backslash escape]]',
    '[[%2E%2E%2F%2E%2E%2F%2E%2E%2Fsecret|encoded escape]]',
    '[[../../Sibling|root sibling]]',
  ].join(' · '), {
    linkResolution: {
      currentDocumentPath: 'Root/Page',
      namespace: 'main',
    },
  });
  const html = renderDocument(parsed.ast);

  assert.deepEqual(parsed.links, ['Sibling']);
  assert.equal(parsed.blockingErrors.includes('상대 링크가 문서 루트를 벗어날 수 없습니다.'), true);
  assert.equal(html.includes('/secret'), false);
  assert.match(html, /escape · backslash escape · encoded escape/);
  assert.match(html, /href="\/wiki\/Sibling">root sibling<\/a>/);
});

test('bounds link resolution contexts and rejects nested encoded traversal', () => {
  const oversizedContext = parseMarkup('[[/Child|bounded]]', {
    linkResolution: {
      currentDocumentPath: 'A'.repeat(4097),
      namespace: 'main',
    },
  });
  const deepTarget = parseMarkup(`[[/${Array.from({ length: 65 }, () => 'Child').join('/')}|deep]]`, {
    linkResolution: {
      currentDocumentPath: 'Root',
      namespace: 'main',
    },
  });
  const nestedEncoding = parseMarkup('[[%252E%252E%252Fsecret|encoded twice]]', {
    linkResolution: {
      currentDocumentPath: 'Root/Page',
      namespace: 'main',
    },
  });

  assert.deepEqual(oversizedContext.links, []);
  assert.deepEqual(deepTarget.links, []);
  assert.deepEqual(nestedEncoding.links, []);
  assert.equal(oversizedContext.blockingErrors.includes('상대 링크 해석 기준이 올바르지 않습니다.'), true);
  assert.equal(deepTarget.blockingErrors.includes('상대 링크 경로가 너무 깊습니다.'), true);
  assert.equal(nestedEncoding.blockingErrors.includes('중첩된 경로 인코딩은 내부 링크에 사용할 수 없습니다.'), true);
  assert.equal(renderDocument(nestedEncoding.ast).includes('href='), false);
});

test('encodes percent and special characters without double-decoding or markup injection', () => {
  const parsed = parseMarkup([
    '[[../100%25_%26_%3Ctag%3E_%22quote%22|safe <label>]]',
    '[[/100% ready]]',
    '[[#A%26B%3Cscript%3E|safe anchor]]',
  ].join(' · '), {
    linkResolution: {
      currentDocumentPath: '%EA%B0%80%EC%9D%B4%EB%93%9C/%EC%84%A4%EC%B9%98',
      namespace: 'main',
    },
  });
  const html = renderDocument(parsed.ast);

  assert.deepEqual(parsed.links, [
    '가이드/100% & <tag> "quote"',
    '가이드/설치/100% ready',
  ]);
  assert.match(html, /href="\/wiki\/%EA%B0%80%EC%9D%B4%EB%93%9C\/100%25_%26_%3Ctag%3E_%22quote%22">safe &lt;label&gt;<\/a>/);
  assert.match(html, /href="\/wiki\/%EA%B0%80%EC%9D%B4%EB%93%9C\/%EC%84%A4%EC%B9%98\/100%25_ready">\/100% ready<\/a>/);
  assert.match(html, /href="#ABscript">safe anchor<\/a>/);
  assert.equal(html.includes('<script>'), false);
  assert.equal(normalizeTitle('100% ready'), '100% ready');
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

test('limits recursive blockquotes independently', () => {
  const parsed = parseMarkup(`${'>'.repeat(32)} 너무 깊은 인용`);

  assert.equal(parsed.blockingErrors.includes('인용문 중첩 제한을 초과했습니다.'), true);
});

test('duplicate heading anchors are blocking markup errors', () => {
  const parsed = parseMarkup('== Intro ==\n첫 번째\n\n===== Intro =====\n두 번째');

  assert.equal(parsed.headings.filter((heading) => heading.anchor === 'Intro').length, 2);
  assert.equal(
    parsed.blockingErrors.some((error) => error.includes('중복 제목 앵커')),
    true,
  );
});

test('parses all canonical NamuMark heading levels without truncating delimiters', () => {
  const parsed = parseMarkup([
    '[목차]',
    '= 첫째 =',
    '== 둘째 ==',
    '=== 셋째 ===',
    '==== 넷째 ====',
    '===== 다섯째 =====',
    '====== 여섯째 ======'
  ].join('\n'));

  assert.deepEqual(parsed.headings.map((heading) => ({
    level: heading.level,
    title: heading.title
  })), [
    { level: 1, title: '첫째' },
    { level: 2, title: '둘째' },
    { level: 3, title: '셋째' },
    { level: 4, title: '넷째' },
    { level: 5, title: '다섯째' },
    { level: 6, title: '여섯째' }
  ]);

  const html = renderDocument(parsed.ast);
  for (const [level, title] of ['첫째', '둘째', '셋째', '넷째', '다섯째', '여섯째'].entries()) {
    assert.match(html, new RegExp(`<h${level + 1} id="[^"]+">${title}<\\/h${level + 1}>`));
  }
  assert.match(html, /wiki-toc-level-1[^]*?<span>1<\/span>첫째/);
  assert.match(html, /wiki-toc-level-6[^]*?<span>1\.1\.1\.1\.1\.1<\/span>여섯째/);
  assert.equal(html.includes('<h4 id="-다섯째-">= 다섯째 =</h4>'), false);
  assert.equal(html.includes('<h4 id="-여섯째-">== 여섯째 ==</h4>'), false);
});

test('keeps compact level 2-4 headings compatible', () => {
  const parsed = parseMarkup('==둘째==\n===셋째===\n====넷째====');

  assert.deepEqual(parsed.headings.map((heading) => [heading.level, heading.title]), [
    [2, '둘째'],
    [3, '셋째'],
    [4, '넷째']
  ]);
});

test('renders canonical folded headings as closed content sections', () => {
  const parsed = parseMarkup('==# 접힌 제목 #==\n숨겨진 본문\n=== 하위 제목 ===\n하위 본문');
  const html = renderDocument(parsed.ast);

  assert.deepEqual(parsed.headings.map((heading) => [heading.level, heading.title]), [
    [2, '접힌 제목'],
    [3, '하위 제목']
  ]);
  assert.equal(parsed.ast[0]?.type, 'heading');
  if (parsed.ast[0]?.type === 'heading') assert.equal(parsed.ast[0].folded, true);
  assert.match(html, /<details class="wiki-heading-section"><summary class="wiki-heading-summary"><h2 id="접힌-제목">접힌 제목<\/h2><\/summary><div class="wiki-heading-content"><p>숨겨진 본문<\/p><\/div><\/details>/);
  assert.match(html, /<\/details>\n<h3 id="하위-제목">하위 제목<\/h3>\n<p>하위 본문<\/p>/);
});

test('folded headings remain in the table of contents and reject malformed markers', () => {
  const parsed = parseMarkup('[목차]\n=# 최상위 접기 #=\n본문\n==# 한쪽만 ==');
  const html = renderDocument(parsed.ast);

  assert.deepEqual(parsed.headings.map((heading) => heading.title), ['최상위 접기']);
  assert.match(html, /wiki-toc-level-1[^]*?최상위 접기/);
  assert.equal(html.includes('<h2 id="한쪽만">'), false);
  assert.match(html, /<p>본문<br \/>==# 한쪽만 ==<\/p>/);
});

test('does not promote malformed or unsupported heading delimiters', () => {
  const sources = [
    '== 둘째 ===',
    '==== 넷째 ===',
    '===== 다섯째 ====',
    '===== 다섯째 ======',
    '======= 일곱째 =======',
    '=====무공백 다섯째=====',
    '==#무공백 접힌 제목#==',
    '==# 한쪽만 ==',
    '====== ======'
  ];
  const parsed = parseMarkup(sources.join('\n'));
  const html = renderDocument(parsed.ast);

  assert.deepEqual(parsed.headings, []);
  assert.equal(/<h[1-6]\b/.test(html), false);
  for (const source of sources) assert.equal(html.includes(source), true);
});

test('numbers TOC entries relative to the shallowest heading without flattening skipped levels', () => {
  const parsed = parseMarkup('[목차]\n=== 먼저 나온 하위 ===\n== 뒤의 상위 ==\n====== 건너뛴 깊이 ======');
  const html = renderDocument(parsed.ast);

  assert.match(html, /wiki-toc-level-2[^]*?<span>0\.1<\/span>먼저 나온 하위/);
  assert.match(html, /wiki-toc-level-1[^]*?<span>1<\/span>뒤의 상위/);
  assert.match(html, /wiki-toc-level-5[^]*?<span>1\.0\.0\.0\.1<\/span>건너뛴 깊이/);
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
  const template = parseMarkup('===== @제목=기본@ =====\n[[가이드/@문서@|@표시@]]\n{{{\n@제목@ [[비밀]]\n}}}');
  const expanded = applyIncludeParametersToAst(template.ast, {
    제목: '<script>안전</script>',
    문서: '시작',
    표시: "'''<b>주입 불가</b>'''"
  }, 'inc-2-');
  const html = renderDocument(expanded);

  assert.equal(expanded[0]?.type, 'heading');
  if (expanded[0]?.type === 'heading') {
    assert.equal(expanded[0].level, 5);
    assert.match(expanded[0].id, /^inc-2-/);
  }
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
    children: [{ type: 'heading', level: 6, text: '포함 제목', id: 'inc-1-포함-제목' }]
  });
  const html = renderDocument(ast);
  const toc = html.slice(html.indexOf('<nav class="wiki-toc"'), html.indexOf('</nav>') + 6);

  assert.match(toc, /부모 제목/);
  assert.equal(toc.includes('포함 제목'), false);
  assert.match(html, /id="inc-1-포함-제목"/);
});

test('parses and safely renders advanced NamuMark table controls', () => {
  const parsed = parseMarkup([
    '||<tablealign=center><tablewidth=80%><tablebgcolor=#f5f5f5><tablecolor=black><tablebordercolor=#336699><-2><^|2><:><width=120><height=40><bgcolor=#112233><color=white>[[파일:server.png|섬네일|서버 아이콘]]|| 오른쪽 ||',
    '||아래||||빈 셀 기반 병합||'
  ].join('\n'));
  const table = parsed.ast[0];

  assert.equal(table?.type, 'wiki_table');
  if (table?.type !== 'wiki_table') return;
  assert.deepEqual(table.options, {
    align: 'center',
    width: '80%',
    backgroundColor: '#f5f5f5',
    color: 'black',
    borderColor: '#336699'
  });
  assert.deepEqual({
    colspan: table.rows[0]?.cells[0]?.colspan,
    rowspan: table.rows[0]?.cells[0]?.rowspan,
    align: table.rows[0]?.cells[0]?.align,
    verticalAlign: table.rows[0]?.cells[0]?.verticalAlign,
    width: table.rows[0]?.cells[0]?.width,
    height: table.rows[0]?.cells[0]?.height,
    backgroundColor: table.rows[0]?.cells[0]?.backgroundColor,
    color: table.rows[0]?.cells[0]?.color
  }, {
    colspan: 2,
    rowspan: 2,
    align: 'center',
    verticalAlign: 'top',
    width: '120px',
    height: '40px',
    backgroundColor: '#112233',
    color: 'white'
  });
  assert.equal(table.rows[1]?.cells[1]?.colspan, 2);
  assert.equal(table.rows[0]?.cells[0]?.children[0]?.type, 'file');

  const html = renderDocument(parsed.ast, {
    files: {
      'server.png': {
        url: '/v1/files/public/server.png/raw',
        mimeType: 'image/png',
        originalName: 'server.png'
      }
    }
  });
  assert.match(html, /class="table-scroll table-center"/);
  assert.match(html, /class="table-scroll table-center" style="width:80%;margin-left:auto;margin-right:auto"/);
  assert.match(html, /class="component-table wiki-table" style="width:100%;color:black;background-color:#f5f5f5;border:2px solid #336699"/);
  assert.match(html, /colspan="2" rowspan="2"/);
  assert.match(html, /style="width:120px;height:40px;color:white;background-color:#112233;text-align:center;vertical-align:top"/);
  assert.match(html, /<span class="wiki-file wiki-file-inline thumb"><span class="wiki-file-frame"><img class="wiki-file-image" src="\/v1\/files\/public\/server\.png\/raw"/);
  assert.equal(html.includes('&lt;width=120&gt;'), false);
});

test('ignores unsafe table controls and reports a non-blocking warning', () => {
  const parsed = parseMarkup('||<tablewidth=100%;position:fixed><bgcolor=url(javascript:alert(1))>안전||');
  const html = renderDocument(parsed.ast);

  assert.equal(parsed.blockingErrors.length, 0);
  assert.equal(parsed.errors.some((error) => error.includes('표 제어자')), true);
  assert.equal(html.includes('position:fixed'), false);
  assert.equal(html.includes('javascript:'), false);
  assert.match(html, />안전<\/th>/);
});

test('renders NamuMark table captions and explicit header rows semantically', () => {
  const parsed = parseMarkup([
    '|[[서버 목록]]과 [[파일:table-icon.png|아이콘]]|',
    '||<thead>서버||<thead>상태||',
    '||MineWiki||온라인||'
  ].join('\n'));
  const table = parsed.ast[0];

  assert.equal(table?.type, 'wiki_table');
  if (table?.type !== 'wiki_table') return;
  assert.equal(table.caption.length, 3);
  assert.equal(table.rows[0]?.cells.every((cell) => cell.header), true);
  assert.deepEqual(parsed.links, ['서버 목록']);
  assert.deepEqual([...collectWikiFileNames(parsed.ast)], ['table-icon.png']);

  const html = renderDocument(parsed.ast, {
    files: {
      'table-icon.png': { url: '/table-icon.png', mimeType: 'image/png', originalName: 'table-icon.png' }
    }
  });
  assert.match(html, /<caption class="wiki-table-caption"><a class="wiki-link"/);
  assert.match(html, /<thead><tr><th>서버<\/th><th>상태<\/th><\/tr><\/thead>/);
  assert.match(html, /<tbody><tr><td>MineWiki<\/td><td>온라인<\/td><\/tr><\/tbody>/);
});

test('renders GitBook-style Markdown tables with alignment and mobile-safe wrappers', () => {
  const parsed = parseMarkup([
    '| 명령어 | 설명 | 상태 |',
    '| :--- | :---: | ---: |',
    '| `/spawn` | 스폰으로 이동 | 사용 가능 |',
    '| `a|b` | 이스케이프 \\| 포함 | 점검 중 |',
    '',
    '표 다음 문단'
  ].join('\n'));
  const table = parsed.ast[0];

  assert.equal(table?.type, 'wiki_table');
  if (table?.type !== 'wiki_table') return;
  assert.deepEqual(table.rows.map((row) => row.cells.map((cell) => cell.align)), [
    ['left', 'center', 'right'],
    ['left', 'center', 'right'],
    ['left', 'center', 'right']
  ]);
  assert.equal(table.rows[2]?.cells[0]?.children[0]?.type, 'text');
  assert.match(renderDocument(parsed.ast), /<div class="table-scroll"><table class="component-table wiki-table">/u);
  assert.match(renderDocument(parsed.ast), /<thead><tr><th style="text-align:left">명령어<\/th>/u);
  assert.match(renderDocument(parsed.ast), /이스케이프 \| 포함/u);
  assert.equal(parsed.ast[1]?.type, 'paragraph');
});

test('preserves validated light and dark NamuMark table colors for theme switching', () => {
  const parsed = parseMarkup('||<tablebgcolor=#ffffff,#101418><tablecolor=black,white><tablebordercolor=#336699,#88aadd><bgcolor=#eeeeee,#202830><color=#112233,#ddeeff>테마 셀||');
  const table = parsed.ast[0];

  assert.equal(table?.type, 'wiki_table');
  if (table?.type !== 'wiki_table') return;
  assert.deepEqual(table.options, {
    backgroundColor: '#ffffff', darkBackgroundColor: '#101418',
    color: 'black', darkColor: 'white',
    borderColor: '#336699', darkBorderColor: '#88aadd'
  });
  assert.equal(table.rows[0]?.cells[0]?.darkBackgroundColor, '#202830');
  assert.equal(table.rows[0]?.cells[0]?.darkColor, '#ddeeff');

  const html = renderDocument(parsed.ast);
  assert.match(html, /--wiki-dark-color:white/);
  assert.match(html, /--wiki-dark-background-color:#101418/);
  assert.match(html, /--wiki-dark-border-color:#88aadd/);
  assert.match(html, /--wiki-dark-color:#ddeeff/);
  assert.match(html, /--wiki-dark-background-color:#202830/);
});

test('rejects malformed light and dark color pairs without leaking CSS', () => {
  const parsed = parseMarkup('||<tablebgcolor=#fff,url(javascript:alert(1))><bgcolor=#fff,#000,red>안전||');
  const html = renderDocument(parsed.ast);

  assert.equal(parsed.errors.some((error) => error.includes('표 제어자')), true);
  assert.equal(html.includes('javascript:'), false);
  assert.equal(html.includes('--wiki-dark'), false);
});

test('applies row and visual-column table colors across rowspans with cell overrides', () => {
  const parsed = parseMarkup([
    '||<-2><|2>병합||<colbgcolor=#eeeeff,#111122><colcolor=#111133,#eeeeff>열 시작||',
    '||<rowbgcolor=#ffeeee,#221111><rowcolor=#331111,#eeeeee>병합 옆||',
    '||일반||일반 둘째||<bgcolor=#abcdef><color=navy>직접 지정||',
    '||<rowbgcolor=#fff4dd,#332211><rowcolor=#553311,#ffeecc>행 첫째||행 둘째||'
  ].join('\n'));
  const table = parsed.ast[0];

  assert.equal(table?.type, 'wiki_table');
  if (table?.type !== 'wiki_table') return;

  const columnOrigin = table.rows[0]?.cells[1];
  const shiftedByRowspan = table.rows[1]?.cells[0];
  const unstyledFirstColumn = table.rows[2]?.cells[0];
  const directOverride = table.rows[2]?.cells[2];
  const rowStyled = table.rows[3];

  assert.deepEqual({
    backgroundColor: columnOrigin?.backgroundColor,
    darkBackgroundColor: columnOrigin?.darkBackgroundColor,
    color: columnOrigin?.color,
    darkColor: columnOrigin?.darkColor
  }, {
    backgroundColor: '#eeeeff',
    darkBackgroundColor: '#111122',
    color: '#111133',
    darkColor: '#eeeeff'
  });
  assert.deepEqual({
    backgroundColor: shiftedByRowspan?.backgroundColor,
    darkBackgroundColor: shiftedByRowspan?.darkBackgroundColor,
    color: shiftedByRowspan?.color,
    darkColor: shiftedByRowspan?.darkColor
  }, {
    backgroundColor: '#eeeeff',
    darkBackgroundColor: '#111122',
    color: '#111133',
    darkColor: '#eeeeff'
  });
  assert.equal(unstyledFirstColumn?.backgroundColor, undefined);
  assert.deepEqual({
    backgroundColor: directOverride?.backgroundColor,
    darkBackgroundColor: directOverride?.darkBackgroundColor,
    color: directOverride?.color,
    darkColor: directOverride?.darkColor
  }, {
    backgroundColor: '#abcdef',
    darkBackgroundColor: undefined,
    color: 'navy',
    darkColor: undefined
  });
  assert.deepEqual({
    backgroundColor: rowStyled?.backgroundColor,
    darkBackgroundColor: rowStyled?.darkBackgroundColor,
    color: rowStyled?.color,
    darkColor: rowStyled?.darkColor
  }, {
    backgroundColor: '#fff4dd',
    darkBackgroundColor: '#332211',
    color: '#553311',
    darkColor: '#ffeecc'
  });

  const html = renderDocument(parsed.ast);
  assert.match(html, /<tr style="color:#553311;background-color:#fff4dd;--wiki-dark-color:#ffeecc;--wiki-dark-background-color:#332211">/);
  assert.match(html, /style="color:#111133;background-color:#eeeeff;--wiki-dark-color:#eeeeff;--wiki-dark-background-color:#111122">병합 옆/);
  assert.match(html, /style="color:navy;background-color:#abcdef">직접 지정/);
  assert.equal(html.includes('rowbgcolor'), false);
  assert.equal(html.includes('colbgcolor'), false);
});

test('consumes invalid row and column colors without exposing unsafe syntax', () => {
  const parsed = parseMarkup('||<rowbgcolor=url(javascript:alert(1))><colcolor=#fff,#000,red>안전||');
  const html = renderDocument(parsed.ast);

  assert.equal(parsed.blockingErrors.length, 0);
  assert.equal(parsed.errors.filter((error) => error.includes('표 제어자')).length, 2);
  assert.equal(html.includes('javascript:'), false);
  assert.equal(html.includes('rowbgcolor'), false);
  assert.equal(html.includes('colcolor'), false);
  assert.match(html, />안전<\/th>/);
});

test('accepts compact NamuMark table captions and interpolates include parameters safely', () => {
  const parsed = parseMarkup('|@제목@|||<thead>열||\n||@값@||');
  const table = parsed.ast[0];
  assert.equal(table?.type, 'wiki_table');
  if (table?.type !== 'wiki_table') return;

  const expanded = applyIncludeParametersToAst(parsed.ast, {
    제목: '<script>표</script>',
    값: "'''문법 아님'''"
  }, 'inc-');
  const html = renderDocument(expanded);

  assert.equal(html.includes('<script>'), false);
  assert.match(html, /<caption class="wiki-table-caption">&lt;script&gt;표&lt;\/script&gt;<\/caption>/);
  assert.match(html, /<tbody><tr><td>'''문법 아님'''<\/td><\/tr><\/tbody>/);
});

test('parses nested unordered and ordered NamuMark lists with start values', () => {
  const parsed = parseMarkup([
    ' * 첫 항목',
    '  * 하위 항목',
    '   1.#3 세 번째부터',
    '   1. 네 번째',
    '  * 하위 형제',
    ' * 둘째 항목',
    ' a.#2 알파벳 둘째',
    ' a. 알파벳 셋째',
    ' I. 로마 숫자'
  ].join('\n'));

  assert.equal(parsed.ast.length, 3);
  const root = parsed.ast[0];
  assert.equal(root?.type, 'list');
  if (root?.type !== 'list') return;
  assert.equal(root.kind, 'unordered');
  assert.equal(root.items.length, 2);
  assert.equal(root.items[0]?.nested[0]?.kind, 'unordered');
  assert.equal(root.items[0]?.nested[0]?.items[0]?.nested[0]?.kind, 'decimal');
  assert.equal(root.items[0]?.nested[0]?.items[0]?.nested[0]?.start, 3);

  const html = renderDocument(parsed.ast);
  assert.match(html, /<ul class="wiki-list"><li>첫 항목<ul class="wiki-list"><li>하위 항목<ol class="wiki-list" start="3">/);
  assert.match(html, /<ol class="wiki-list wiki-list-alpha" start="2" type="a">/);
  assert.match(html, /<ol class="wiki-list wiki-list-upper-roman" type="I">/);
});

test('bounds pathological list nesting before recursive rendering', () => {
  const parsed = parseMarkup(Array.from({ length: 80 }, (_, index) => `${' '.repeat(index + 1)}* 단계 ${index + 1}`).join('\n'));
  const html = renderDocument(parsed.ast);

  assert.equal(parsed.blockingErrors.some((error) => error.includes('32단계')), true);
  assert.match(html, /단계 80/);
});

test('supports inline file markup in prose and table cells without creating document links', () => {
  const parsed = parseMarkup('아이콘 [[파일:icon.webp|작은 아이콘]] 뒤 문장\n||이름||[[파일:icon.webp|섬네일|표 아이콘]]||');
  const html = renderDocument(parsed.ast, {
    files: {
      'icon.webp': {
        url: '/v1/files/public/icon.webp/raw',
        mimeType: 'image/webp',
        originalName: 'icon.webp'
      }
    }
  });

  assert.deepEqual(parsed.links, []);
  assert.equal((html.match(/<img /g) ?? []).length, 2);
  assert.match(html, /alt="작은 아이콘"/);
  assert.match(html, /alt="표 아이콘"/);
  assert.match(html, /<p>아이콘 <span class="wiki-file wiki-file-inline">/);
  assert.equal(html.includes('<p>아이콘 <figure'), false);
});

test('supports bounded thetree-compatible file display options', () => {
  const parsed = parseMarkup('[[파일:scene.webp|섬네일|width=640&height=360&align=center&bgcolor=%23112233&border-radius=24&rendering=high-quality&object-fit=cover&theme=dark&alt=%EC%95%BC%EA%B0%84+%EC%9E%A5%EB%A9%B4&caption=%EB%8C%80%ED%91%9C+%ED%99%94%EB%A9%B4]]');
  const html = renderDocument(parsed.ast, {
    files: {
      'scene.webp': { url: '/files/scene.webp', mimeType: 'image/webp', originalName: 'scene.webp' }
    }
  });

  assert.equal(parsed.blockingErrors.length, 0);
  assert.equal(parsed.errors.some((error) => error.includes('파일 옵션')), false);
  const fileNode = parsed.ast[0];
  assert.equal(fileNode?.type, 'file');
  if (fileNode?.type !== 'file') return;
  assert.deepEqual(fileNode.display, {
    width: '640px', height: '360px', align: 'center', backgroundColor: '#112233', borderRadius: '24px',
    rendering: 'high-quality', objectFit: 'cover', theme: 'dark', alt: '야간 장면'
  });
  assert.match(html, /class="wiki-file thumb wiki-file-align-center wiki-theme-dark"/);
  assert.match(html, /class="wiki-file-frame" style="width:640px;height:360px;background-color:#112233"/);
  assert.match(html, /class="wiki-file-image"[^>]+alt="야간 장면"[^>]+style="width:100%;height:100%;border-radius:24px;image-rendering:high-quality;object-fit:cover"/);
  assert.match(html, /<figcaption>대표 화면<\/figcaption>/);
});

test('bounds duplicate and excessive file option input without throwing', () => {
  const extras = Array.from({ length: 20 }, (_, index) => `unknown${index}=x`).join('&');
  const parsed = parseMarkup(`[[파일:safe.png|width=320&width=640&${extras}]]`);
  const html = renderDocument(parsed.ast, {
    files: { 'safe.png': { url: '/safe.png', mimeType: 'image/png', originalName: 'safe.png' } }
  });

  assert.equal(parsed.errors.includes('파일 옵션이 중복되었습니다: width'), true);
  assert.equal(parsed.errors.includes('파일 옵션은 16개까지 사용할 수 있습니다.'), true);
  assert.match(html, /style="width:320px"/);
  assert.equal(html.includes('640px'), false);
});

test('keeps legacy captions while safely decoding explicit caption delimiters', () => {
  const legacy = renderDocument(parseMarkup('[[파일:safe.png|Rock & Roll = Live]]').ast, {
    files: { 'safe.png': { url: '/safe.png', mimeType: 'image/png', originalName: 'safe.png' } }
  });
  const explicit = renderDocument(parseMarkup('[[파일:safe.png|caption=Rock+%26+Roll+%3D+Live&alt=A%7CB%5DC]]').ast, {
    files: { 'safe.png': { url: '/safe.png', mimeType: 'image/png', originalName: 'safe.png' } }
  });

  assert.match(legacy, /Rock &amp; Roll = Live/);
  assert.match(explicit, /alt="A\|B\]C"/);
  assert.match(explicit, /Rock &amp; Roll = Live/);
});

test('drops unsafe or excessive file display values without leaking CSS', () => {
  const parsed = parseMarkup('[[파일:safe.png|width=999999&height=expression(alert(1))&align=fixed&bgcolor=url(javascript:alert(1))&border-radius=9999&rendering=evil&object-fit=javascript&theme=system&alt=<img src=x>]]');
  const html = renderDocument(parsed.ast, {
    files: {
      'safe.png': { url: '/files/safe.png', mimeType: 'image/png', originalName: 'safe.png' }
    }
  });

  assert.equal(parsed.errors.filter((error) => error.includes('파일 옵션 값이 올바르지 않습니다')).length, 8);
  assert.equal(html.includes('javascript:'), false);
  assert.equal(html.includes('expression('), false);
  assert.equal(html.includes('999999'), false);
  assert.match(html, /alt="&lt;img src=x&gt;"/);
});

test('interpolates file display options through includes and revalidates them', () => {
  const source = parseMarkup('[[파일:@파일@|width=@너비@&align=@정렬@&object-fit=@맞춤@&alt=@대체@|@캡션@]]');
  const expanded = applyIncludeParametersToAst(source.ast, {
    파일: 'safe.png', 너비: '320', 정렬: 'right', 맞춤: 'contain', 대체: '안전 이미지', 캡션: '설명'
  }, 'inc-');
  const html = renderDocument(expanded, {
    files: {
      'safe.png': { url: '/files/safe.png', mimeType: 'image/png', originalName: 'safe.png' }
    }
  });

  assert.match(html, /wiki-file-align-right/);
  assert.match(html, /style="width:320px"/);
  assert.match(html, /alt="안전 이미지"/);
  assert.match(html, /<figcaption>설명<\/figcaption>/);
});

test('collects file dependencies from every block and inline container', () => {
  const parsed = parseMarkup([
    '[[파일:block.png]]',
    '본문 [[파일:inline.png|아이콘]]',
    ' * 목록 [[파일:list.png]]',
    '||셀 [[파일:table.png]]||',
    '{{{#!folding 접기',
    '[[파일:fold.png]]',
    '}}}',
  ].join('\n'));

  assert.deepEqual([...collectWikiFileNames(parsed.ast)].sort(), [
    'block.png',
    'fold.png',
    'inline.png',
    'list.png',
    'table.png',
  ]);
});

test('renders explicit safe placeholders for unsupported macros', () => {
  const parsed = parseMarkup('영상은 [navertv(123)], 선택은 [vote(항목)]이고 [[문서]]와 [https://example.com 외부]는 링크다.');
  const html = renderDocument(parsed.ast);

  assert.deepEqual(
    parsed.errors.filter((error) => error.startsWith('지원되지 않는 매크로입니다:')),
    ['지원되지 않는 매크로입니다: navertv', '지원되지 않는 매크로입니다: vote']
  );
  assert.match(html, /<span class="wiki-macro-warning" title="지원되지 않는 매크로">지원하지 않는 매크로: \[navertv\]<\/span>/);
  assert.match(html, />지원하지 않는 매크로: \[vote\]<\/span>/);
  assert.match(html, /class="wiki-link"/);
  assert.match(html, /href="https:\/\/example\.com"/);
});

test('renders cache-safe pagecount markers with an optional namespace', () => {
  const parsed = parseMarkup('[pagecount] [pagecount(서버)]');
  const html = renderDocument(parsed.ast);

  assert.equal(parsed.errors.some((error) => error.includes('지원되지 않는 매크로')), false);
  assert.match(html, /data-wiki-stat="pagecount" aria-label="문서 수">…<\/output>/);
  assert.match(html, /data-wiki-stat="pagecount" data-wiki-namespace="서버" aria-label="문서 수">…<\/output>/);
});

test('renders cache-safe semantic markers for date, datetime, age, and dday macros', () => {
  const parsed = parseMarkup('[date] [datetime] [age(2020-02-29)] [dday(2030-01-02)]');
  const html = renderDocument(parsed.ast);

  assert.deepEqual(
    parsed.errors.filter((error) => error.includes('매크로') || error.startsWith('지원되지 않는')),
    [],
  );
  assert.equal(parsed.ast[0]?.type, 'paragraph');
  assert.match(html, /<time class="wiki-dynamic-time" data-wiki-time="datetime">현재 시각<\/time>/);
  assert.equal((html.match(/data-wiki-time="datetime"/g) ?? []).length, 2);
  assert.match(html, /<time class="wiki-dynamic-time" data-wiki-time="age" data-wiki-date="2020-02-29" datetime="2020-02-29">2020-02-29<\/time>/);
  assert.match(html, /<time class="wiki-dynamic-time" data-wiki-time="dday" data-wiki-date="2030-01-02" datetime="2030-01-02">2030-01-02<\/time>/);
});

test('rejects malformed and impossible dynamic macro dates without normalizing them', () => {
  const parsed = parseMarkup('[age(2023-02-29)] [dday(2024-02-30)] [age(2024-2-01)]');
  const html = renderDocument(parsed.ast);

  assert.deepEqual(
    parsed.errors.filter((error) => error.includes('매크로 날짜')),
    [
      'age 매크로 날짜는 YYYY-MM-DD 형식의 실제 날짜여야 합니다.',
      'dday 매크로 날짜는 YYYY-MM-DD 형식의 실제 날짜여야 합니다.',
    ],
  );
  assert.equal(html.includes('data-wiki-time='), false);
  assert.equal((html.match(/wiki-macro-warning/g) ?? []).length, 3);
});

test('preserves dynamic macro markers while applying include parameters safely', () => {
  const parsed = parseMarkup('[age(2020-01-02)] [date]');
  const expanded = applyIncludeParametersToAst(parsed.ast, { date: '2022-03-04' }, 'inc-');
  const html = renderDocument(expanded);

  assert.match(html, /data-wiki-time="age" data-wiki-date="2020-01-02"/);
  assert.match(html, /data-wiki-time="datetime"/);
  assert.equal(html.includes('2022-03-04'), false);
});

test('renders footnote and Korean footnote markers at their document positions without duplicate ids', () => {
  const parsed = parseMarkup('첫 문장[* 첫 각주]\n[footnote]\n둘째 문장[* 둘째 각주]\n[각주]');
  const html = renderDocument(parsed.ast);

  assert.equal(parsed.errors.some((error) => error.includes('지원되지 않는 매크로')), false);
  assert.equal((html.match(/<section class="footnotes">/g) ?? []).length, 2);
  assert.equal((html.match(/id="fn-1"/g) ?? []).length, 1);
  assert.equal((html.match(/id="fn-2"/g) ?? []).length, 1);
  assert.match(html, /id="fn-1">첫 각주 <span class="wiki-footnote-backlinks"[^>]*><a href="#fnref-1-1"[^>]*>↩<\/a><\/span><\/li><\/ol><\/section>\n<p>둘째 문장/);
  assert.match(html, /<ol start="2"><li id="fn-2">둘째 각주 <span class="wiki-footnote-backlinks"/);
  assert.ok(html.indexOf('id="fn-1"') < html.indexOf('둘째 문장'));
  assert.ok(html.indexOf('둘째 문장') < html.indexOf('id="fn-2"'));
});

test('keeps an early footnote marker empty and appends later notes once', () => {
  const parsed = parseMarkup('[각주]\n나중 각주[* 뒤에서 추가]');
  const html = renderDocument(parsed.ast);

  assert.equal((html.match(/<section class="footnotes">/g) ?? []).length, 1);
  assert.equal((html.match(/id="fn-1"/g) ?? []).length, 1);
  assert.ok(html.indexOf('나중 각주') < html.indexOf('id="fn-1"'));
});

test('reuses named footnotes with one note and a backlink for every reference', () => {
  const parsed = parseMarkup('첫 참조[*source 공식 문서]와 재참조[*source]\n[각주]');
  const html = renderDocument(parsed.ast);

  assert.deepEqual(parsed.footnotes, ['공식 문서']);
  assert.equal((html.match(/id="fn-1"/g) ?? []).length, 1);
  assert.equal((html.match(/href="#fn-1"/g) ?? []).length, 2);
  assert.match(html, /id="fnref-1-1"/);
  assert.match(html, /id="fnref-1-2"/);
  assert.match(html, /href="#fnref-1-1"[^>]*>↩1<\/a> <a href="#fnref-1-2"[^>]*>↩2<\/a>/);
});

test('updates backlinks when a named footnote is reused after an in-document marker', () => {
  const parsed = parseMarkup('첫 참조[*source 공식 문서]\n[각주]\n표시 뒤 재참조[*source]');
  const html = renderDocument(parsed.ast);

  assert.equal((html.match(/<section class="footnotes">/g) ?? []).length, 1);
  assert.match(html, /id="fn-1">공식 문서[^<]*<span class="wiki-footnote-backlinks"[^>]*><a href="#fnref-1-1"[^>]*>↩1<\/a> <a href="#fnref-1-2"[^>]*>↩2<\/a>/);
  assert.ok(html.indexOf('id="fn-1"') < html.indexOf('표시 뒤 재참조'));
});

test('resolves forward named references and XML-style reusable notes safely', () => {
  const parsed = parseMarkup('먼저[*later] XML<ref name="xml" />\n정의[*later 나중 정의] <ref name="xml">XML 정의</ref>');
  const html = renderDocument(parsed.ast);

  assert.match(html, /id="fn-1">나중 정의/);
  assert.match(html, /id="fn-2">XML 정의/);
  assert.equal((html.match(/href="#fn-1"/g) ?? []).length, 2);
  assert.equal((html.match(/href="#fn-2"/g) ?? []).length, 2);
  assert.equal(html.includes('<ref'), false);
});

test('renders an explicit safe label for an undefined named footnote', () => {
  const parsed = parseMarkup('미정의 참조[*missing]');
  const html = renderDocument(parsed.ast);

  assert.match(html, /id="fn-1">정의되지 않은 각주: missing/);
  assert.equal(html.includes('undefined'), false);
});

test('renders safe static NamuMark macros without falling back to warnings', () => {
  const parsed = parseMarkup('첫 줄[br]둘째 줄[clearfix][anchor(문단 1)][ruby(한자,ruby=漢字,color=#336699)]');
  const html = renderDocument(parsed.ast);

  assert.deepEqual(parsed.errors.filter((error) => error.startsWith('지원되지 않는 매크로입니다:')), []);
  assert.match(html, /첫 줄<br \/>둘째 줄<span class="wiki-clearfix"><\/span>/);
  assert.match(html, /<span class="wiki-anchor" id="문단_1"><\/span>/);
  assert.match(html, /<ruby>한자<rp>\(<\/rp><rt><span style="color:#336699">漢字<\/span><\/rt><rp>\)<\/rp><\/ruby>/);
});

test('renders privacy-enhanced responsive YouTube macros with bounded playback options', () => {
  const parsed = parseMarkup('[youtube(dQw4w9WgXcQ,width=800,height=450,start=12,end=60)]');
  const html = renderDocument(parsed.ast);

  assert.equal(parsed.errors.some((error) => error.includes('YouTube') || error.includes('지원되지 않는 매크로')), false);
  assert.match(html, /class="wiki-media-wrapper"/);
  assert.match(html, /max-width:800px/);
  assert.match(html, /aspect-ratio:800 \/ 450/);
  assert.match(html, /src="https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?start=12&amp;end=60"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /sandbox="allow-scripts allow-same-origin allow-presentation"/);
  assert.equal(html.includes('youtube.com/embed'), false);
});

test('keeps malformed or unsafe YouTube macros inert', () => {
  const inputs = [
    '[youtube(javascript:alert(1))]',
    '[youtube(dQw4w9WgXcQ,width=99999)]',
    '[youtube(dQw4w9WgXcQ,start=60,end=12)]',
    '[youtube(dQw4w9WgXcQ,start=<script>)]'
  ];
  for (const input of inputs) {
    const parsed = parseMarkup(input);
    const html = renderDocument(parsed.ast);
    assert.match(parsed.errors.join('\n'), /YouTube 매크로/u);
    assert.match(html, /지원하지 않는 매크로: \[youtube\]/u);
    assert.equal(html.includes('<iframe'), false);
    assert.equal(html.includes('javascript:'), false);
    assert.equal(html.includes('<script>'), false);
  }
});

test('keeps malformed and unsafe static macros inert', () => {
  const parsed = parseMarkup('[anchor(<script>)][ruby(본문,ruby=후리가나,color=url(javascript:alert(1)))]');
  const html = renderDocument(parsed.ast);

  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('javascript:'), false);
  assert.match(html, /지원하지 않는 매크로: \[anchor\]/);
  assert.match(html, /<ruby>본문<rp>\(<\/rp><rt>후리가나<\/rt>/);
});

test('interpolates include parameters through nested lists and advanced table cells as plain data', () => {
  const source = parseMarkup(' * @항목@\n  1. @하위@\n||<bgcolor=#fff>[[파일:@파일@|@설명@]]||');
  const expanded = applyIncludeParametersToAst(source.ast, {
    항목: '<script>상위</script>',
    하위: "'''문법 아님'''",
    파일: 'safe.png',
    설명: '<b>설명</b>'
  }, 'inc-');
  const html = renderDocument(expanded, {
    files: {
      'safe.png': { url: '/safe.png', mimeType: 'image/png', originalName: 'safe.png' }
    }
  });

  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;상위&lt;\/script&gt;/);
  assert.match(html, /'''문법 아님'''/);
  assert.match(html, /alt="&lt;b&gt;설명&lt;\/b&gt;"/);
});

test('parses wiki style blocks before generic components and renders only writing-mode', () => {
  for (const writingMode of ['horizontal-tb', 'vertical-rl', 'vertical-lr'] as const) {
    const parsed = parseMarkup(`{{{#!wiki style="writing-mode: ${writingMode};"\n세로 본문\n}}}`);
    const node = parsed.ast[0];
    assert.equal(node?.type, 'wiki_style');
    if (node?.type !== 'wiki_style') continue;
    assert.equal(node.writingMode, writingMode);
    assert.equal(node.children[0]?.type, 'paragraph');
    assert.equal(parsed.errors.filter((error) => error === '문서 상태 컴포넌트가 없습니다.').length, 1);
    assert.match(renderDocument(parsed.ast), new RegExp(`<div class="wiki-style" style="writing-mode:${writingMode}"><p>세로 본문</p></div>`));
  }
});

test('wiki style blocks preserve recursive links, categories, includes, files and searchable text', () => {
  const parsed = parseMarkup([
    '{{{#!wiki style="writing-mode:vertical-rl"',
    '[[가이드|링크]] [[분류:안내]]',
    '[include(틀:안내)]',
    '[[파일:inside.png]]',
    '}}}'
  ].join('\n'));

  assert.deepEqual(parsed.links, ['가이드']);
  assert.deepEqual(parsed.categories, ['안내']);
  assert.deepEqual(parsed.includes, ['틀:안내']);
  assert.deepEqual([...collectWikiLinkTargets(parsed.ast)], ['가이드']);
  assert.deepEqual([...collectWikiFileNames(parsed.ast)], ['inside.png']);
  assert.match(parsed.plainText, /링크/);
  const style = parsed.ast[0];
  assert.equal(style?.type, 'wiki_style');
  if (style?.type === 'wiki_style') {
    assert.ok(style.children.some((node) => node.type === 'include'));
  }
});

test('wiki style ignores arbitrary CSS and tag, class, onclick and dark-style attributes', () => {
  const sources = [
    '{{{#!wiki style="position:fixed;writing-mode:vertical-rl" tag="a" class="admin" onclick="alert(1)"\n본문\n}}}',
    '{{{#!wiki dark-style="writing-mode:vertical-lr"\n본문\n}}}',
    '{{{#!wiki style="writing-mode:sideways-rl"\n본문\n}}}',
    '{{{#!wiki style="writing-mode:vertical-rl;background:url(javascript:alert(1))"\n본문\n}}}'
  ];
  for (const source of sources) {
    const parsed = parseMarkup(source);
    const html = renderDocument(parsed.ast);
    assert.match(html, /^<div class="wiki-style"><p>본문<\/p><\/div>$/);
    assert.equal(html.includes('position:'), false);
    assert.equal(html.includes('javascript:'), false);
    assert.equal(html.includes('onclick'), false);
    assert.equal(html.includes('dark-style'), false);
    assert.equal(html.includes('class="admin"'), false);
    assert.equal(html.includes('<a'), false);
  }
});

test('wiki style safely preserves malformed, unclosed and nested block bodies', () => {
  const unclosed = parseMarkup('{{{#!wiki style="writing-mode:vertical-lr"\n[[남은 본문]]');
  assert.deepEqual(unclosed.links, ['남은 본문']);
  assert.match(renderDocument(unclosed.ast), /남은 본문/);
  assert.ok(unclosed.errors.some((error) => error.includes('닫히지 않은')));

  const nested = parseMarkup([
    '{{{#!wiki style="writing-mode:vertical-rl"',
    '바깥',
    '{{{#!wiki style="writing-mode:horizontal-tb"',
    '[[안쪽]]',
    '}}}',
    '끝',
    '}}}'
  ].join('\n'));
  const outer = nested.ast[0];
  assert.equal(outer?.type, 'wiki_style');
  if (outer?.type === 'wiki_style') assert.ok(outer.children.some((node) => node.type === 'wiki_style'));
  assert.deepEqual(nested.links, ['안쪽']);
  assert.match(renderDocument(nested.ast), /writing-mode:vertical-rl[^]*writing-mode:horizontal-tb/);
});

test('include interpolation reaches wiki style children while reserved calleeTitle wins', () => {
  const parsed = parseMarkup('{{{#!wiki style="writing-mode:vertical-rl"\n@calleeTitle@ · @값@ · [[@대상@]]\n}}}');
  const expanded = applyIncludeParametersToAst(parsed.ast, {
    calleeTitle: '사용자 위조',
    값: '<script>값</script>',
    대상: '안내'
  }, 'inc-', { calleeTitle: '서버:루나/대문' });
  const html = renderDocument(expanded);

  assert.match(html, /서버:루나\/대문/);
  assert.equal(html.includes('사용자 위조'), false);
  assert.match(html, /&lt;script&gt;값&lt;\/script&gt;/);
  assert.match(html, /href="\/wiki\/%EC%95%88%EB%82%B4"/);
  assert.equal(html.includes('<script>'), false);
});

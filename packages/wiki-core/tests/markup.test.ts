import test from 'node:test';
import assert from 'node:assert/strict';

import { applyIncludeParametersToAst, collectWikiFileNames, parseMarkup, renderDocument, WIKI_RENDERER_VERSION } from '../src/markup.js';
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
  assert.match(html, /<span class="wiki-file wiki-file-inline thumb"><img src="\/v1\/files\/public\/server\.png\/raw"/);
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
  const parsed = parseMarkup('오늘은 [date], 경과는 [age(2020-01-01)]이고 [[문서]]와 [https://example.com 외부]는 링크다.');
  const html = renderDocument(parsed.ast);

  assert.deepEqual(
    parsed.errors.filter((error) => error.startsWith('지원되지 않는 매크로입니다:')),
    ['지원되지 않는 매크로입니다: date', '지원되지 않는 매크로입니다: age']
  );
  assert.match(html, /<span class="wiki-macro-warning" title="지원되지 않는 매크로">지원하지 않는 매크로: \[date\]<\/span>/);
  assert.match(html, />지원하지 않는 매크로: \[age\]<\/span>/);
  assert.equal(html.includes('2020-01-01'), false);
  assert.match(html, /class="wiki-link"/);
  assert.match(html, /href="https:\/\/example\.com"/);
});

test('renders safe static NamuMark macros without falling back to warnings', () => {
  const parsed = parseMarkup('첫 줄[br]둘째 줄[clearfix][anchor(문단 1)][ruby(한자,ruby=漢字,color=#336699)]');
  const html = renderDocument(parsed.ast);

  assert.deepEqual(parsed.errors.filter((error) => error.startsWith('지원되지 않는 매크로입니다:')), []);
  assert.match(html, /첫 줄<br \/>둘째 줄<span class="wiki-clearfix"><\/span>/);
  assert.match(html, /<span class="wiki-anchor" id="문단_1"><\/span>/);
  assert.match(html, /<ruby>한자<rp>\(<\/rp><rt><span style="color:#336699">漢字<\/span><\/rt><rp>\)<\/rp><\/ruby>/);
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateConditionalExpression } from '../src/conditional.js';
import { applyIncludeParametersToAst, parseMarkup, renderDocument } from '../src/markup.js';

test('evaluates only the bounded conditional expression language', () => {
  const params = { edition: 'java', enabled: 'yes', count: '2', empty: '' };

  assert.deepEqual(evaluateConditionalExpression('edition == "java" && defined(enabled)', params), {
    value: true,
    error: null,
  });
  assert.equal(evaluateConditionalExpression('!empty && (count == 2 || false)', params).value, true);
  assert.equal(evaluateConditionalExpression('calleeTitle == "서버:루나"', params, { calleeTitle: '서버:루나' }).value, true);
  assert.equal(evaluateConditionalExpression('defined(missing)', params).value, false);
});

test('fails closed for executable, malformed and over-complex conditions', () => {
  for (const expression of [
    'process.exit()',
    'value.constructor',
    'defined("value")',
    'value = "x"',
    '('.repeat(17) + 'true' + ')'.repeat(17),
    'x'.repeat(513),
  ]) {
    const result = evaluateConditionalExpression(expression, { value: 'x' });
    assert.equal(result.value, false, expression);
    assert.ok(result.error, expression);
  }
});

test('parses and renders literal conditional blocks without exposing hidden content', () => {
  const parsed = parseMarkup([
    '{{{#!if true',
    '표시됨',
    '}}}',
    '{{{#!if false',
    '숨김 [[비밀 문서]]',
    '}}}',
  ].join('\n'));

  assert.equal(parsed.blockingErrors.length, 0);
  assert.equal(parsed.ast[0]?.type, 'conditional');
  assert.equal(parsed.ast[1]?.type, 'conditional');
  const html = renderDocument(parsed.ast);
  assert.match(html, /표시됨/u);
  assert.doesNotMatch(html, /숨김|비밀 문서/u);
});

test('reevaluates conditional blocks against include parameters as plain data', () => {
  const parsed = parseMarkup([
    '{{{#!if edition == "java" && defined(version)',
    '@edition@ @version@ [[설치]]',
    '}}}',
    '{{{#!if edition == "bedrock"',
    '{{틀:비공개}}',
    '}}}',
  ].join('\n'));

  const expanded = applyIncludeParametersToAst(
    parsed.ast,
    { edition: 'java', version: '<script>alert(1)</script>' },
    'inc-1-',
  );
  const first = expanded[0];
  const second = expanded[1];
  assert.equal(first?.type, 'conditional');
  assert.equal(first?.type === 'conditional' ? first.state : null, 'visible');
  assert.equal(second?.type === 'conditional' ? second.state : null, 'hidden');
  const html = renderDocument(expanded);
  assert.match(html, /java &lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /href="\/wiki\/%EC%84%A4%EC%B9%98"/u);
  assert.doesNotMatch(html, /틀:비공개/u);
});

test('reports invalid conditional syntax as a non-blocking warning', () => {
  const parsed = parseMarkup('{{{#!if value.constructor\n숨김\n}}}');
  assert.equal(parsed.blockingErrors.length, 0);
  assert.ok(parsed.errors.some((error) => error.startsWith('조건식 오류:')));
  assert.equal(renderDocument(parsed.ast), '');
});

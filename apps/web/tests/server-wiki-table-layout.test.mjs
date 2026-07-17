import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'u'));
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

test('server wiki tables preserve natural cell sizing inside a horizontal scroller', () => {
  const wrapper = ruleBody('.server-wiki-layout .wiki-rendered .table-scroll');
  const table = ruleBody('.server-wiki-layout .wiki-rendered .table-scroll table');
  const cells = ruleBody('.server-wiki-layout .wiki-rendered .table-scroll :is(th, td)');

  assert.match(wrapper, /width:\s*100%/u);
  assert.match(wrapper, /min-width:\s*0/u);
  assert.match(wrapper, /max-width:\s*100%/u);
  assert.match(wrapper, /overflow-x:\s*auto/u);
  assert.match(wrapper, /overflow-y:\s*hidden/u);
  assert.match(wrapper, /overscroll-behavior-x:\s*none/u);
  assert.match(table, /width:\s*100%/u);
  assert.doesNotMatch(table, /min-width:\s*0/u);
  assert.match(table, /table-layout:\s*auto/u);
  assert.match(table, /border-collapse:\s*collapse/u);
  assert.doesNotMatch(table, /width:\s*max-content/u);
  assert.doesNotMatch(cells, /min-width:\s*8rem/u);
  assert.doesNotMatch(cells, /min-width:\s*0/u);
  assert.match(cells, /overflow-wrap:\s*normal/u);
  assert.doesNotMatch(cells, /overflow-wrap:\s*anywhere/u);
});

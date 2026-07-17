import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

test('wiki indentation uses responsive bounded spacing without a new layout system', () => {
  assert.match(styles, /\.wiki-rendered \.wiki-indent\s*\{[^}]*mt-4 min-w-0 border-l border-white\/10[^}]*margin-inline-start:\s*clamp\(0\.125rem, 1vw, 0\.75rem\)[^}]*padding-inline-start:\s*clamp\(0\.5rem, 2vw, 1rem\)[^}]*overflow-wrap:\s*anywhere/su);
  assert.match(styles, /\.wiki-rendered \.wiki-indent > :first-child\s*\{[^}]*mt-0/su);
  assert.match(styles, /\.wiki-rendered \.wiki-indent \.wiki-indent\s*\{[^}]*margin-inline-start:\s*0[^}]*padding-inline-start:\s*clamp\(0\.375rem, 1\.5vw, 0\.75rem\)/su);
  assert.match(styles, /\.server-wiki-layout \.wiki-rendered \.wiki-indent\s*\{[^}]*border-color:\s*#d6dbe5/su);
});

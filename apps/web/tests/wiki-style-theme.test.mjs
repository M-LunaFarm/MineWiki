import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

test('rich wiki blocks apply bounded layout and all dark-theme variables', () => {
  assert.match(styles, /\.wiki-rendered \.wiki-style\s*\{[^}]*max-width:\s*100%/su);
  assert.match(styles, /\.wiki-rendered \.wiki-style\s*\{[^}]*overflow-wrap:\s*anywhere/su);
  assert.match(styles, /html\[data-theme='dark'\] \.wiki-rendered \[style\*='--wiki-dark-color'\][^{]*\{[^}]*color:\s*var\(--wiki-dark-color\)\s*!important/su);
  assert.match(styles, /html\[data-theme='dark'\] \.wiki-rendered \[style\*='--wiki-dark-background-color'\][^{]*\{[^}]*background-color:\s*var\(--wiki-dark-background-color\)\s*!important/su);
  assert.match(styles, /html\[data-theme='dark'\] \.wiki-rendered \[style\*='--wiki-dark-border-color'\][^{]*\{[^}]*border-color:\s*var\(--wiki-dark-border-color\)\s*!important/su);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

test('server wiki rendered content overrides light ink in dark mode', () => {
  assert.match(styles, /html\[data-theme='dark'\] \.server-wiki-layout \.wiki-rendered\s*\{[^}]*color:\s*#dce5ee/su);
  assert.match(styles, /html\[data-theme='dark'\] \.server-wiki-layout \.wiki-rendered :is\(h1, h2, h3, h4, h5, h6\)\s*\{[^}]*color:\s*#f4f7fa/su);
  assert.ok(contrastRatio('#dce5ee', '#0b1118') >= 7, 'body copy must meet WCAG AAA contrast');
});

function contrastRatio(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/giu)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const styles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

test('server wiki rendered content overrides light ink in dark mode', () => {
  assert.match(styles, /html\[data-theme='dark'\] \.server-wiki-layout \.wiki-rendered\s*\{[^}]*color:\s*#dce5ee/su);
  assert.match(styles, /html\[data-theme='dark'\] \.server-wiki-layout \.wiki-rendered :is\(h1, h2, h3, h4, h5, h6\)\s*\{[^}]*color:\s*#f4f7fa/su);
  assert.ok(contrastRatio('#dce5ee', '#0b1118') >= 7, 'body copy must meet WCAG AAA contrast');
});

test('tenant accent colors are normalized for both themes and focus states', async () => {
  const [helper, article, workspace, header, sidebar, settings] = await Promise.all([
    readFile(new URL('../lib/server-wiki-theme-colors.ts', import.meta.url), 'utf8'),
    readFile(new URL('../components/wiki/server-wiki-article-view.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/wiki/server-wiki-workspace.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/wiki/server-wiki-header.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/wiki/server-wiki-sidebar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/wiki/server-wiki-settings.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(helper, /contrast\(color, surface\) >= 4\.5/u);
  assert.match(helper, /--server-wiki-accent-light/u);
  assert.match(helper, /--server-wiki-accent-dark/u);
  assert.match(article, /serverWikiThemeStyle/u);
  assert.match(workspace, /serverWikiThemeStyle/u);
  assert.match(header, /server-wiki-accent-chip/u);
  assert.match(sidebar, /server-wiki-accent-text/u);
  assert.doesNotMatch(sidebar, /style=\{\{ color: brand\?\.accentColor/u);
  assert.match(styles, /\.server-wiki-layout :is\(a, button, input, select, textarea, summary\):focus-visible/u);
  assert.match(settings, /server-wiki-settings-savebar/u);
  assert.match(settings, /server-wiki-accent-preview/u);
  assert.match(settings, /serverWikiThemeStyle\(form\.brandAccentColor\)/u);
  assert.match(styles, /html\[data-theme='light'\] \.server-wiki-settings-savebar/u);
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

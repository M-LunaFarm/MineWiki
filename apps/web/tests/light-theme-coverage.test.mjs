import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('light theme covers shared authenticated and admin surface palettes', async () => {
  const [css, accountPage, adminLayout, header] = await Promise.all([
    readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
    readFile(new URL('../app/me/account-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/admin/layout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/layout/site-header.tsx', import.meta.url), 'utf8'),
  ]);

  for (const token of [
    "bg-[#181a1d]",
    "bg-[#111315]",
    "bg-[#151922]",
    "bg-[#101216]",
    "bg-[#17191c]",
    "bg-[#101214]",
    "bg-[#15181b]",
    "bg-[#10231e]",
    "bg-[#26312d]",
    "border-[#333333]",
    "border-[#30343b]",
    "text-[#a0a0a0]",
    "text-[#35e5b7]",
  ]) {
    assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }

  assert.match(accountPage, /account-surface/u);
  assert.match(adminLayout, /admin-surface/u);
  assert.match(header, /site-header/u);
  assert.match(css, /\.site-header \.header-search-results/u);
  assert.match(css, /\.account-surface \[class\*='text-\[#c3cbd4\]'\]/u);
  assert.match(css, /\.account-surface \[class\*='text-amber-50'\]/u);
  assert.match(css, /\.account-surface \[class\*='text-emerald-100'\]/u);
  assert.match(css, /\.account-surface \[class\*='text-blue-100'\]/u);
});

test('light theme preserves branded and destructive button labels', async () => {
  const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

  assert.match(css, /bg-\[#5865f2\]/u);
  assert.match(css, /bg-\[#5865F2\]/u);
  assert.match(css, /bg-red-/u);
  assert.match(css, /color: #ffffff/u);
});

test('theme toggle synchronizes the saved theme with the document root', async () => {
  const toggle = await readFile(new URL('../components/layout/theme-toggle.tsx', import.meta.url), 'utf8');
  assert.match(toggle, /document\.documentElement\.dataset\.theme = resolved/u);
  assert.match(toggle, /document\.documentElement\.style\.colorScheme = resolved/u);
});

test('wiki article uses the full mobile viewport width', async () => {
  const [css, shell, article] = await Promise.all([
    readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
    readFile(new URL('../components/layout/app-shell.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/wiki/wiki-article-view.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(shell, /max-w-7xl px-0 pb-12/u);
  assert.match(article, /wiki-rendered wiki-mobile-full/u);
  assert.match(css, /width: calc\(100% \+ 1\.5rem\)/u);
  assert.match(css, /margin-inline: -0\.75rem/u);
});

test('server detail uses light content cards while preserving artwork contrast', async () => {
  const [css, serverDetail] = await Promise.all([
    readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
    readFile(new URL('../components/servers/server-detail-showcase.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(serverDetail, /server-detail-surface/);
  assert.match(serverDetail, /server-documentation-card/);
  assert.match(serverDetail, /dark-fixed-surface relative h-36/);
  assert.match(css, /server-detail-surface \.server-documentation-card/);
  assert.match(css, /server-detail-surface \[class\*='text-emerald-100'\]/);
});

test('server hero follows light mode instead of forcing a dark surface', async () => {
  const [css, hero] = await Promise.all([
    readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
    readFile(new URL('../components/servers/server-hero-live.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(hero, /server-hero-surface/u);
  assert.doesNotMatch(hero, /dark-fixed-surface relative overflow-hidden/u);
  assert.match(css, /html\[data-theme='light'\] \.server-hero-surface/u);
  assert.match(css, /\.server-hero-overlay-primary/u);
});

test('theme contrast corrections cover shared links, metadata and provider labels', async () => {
  const [css, providers, claim, serverList, reviewsHeader, policyViewer, dropdown, authForms] = await Promise.all([
    readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
    readFile(new URL('../components/auth/oauth-provider-choice.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/claim/claim-workflow.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/servers/server-list-explorer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/servers/server-reviews-header.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/policies/policy-viewer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/account/account-dropdown.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/auth/auth-forms.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(css, /html\[data-theme='light'\] \.wiki-rendered a:not\(\.button\)/u);
  assert.match(css, /html\[data-theme='light'\] \.chip-accent/u);
  assert.match(css, /html\[data-theme='dark'\] \[class\*='text-slate-500'\]/u);
  assert.match(css, /html\[data-theme='dark'\] \.paper-mobile-filter/u);
  assert.match(css, /auth-provider-label-discord/u);
  assert.match(css, /auth-provider-label-naver/u);
  assert.match(css, /vote-modal-surface \[class~='text-blue-100'\]/u);
  assert.match(css, /paper-server-row a\[class\*='bg-\[#13ec80\]'\]/u);
  assert.match(css, /html\[data-theme='light'\] \.policy-version-notice/u);
  assert.match(css, /html\[data-theme='dark'\] \.paper-results-summary/u);
  assert.match(css, /html\[data-theme='dark'\] \.wiki-rendered \.doc-status small/u);
  assert.match(css, /html\[data-theme='dark'\] \.review-compose-disabled/u);
  assert.match(css, /placeholder:text-slate-600'\]::placeholder/u);
  assert.match(css, /^\.input \{/mu);
  assert.match(css, /^\.btn-secondary \{/mu);
  assert.match(css, /html\[data-theme='light'\] \.input/u);
  assert.match(css, /html\[data-theme='light'\] \.btn-secondary/u);
  assert.match(providers, /auth-provider-label-discord/u);
  assert.match(providers, /auth-provider-label-naver/u);
  assert.match(claim, /claim-surface/u);
  assert.match(css, /\.claim-surface, \.dashboard-surface, \.admin-surface/u);
  assert.doesNotMatch(serverList, /투표 불가/u);
  assert.match(serverList, /paper-results-summary/u);
  assert.match(serverList, /paper-load-more-hint/u);
  assert.match(serverList, /paper-side-stat-label/u);
  assert.match(reviewsHeader, /review-compose-disabled/u);
  assert.match(policyViewer, /policy-version-notice/u);
  assert.match(dropdown, /bg-\[#4752c4\]/u);
  assert.match(dropdown, /bg-\[#087a42\]/u);
  assert.match(authForms, /policy-checkbox/u);
  assert.match(authForms, /focus-visible:outline-2/u);
});

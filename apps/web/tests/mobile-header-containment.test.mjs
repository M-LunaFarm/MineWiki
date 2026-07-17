import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('mobile header controls and account menu stay inside the viewport', async () => {
  const [header, accountDropdown] = await Promise.all([
    readFile(new URL('../components/layout/site-header.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/account/account-dropdown.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(header, /overflow-x-clip/u);
  assert.match(header, /open=\{accountMenuOpen\}/u);
  assert.match(header, /if \(open\) setMobileOpen\(false\)/u);
  assert.match(header, /setAccountMenuOpen\(false\);\s*setMobileOpen/u);
  assert.match(header, /hidden sm:inline-flex[^>]*><WikiNotificationBell/u);
  assert.match(header, /hidden min-\[400px\]:inline-flex/u);
  assert.match(header, /href="\/wiki\/notifications"/u);
  assert.match(header, /href="\/wiki\/edit-requests\?status=open&scope=reviewable"/u);
  assert.match(header, /min-\[400px\]:hidden/u);
  assert.match(accountDropdown, /fixed inset-x-2 top-\[4\.5rem\]/u);
  assert.match(accountDropdown, /max-h-\[calc\(100dvh-5rem\)\] overflow-y-auto/u);
  assert.match(accountDropdown, /sm:absolute sm:inset-x-auto sm:right-0/u);
});

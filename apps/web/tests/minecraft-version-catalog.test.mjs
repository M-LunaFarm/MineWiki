import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const schemasSource = await readFile(
  new URL('../../../packages/schemas/src/index.ts', import.meta.url),
  'utf8',
);
const registrationSource = await readFile(
  new URL('../app/servers/register/page.tsx', import.meta.url),
  'utf8',
);

test('registration uses the shared Minecraft version catalog', () => {
  assert.match(registrationSource, /MINECRAFT_VERSION_OPTIONS\[form\.edition\]/);
  assert.doesNotMatch(registrationSource, /const VERSION_OPTIONS/);
});

test('the shared catalog includes the 2026 version family for both editions', () => {
  const catalog = schemasSource.match(
    /export const MINECRAFT_VERSION_OPTIONS = \{([\s\S]*?)\n\} as const;/,
  )?.[1];

  assert.ok(catalog);
  for (const edition of ['java', 'bedrock']) {
    const values = catalog.match(new RegExp(`${edition}: \\[([\\s\\S]*?)\\]`))?.[1];
    assert.ok(values);
    assert.match(values, /'26\.2'/);
    assert.match(values, /'26\.1'/);
    assert.match(values, /'26'/);
  }
});

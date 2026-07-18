import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const apiSource = path.join(repoRoot, 'apps/api/src');
const writer = path.join(apiSource, 'events/audit-event-writer.ts');

test('production audit writes cannot bypass the central transactional writer', async () => {
  const violations: string[] = [];
  const entries = await readdir(apiSource, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const absolutePath = path.join(entry.parentPath, entry.name);
    if (absolutePath === writer) continue;
    const source = await readFile(absolutePath, 'utf8');
    if (/auditEvent\.create\s*\(/u.test(source)) violations.push(path.relative(repoRoot, absolutePath));
  }
  assert.deepEqual(violations, [], `direct audit writes bypass central redaction: ${violations.join(', ')}`);
});

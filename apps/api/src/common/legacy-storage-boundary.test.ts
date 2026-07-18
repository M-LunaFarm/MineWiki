import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const sourceRoots = [
  path.join(repoRoot, 'apps/api/src'),
  path.join(repoRoot, 'apps/worker/src'),
];
const allowedRepositories = new Set([
  path.join(repoRoot, 'apps/api/src/verify/guild.repositories.ts'),
  path.join(repoRoot, 'apps/worker/src/discord-verification.repository.ts'),
  path.join(repoRoot, 'apps/api/src/auth/account-export-legacy-integration.repository.ts'),
]);

test('legacy Luna storage names stay behind compatibility repositories', async () => {
  const violations: string[] = [];
  for (const sourceRoot of sourceRoots) {
    const entries = await readdir(sourceRoot, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
        continue;
      }
      const absolutePath = path.join(entry.parentPath, entry.name);
      if (allowedRepositories.has(absolutePath)) {
        continue;
      }
      const source = await readFile(absolutePath, 'utf8');
      if (/\b(?:Luna|luna)[A-Z]/.test(source)) {
        violations.push(path.relative(repoRoot, absolutePath));
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `legacy storage access escaped repository boundary: ${violations.join(', ')}`,
  );
});

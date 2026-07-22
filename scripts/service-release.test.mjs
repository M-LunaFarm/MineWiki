import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertReleaseKey,
  prepareServiceRelease,
  rollbackServiceRelease,
  SERVICE_DEFINITIONS,
} from './service-release-lib.mjs';

async function createFixture() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'minewiki-service-release-'));
  await writeFile(path.join(repoRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
  for (const [service, definition] of Object.entries(SERVICE_DEFINITIONS)) {
    const entrypoint = path.join(repoRoot, definition.appRoot, definition.entrypoint);
    await mkdir(path.dirname(entrypoint), { recursive: true });
    await writeFile(entrypoint, `module.exports = ${JSON.stringify(service)};\n`, 'utf8');
  }

  const packageRoot = path.join(repoRoot, 'packages/config');
  await mkdir(path.join(packageRoot, 'dist'), { recursive: true });
  await writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: '@minewiki/config', main: 'dist/index.js' })}\n`,
    'utf8',
  );
  await writeFile(path.join(packageRoot, 'dist/index.js'), 'module.exports = { frozen: true };\n', 'utf8');
  const externalDependency = path.join(repoRoot, 'node_modules/.pnpm/pino/node_modules/pino');
  await mkdir(externalDependency, { recursive: true });
  await writeFile(path.join(externalDependency, 'package.json'), '{"name":"pino"}\n', 'utf8');
  await mkdir(path.join(packageRoot, 'node_modules'), { recursive: true });
  await symlink(externalDependency, path.join(packageRoot, 'node_modules/pino'));
  const scopeRoot = path.join(repoRoot, 'apps/api/node_modules/@minewiki');
  await mkdir(scopeRoot, { recursive: true });
  await symlink(path.relative(scopeRoot, packageRoot), path.join(scopeRoot, 'config'));
  return repoRoot;
}

test('prepares an immutable service set and swaps current/previous during rollback', async () => {
  const repoRoot = await createFixture();
  try {
    const first = await prepareServiceRelease(repoRoot, {
      createdAt: new Date('2026-07-22T00:00:00.000Z'),
    });
    assert.equal(await readlink(path.join(repoRoot, '.releases/services/current')), first.releaseKey);
    assert.equal(
      await readFile(
        path.join(repoRoot, '.releases/services', first.releaseKey, 'packages/config/dist/index.js'),
        'utf8',
      ),
      'module.exports = { frozen: true };\n',
    );
    assert.equal(
      await readFile(
        path.join(
          repoRoot,
          '.releases/services',
          first.releaseKey,
          'packages/config/node_modules/pino/package.json',
        ),
        'utf8',
      ),
      '{"name":"pino"}\n',
    );

    const apiEntrypoint = path.join(
      repoRoot,
      SERVICE_DEFINITIONS.api.appRoot,
      SERVICE_DEFINITIONS.api.entrypoint,
    );
    await writeFile(apiEntrypoint, 'module.exports = "api-v2";\n', 'utf8');
    const second = await prepareServiceRelease(repoRoot, {
      createdAt: new Date('2026-07-22T00:00:01.000Z'),
    });
    assert.equal(await readlink(path.join(repoRoot, '.releases/services/current')), second.releaseKey);
    assert.equal(await readlink(path.join(repoRoot, '.releases/services/previous')), first.releaseKey);

    const rollback = await rollbackServiceRelease(repoRoot);
    assert.deepEqual(rollback, { current: first.releaseKey, previous: second.releaseKey });
    assert.equal(await readlink(path.join(repoRoot, '.releases/services/current')), first.releaseKey);
    assert.equal(await readlink(path.join(repoRoot, '.releases/services/previous')), second.releaseKey);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('rejects release paths that are not generated keys', () => {
  assert.throws(() => assertReleaseKey('../current'), /Invalid service release key/u);
});

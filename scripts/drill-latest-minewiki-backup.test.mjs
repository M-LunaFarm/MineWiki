import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findLatestVerifiedSnapshot } from './drill-latest-minewiki-backup.mjs';

test('latest restore drill skips incomplete and corrupt backup snapshots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'minewiki-latest-drill-test-'));
  try {
    const verified = path.join(root, '20260724T030000Z');
    const incomplete = path.join(root, '20260725T030000Z');
    const corrupt = path.join(root, '20260726T030000Z');
    await Promise.all([mkdir(verified), mkdir(incomplete), mkdir(corrupt)]);
    await writeFile(path.join(verified, 'manifest.json'), JSON.stringify({
      snapshotId: '20260724T030000Z',
      verification: { verifiedAt: '2026-07-24T03:01:00.000Z' },
    }));
    await writeFile(path.join(incomplete, 'manifest.json'), JSON.stringify({
      snapshotId: '20260725T030000Z',
      verification: null,
    }));
    await writeFile(path.join(corrupt, 'manifest.json'), '{broken');

    assert.equal(await findLatestVerifiedSnapshot(root), verified);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


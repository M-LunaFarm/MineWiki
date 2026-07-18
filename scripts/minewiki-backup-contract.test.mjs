import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeArchiveEntries, parseMysqlDatabaseUrl, resolveSafeDirectory, selectSnapshotsToDelete } from './minewiki-backup-contract.mjs';

test('database URL parsing keeps credentials out of command arguments', () => {
  assert.deepEqual(parseMysqlDatabaseUrl('mysql://wiki:p%40ss@db.internal:3307/minewiki'), {
    host: 'db.internal', port: '3307', user: 'wiki', password: 'p@ss', database: 'minewiki',
  });
  assert.throws(() => parseMysqlDatabaseUrl('postgres://wiki:x@db/minewiki'), /mysql/u);
});

test('backup paths reject root and upload-containing destinations', () => {
  assert.throws(() => resolveSafeDirectory('/', { label: 'backup' }), /non-root/u);
  assert.throws(() => resolveSafeDirectory('/srv', { label: 'backup', forbidden: ['/srv/uploads'] }), /cannot contain/u);
  assert.throws(() => resolveSafeDirectory('/srv/uploads/backups', { label: 'backup', forbidden: ['/srv/uploads'] }), /cannot contain/u);
});

test('archive verification rejects traversal entries', () => {
  assert.doesNotThrow(() => assertSafeArchiveEntries(['./', './images/logo.webp']));
  assert.throws(() => assertSafeArchiveEntries(['../../etc/passwd']), /Unsafe/u);
  assert.throws(() => assertSafeArchiveEntries(['/etc/passwd']), /Unsafe/u);
});

test('retention never deletes the newest verified snapshot or unverified evidence', () => {
  const snapshots = Array.from({ length: 12 }, (_, index) => ({
    id: `s${index}`, createdAt: new Date(Date.UTC(2026, 6, 18 - index)).toISOString(), verifiedAt: index === 3 ? null : 'ok',
  }));
  const deleted = selectSnapshotsToDelete(snapshots, { now: new Date('2026-07-18T12:00:00Z'), daily: 3, weekly: 1, monthly: 1 });
  assert.ok(!deleted.includes('s0'));
  assert.ok(!deleted.includes('s3'));
  assert.ok(deleted.length > 0);
});

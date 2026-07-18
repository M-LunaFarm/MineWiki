import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WikiSpecialCursorCodec } from './wiki-special-cursor';

const codec = new WikiSpecialCursorCodec({
  get(name: string) { return name === 'APP_ENCRYPTION_KEY' ? 'wiki-special-cursor-test-secret' : undefined; },
} as never);

const binding = {
  type: 'old',
  namespace: 'main',
  generation: null,
  viewerScope: 'profile:7',
} as const;

test('special document cursor round-trips indexed and snapshot positions', () => {
  const indexed = {
    kind: 'indexed' as const,
    snapshotAt: '2026-07-18T00:00:00.000Z',
    sortValue: '2026-07-17T00:00:00.000Z',
    pageId: '42',
  };
  const snapshot = { kind: 'snapshot' as const, offset: 100 };
  assert.deepEqual(codec.decode(codec.encode(binding, indexed), binding), indexed);
  assert.deepEqual(codec.decode(codec.encode({ ...binding, type: 'wanted', generation: 'generation-1' }, snapshot), {
    ...binding, type: 'wanted', generation: 'generation-1',
  }), snapshot);
});

test('special document cursor rejects tampering and cross-scope reuse', () => {
  const cursor = codec.encode(binding, {
    kind: 'indexed',
    snapshotAt: '2026-07-18T00:00:00.000Z',
    sortValue: '2026-07-17T00:00:00.000Z',
    pageId: '42',
  });
  assert.throws(() => codec.decode(`${cursor}x`, binding), /유효하지 않거나/u);
  assert.throws(() => codec.decode(cursor, { ...binding, namespace: 'server' }), /유효하지 않거나/u);
  assert.throws(() => codec.decode(cursor, { ...binding, viewerScope: 'anonymous' }), /유효하지 않거나/u);
});

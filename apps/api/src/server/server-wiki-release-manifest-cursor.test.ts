import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { ServerWikiReleaseManifestCursorCodec, type ServerWikiReleaseManifestCursorBinding } from './server-wiki-release-manifest-cursor';

const codec = new ServerWikiReleaseManifestCursorCodec({
  get(name: string) { return name === 'APP_ENCRYPTION_KEY' ? 'release-manifest-cursor-test-secret' : undefined; },
} as never);
const binding: ServerWikiReleaseManifestCursorBinding = {
  candidateId: '10',
  candidateToken: 'a'.repeat(64),
  serverWikiId: '20',
  spaceId: '30',
  kinds: ['added', 'updated'],
};

test('release manifest cursor round trips only for the exact candidate, tenant, and filters', () => {
  const cursor = codec.encode(binding, '50');
  assert.equal(codec.decode(cursor, binding), '50');
  assert.throws(() => codec.decode(cursor, { ...binding, candidateId: '11' }), BadRequestException);
  assert.throws(() => codec.decode(cursor, { ...binding, spaceId: '31' }), BadRequestException);
  assert.throws(() => codec.decode(cursor, { ...binding, kinds: ['updated', 'added'] }), BadRequestException);
});

test('release manifest cursor rejects signature and payload tampering', () => {
  const cursor = codec.encode(binding, '50');
  const [payload, signature] = cursor.split('.') as [string, string];
  assert.throws(() => codec.decode(`${payload}.${signature.slice(0, -1)}x`, binding), BadRequestException);
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  decoded.lastPageId = '51';
  const tamperedPayload = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
  assert.throws(() => codec.decode(`${tamperedPayload}.${signature}`, binding), BadRequestException);
});

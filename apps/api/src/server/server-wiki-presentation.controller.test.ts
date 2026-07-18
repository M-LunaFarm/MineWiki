import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundException } from '@nestjs/common';

import { ServerWikiPresentationController } from './server-wiki-presentation.controller';

test('presentation applies the shared space publication policy before returning tenant content', async () => {
  const calls: string[] = [];
  const controller = new ServerWikiPresentationController(
    { async getWikiPresentationBySlug() { calls.push('presentation'); return { slug: 'example' }; } } as never,
    { serverWiki: { async findUnique() { calls.push('lookup'); return { spaceId: 10n }; } } } as never,
    { async assertCanReadSpace(input: { accountId: string | null; spaceId: bigint }) {
      calls.push(`policy:${input.accountId}:${input.spaceId}`);
    } } as never,
  );

  const result = await controller.presentation('example', {
    sessionPayload: { userId: 'account-1' },
    clientIp: '203.0.113.8',
  } as never);

  assert.deepEqual(calls, ['lookup', 'policy:account-1:10', 'presentation']);
  assert.deepEqual(result, { slug: 'example' });
});

test('presentation never calls the renderer when an unpublished tenant is unreadable', async () => {
  let rendered = false;
  const controller = new ServerWikiPresentationController(
    { async getWikiPresentationBySlug() { rendered = true; return {}; } } as never,
    { serverWiki: { async findUnique() { return { spaceId: 10n }; } } } as never,
    { async assertCanReadSpace() { throw new NotFoundException('Wiki space not found.'); } } as never,
  );

  await assert.rejects(
    controller.presentation('example', { sessionPayload: null, clientIp: '203.0.113.8' } as never),
    NotFoundException,
  );
  assert.equal(rendered, false);
});

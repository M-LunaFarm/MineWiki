import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ForbiddenException } from '@nestjs/common';
import { VoteAdminController } from './vote-admin.controller';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';

const voteId = '11111111-1111-4111-8111-111111111111';

test('vote admin controller requires the session guard', () => {
  const guards = Reflect.getMetadata(GUARDS_METADATA, VoteAdminController) as unknown[] | undefined;
  assert.ok(guards?.includes(SessionGuard));
});

test('vote invalidation rejects regular users before changing data', () => {
  let called = false;
  const controller = new VoteAdminController({
    invalidateVote: async () => {
      called = true;
    },
  } as never);
  const session = {
    sessionId: 'session-1',
    userId: '22222222-2222-4222-8222-222222222222',
    isElevated: false,
    groups: ['user'],
    permissions: [],
  } satisfies SessionPayload;

  assert.throws(
    () => controller.invalidate(voteId, session, { reason: 'automated vote pattern' }),
    (error: unknown) => error instanceof ForbiddenException,
  );
  assert.equal(called, false);
});

test('vote admin permission can invalidate a vote with a bounded reason', async () => {
  const calls: unknown[] = [];
  const controller = new VoteAdminController({
    invalidateVote: async (...args: unknown[]) => {
      calls.push(args);
      return { id: voteId, status: 'invalid' };
    },
  } as never);
  const session = {
    sessionId: 'session-1',
    userId: '22222222-2222-4222-8222-222222222222',
    isElevated: false,
    permissions: ['vote.admin'],
  } satisfies SessionPayload;

  const result = await controller.invalidate(voteId, session, {
    reason: '  automated vote pattern  ',
  });

  assert.deepEqual(result, { id: voteId, status: 'invalid' });
  assert.deepEqual(calls, [[voteId, session.userId, 'automated vote pattern']]);
});

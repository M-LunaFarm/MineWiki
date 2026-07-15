import assert from 'node:assert/strict';
import test from 'node:test';
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { VoteController } from './vote.controller';
import { SessionGuard } from '../session/session.guard';

test('submitting a server vote requires an authenticated session', () => {
  const guards = Reflect.getMetadata(
    GUARDS_METADATA,
    VoteController.prototype.submit,
  ) as unknown[] | undefined;

  assert.ok(guards?.includes(SessionGuard));
});

test('vote submission binds the canonical Minecraft identity and request IP', async () => {
  const calls: unknown[] = [];
  const controller = new VoteController(
    {
      submitVote: async (...args: unknown[]) => {
        calls.push(args);
        return { acknowledged: true };
      },
    } as never,
    {
      getIdentity: async () => ({
        uuid: '3f0df999-1ab4-48cf-9c96-c5a834d0d1ee',
        playerName: 'OwnedPlayer',
        msOwned: true,
        lastVerifiedAt: new Date().toISOString(),
      }),
    } as never,
  );

  await controller.submit(
    '8d5d43eb-5e53-4ce9-90a0-dfd8fbfa9b6b',
    { username: 'TypedPlayer' },
    {
      sessionId: 'session-1',
      userId: 'canonical-account',
      tokenVersion: 1,
      isElevated: false,
      authenticatedAt: new Date().toISOString(),
      requestIp: '192.0.2.10',
    },
  );

  assert.deepEqual(calls, [[
    '8d5d43eb-5e53-4ce9-90a0-dfd8fbfa9b6b',
    { username: 'TypedPlayer' },
    {
      accountId: 'canonical-account',
      ipAddress: '192.0.2.10',
      minecraftUuid: '3f0df999-1ab4-48cf-9c96-c5a834d0d1ee',
      minecraftUsername: 'OwnedPlayer',
    },
  ]]);
});

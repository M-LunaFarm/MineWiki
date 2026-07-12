import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { MinecraftService } from './minecraft.service';

test('canonical account reads Minecraft identity stored on a linked account', async () => {
  const canonicalAccountId = randomUUID();
  const linkedAccountId = randomUUID();
  const minecraftUuid = randomUUID();
  const service = new MinecraftService(
    {} as never,
    {} as never,
    {
      account: {
        findMany: async () => [{ id: canonicalAccountId }, { id: linkedAccountId }],
      },
      minecraftIdentity: {
        findMany: async (input: { where: { accountId: { in: string[] } } }) => {
          assert.deepEqual(input.where.accountId.in, [canonicalAccountId, linkedAccountId]);
          return [
            {
              accountId: linkedAccountId,
              uuid: minecraftUuid,
              playerName: 'LinkedPlayer',
              msOwned: true,
              lastVerifiedAt: new Date('2026-07-12T00:00:00.000Z'),
            },
          ];
        },
      },
    } as never,
  );

  const identity = await service.getStoredIdentity(canonicalAccountId);
  assert.equal(identity.uuid, minecraftUuid);
  assert.equal(identity.playerName, 'LinkedPlayer');
});

test('canonical account fails closed when linked accounts contain multiple identities', async () => {
  const canonicalAccountId = randomUUID();
  const service = new MinecraftService(
    {} as never,
    {} as never,
    {
      account: { findMany: async () => [{ id: canonicalAccountId }, { id: randomUUID() }] },
      minecraftIdentity: {
        findMany: async () => [
          { accountId: canonicalAccountId },
          { accountId: randomUUID() },
        ],
      },
    } as never,
  );

  await assert.rejects(
    () => service.getStoredIdentity(canonicalAccountId),
    (error: unknown) => error instanceof ConflictException,
  );
});

test('revoking ownership clears identity and pending OAuth state across linked accounts', async () => {
  const canonicalAccountId = randomUUID();
  const linkedAccountId = randomUUID();
  const identityDeletes: unknown[] = [];
  const authorizationDeletes: unknown[] = [];
  const tracked: unknown[] = [];
  const service = new MinecraftService(
    { track: async (...args: unknown[]) => tracked.push(args) } as never,
    {} as never,
    {
      account: {
        findMany: async () => [{ id: canonicalAccountId }, { id: linkedAccountId }],
      },
      minecraftIdentity: {
        deleteMany: (input: unknown) => {
          identityDeletes.push(input);
          return Promise.resolve({ count: 1 });
        },
      },
      minecraftAuthorization: {
        deleteMany: (input: unknown) => {
          authorizationDeletes.push(input);
          return Promise.resolve({ count: 1 });
        },
      },
      $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
    } as never,
  );

  await service.revokeIdentity(canonicalAccountId);

  const expectedWhere = { accountId: { in: [canonicalAccountId, linkedAccountId] } };
  assert.deepEqual(identityDeletes, [{ where: expectedWhere }]);
  assert.deepEqual(authorizationDeletes, [{ where: expectedWhere }]);
  assert.equal(tracked.length, 1);
});

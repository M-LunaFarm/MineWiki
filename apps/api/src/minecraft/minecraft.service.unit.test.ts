import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { MinecraftService } from './minecraft.service';

test('Microsoft authorization uses the fixed callback and keeps PKCE verifier server-side', async () => {
  const accountId = randomUUID();
  const redirectUri = 'https://minewiki.kr/minecraft/callback';
  const createdAuthorizations: Array<{
    state: string;
    accountId: string;
    redirectUri: string;
    codeVerifier: string;
  }> = [];
  const transaction = {
    account: {
      findMany: async () => [{ id: accountId, canonicalAccountId: accountId }],
      count: async () => 1,
    },
    accountLink: { findMany: async () => [] },
    $queryRaw: async () => [{ id: accountId }],
    minecraftAuthorization: {
      create: async ({ data }: { data: (typeof createdAuthorizations)[number] }) => {
        createdAuthorizations.push(data);
        return data;
      },
    },
  };
  const service = new MinecraftService(
    {} as never,
    {
      getOptional: (key: string) => {
        if (key === 'MICROSOFT_CLIENT_ID') return 'public-client-id';
        if (key === 'MICROSOFT_REDIRECT_URI') return redirectUri;
        return undefined;
      },
    } as never,
    {
      minecraftAuthorization: {
        deleteMany: async () => ({ count: 0 }),
      },
      $transaction: async (callback: (tx: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    } as never,
  );

  const result = await service.startAuthorization({ userId: accountId });
  const authorizationUrl = new URL(result.authorizationUrl);

  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(authorizationUrl.searchParams.get('scope'), 'XboxLive.signin');
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorizationUrl.searchParams.get('code_challenge'));
  assert.equal(authorizationUrl.searchParams.has('code_verifier'), false);
  assert.deepEqual(Object.keys(result).sort(), ['authorizationUrl', 'state']);
  assert.equal(createdAuthorizations.length, 1);
  assert.equal(createdAuthorizations[0]?.accountId, accountId);
  assert.equal(createdAuthorizations[0]?.redirectUri, redirectUri);
  assert.ok((createdAuthorizations[0]?.codeVerifier.length ?? 0) >= 43);
});

test('Microsoft token exchange falls back to PKCE when a configured client secret is rejected', async () => {
  const originalFetch = globalThis.fetch;
  const requests: URLSearchParams[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(new URLSearchParams(String(init?.body ?? '')));
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        error: 'invalid_client',
        error_description: 'AADSTS7000215: Invalid client secret.',
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ access_token: 'microsoft-access-token' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const service = new MinecraftService(
      {} as never,
      {
        getOptional: (key: string) => {
          if (key === 'MICROSOFT_CLIENT_ID') return 'public-client-id';
          if (key === 'MICROSOFT_CLIENT_SECRET') return 'expired-secret';
          if (key === 'MICROSOFT_REDIRECT_URI') return 'https://verify.minewiki.kr/minecraft/callback';
          return undefined;
        },
      } as never,
      {} as never,
    );
    const exchange = service as unknown as {
      exchangeAuthorizationCode(code: string, redirectUri: string, codeVerifier: string): Promise<string>;
    };

    const token = await exchange.exchangeAuthorizationCode(
      'one-time-code',
      'https://verify.minewiki.kr/minecraft/callback',
      'A'.repeat(64),
    );

    assert.equal(token, 'microsoft-access-token');
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.get('client_secret'), 'expired-secret');
    assert.equal(requests[1]?.has('client_secret'), false);
    assert.equal(requests[0]?.get('code_verifier'), 'A'.repeat(64));
    assert.equal(requests[1]?.get('code_verifier'), 'A'.repeat(64));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('canonical account reads Minecraft identity stored on a linked account', async () => {
  const canonicalAccountId = randomUUID();
  const linkedAccountId = randomUUID();
  const minecraftUuid = randomUUID();
  const service = new MinecraftService(
    {} as never,
    {} as never,
    {
      account: {
        findUnique: async () => ({ id: canonicalAccountId, canonicalAccountId }),
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

test('a linked alias session reads the Minecraft identity on its canonical account', async () => {
  const canonicalAccountId = randomUUID();
  const linkedAccountId = randomUUID();
  const minecraftUuid = randomUUID();
  const service = new MinecraftService(
    {} as never,
    {} as never,
    {
      account: {
        findUnique: async () => ({ id: linkedAccountId, canonicalAccountId }),
        findMany: async (input: { where: { OR: unknown[] } }) => {
          assert.deepEqual(input.where.OR, [{ id: canonicalAccountId }, { canonicalAccountId }]);
          return [{ id: canonicalAccountId }, { id: linkedAccountId }];
        },
      },
      minecraftIdentity: {
        findMany: async () => [{
          accountId: canonicalAccountId,
          uuid: minecraftUuid,
          playerName: 'CanonicalPlayer',
          msOwned: true,
          lastVerifiedAt: new Date('2026-07-12T00:00:00.000Z'),
        }],
      },
    } as never,
  );

  const identity = await service.getStoredIdentity(linkedAccountId);
  assert.equal(identity.uuid, minecraftUuid);
  assert.equal(identity.playerName, 'CanonicalPlayer');
});

test('canonical account fails closed when linked accounts contain multiple identities', async () => {
  const canonicalAccountId = randomUUID();
  const service = new MinecraftService(
    {} as never,
    {} as never,
    {
      account: {
        findUnique: async () => ({ id: canonicalAccountId, canonicalAccountId }),
        findMany: async () => [{ id: canonicalAccountId }, { id: randomUUID() }],
      },
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
        findUnique: async () => ({ id: canonicalAccountId, canonicalAccountId }),
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

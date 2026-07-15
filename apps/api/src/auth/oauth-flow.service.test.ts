import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAuthFlowService } from './oauth-flow.service';
import { hashOAuthBrowserBinding } from './oauth-browser-binding';
import { hashOAuthSignupTicket } from './oauth-signup-ticket';

const binding = 'a'.repeat(43);
const state = 'state-value-123456';
const redirectUri = 'https://minewiki.kr/auth/callback/discord';

test('OAuth state is consumed only by the browser binding that created it', async () => {
  let exchangeCalls = 0;
  let consumed = false;
  const pending = {
    state,
    provider: 'discord',
    redirectUri,
    returnTo: '/me',
    mode: 'login',
    linkAccountId: null,
    agreeTerms: false,
    agreePrivacy: false,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    browserBindingHash: hashOAuthBrowserBinding(binding)
  };
  const transaction = {
    oAuthState: {
      findUnique: async () => (consumed ? null : pending),
      deleteMany: async (args: { where: { browserBindingHash: string } }) => {
        if (consumed || args.where.browserBindingHash !== pending.browserBindingHash) {
          return { count: 0 };
        }
        consumed = true;
        return { count: 1 };
      }
    }
  };
  const service = new OAuthFlowService({} as never, {
    oAuthState: { deleteMany: async () => ({ count: 0 }) },
    $transaction: async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)
  } as never);
  (service as unknown as { exchangeDiscordCode: () => Promise<unknown> }).exchangeDiscordCode =
    async () => {
      exchangeCalls += 1;
      return { providerUserId: 'discord-user', credential: { accessToken: 'token' } };
    };

  await assert.rejects(
    service.complete('discord', 'code', state, redirectUri, 'b'.repeat(43)),
    /유효하지 않은 OAuth 상태/
  );
  assert.equal(exchangeCalls, 0);
  assert.equal(consumed, false);

  const result = await service.complete('discord', 'code', state, redirectUri, binding);
  assert.equal(result.providerUserId, 'discord-user');
  assert.equal(exchangeCalls, 1);
  assert.equal(consumed, true);

  await assert.rejects(
    service.complete('discord', 'code', state, redirectUri, binding),
    /유효하지 않은 OAuth 상태/
  );
  assert.equal(exchangeCalls, 1);
});

test('legacy OAuth state without a browser binding fails closed', async () => {
  const pending = {
    state,
    provider: 'discord',
    redirectUri,
    returnTo: null,
    mode: 'login',
    linkAccountId: null,
    agreeTerms: false,
    agreePrivacy: false,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    browserBindingHash: null
  };
  const transaction = {
    oAuthState: {
      findUnique: async () => pending,
      deleteMany: async () => ({ count: 0 })
    }
  };
  const service = new OAuthFlowService({} as never, {
    oAuthState: { deleteMany: async () => ({ count: 0 }) },
    $transaction: async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)
  } as never);

  await assert.rejects(
    service.complete('discord', 'code', state, redirectUri, binding),
    /유효하지 않은 OAuth 상태/
  );
});

test('pending OAuth signup is encrypted, browser-bound, and consumed once', async () => {
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  const token = 'c'.repeat(43);
  let stored: Record<string, unknown> | null = null;
  let consumed = false;
  const transaction = {
    oAuthPendingSignup: {
      findUnique: async () => consumed ? null : stored,
      deleteMany: async () => {
        if (consumed || !stored) return { count: 0 };
        consumed = true;
        return { count: 1 };
      }
    }
  };
  const service = new OAuthFlowService({} as never, {
    oAuthPendingSignup: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        stored = data;
        return data;
      }
    },
    $transaction: async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)
  } as never);

  await service.createPendingSignup({
    provider: 'discord',
    providerUserId: 'new-user',
    email: 'new@example.com',
    displayName: 'New user',
    returnTo: '/servers',
    mode: 'login',
    agreeTerms: false,
    agreePrivacy: false,
    credential: { accessToken: 'secret-access-token', expiresAt: new Date('2030-01-01T00:00:00.000Z') }
  }, hashOAuthSignupTicket(token), binding);

  assert.equal(stored?.id, hashOAuthSignupTicket(token));
  assert.equal(stored?.browserBindingHash, hashOAuthBrowserBinding(binding));
  assert.doesNotMatch(String(stored?.payloadEncrypted), /secret-access-token/u);
  await assert.rejects(
    service.consumePendingSignup(token, 'b'.repeat(43)),
    /현재 브라우저와 일치하지 않습니다/u
  );
  assert.equal(consumed, false);

  const result = await service.consumePendingSignup(token, binding);
  assert.equal(result.providerUserId, 'new-user');
  assert.equal(result.agreeTerms, true);
  assert.equal(result.credential?.accessToken, 'secret-access-token');
  assert.equal(result.credential?.expiresAt?.toISOString(), '2030-01-01T00:00:00.000Z');
  await assert.rejects(service.consumePendingSignup(token, binding), /만료되었거나/u);
  if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = previousKey;
});

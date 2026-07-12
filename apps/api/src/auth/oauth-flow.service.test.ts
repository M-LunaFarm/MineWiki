import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAuthFlowService } from './oauth-flow.service';
import { hashOAuthBrowserBinding } from './oauth-browser-binding';

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

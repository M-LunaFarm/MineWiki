import assert from 'node:assert/strict';
import test from 'node:test';
import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { WikiApiTokenGuard } from './wiki-api-token.guard';
import type { AuthenticatedWikiApiToken, WikiApiTokenService } from './wiki-api-token.service';

const authenticatedToken = {
  id: 'token-id',
  accountId: 'account-id',
  scopes: ['wiki:read'],
  spaceId: null,
  session: {
    sessionId: 'wiki-api:token-id',
    userId: 'account-id',
    tokenVersion: 1,
    isElevated: false,
    authenticatedAt: '1970-01-01T00:00:00.000Z',
  },
} as const satisfies AuthenticatedWikiApiToken;

test('Wiki API token guard accepts a Bearer token and attaches its identity', async () => {
  let received: unknown[] = [];
  const guard = new WikiApiTokenGuard({
    async authenticate(...args: unknown[]) {
      received = args;
      return authenticatedToken;
    },
  } as unknown as WikiApiTokenService);
  const request = makeRequest({
    authorization: 'Bearer mwk_abcdef012345_token',
  });
  request.clientIp = '198.51.100.42';

  assert.equal(await guard.canActivate(contextFor(request)), true);
  assert.deepEqual(received, ['mwk_abcdef012345_token', '198.51.100.42']);
  assert.equal(request.wikiApiToken, authenticatedToken);
});

test('Wiki API token guard rejects missing and non-Bearer authorization', async () => {
  const guard = new WikiApiTokenGuard({
    async authenticate() {
      throw new Error('authenticate must not be called');
    },
  } as unknown as WikiApiTokenService);

  await assert.rejects(
    () => guard.canActivate(contextFor(makeRequest({}))),
    UnauthorizedException,
  );
  await assert.rejects(
    () => guard.canActivate(contextFor(makeRequest({ authorization: 'Basic abc' }))),
    UnauthorizedException,
  );
  await assert.rejects(
    () => guard.canActivate(contextFor(makeRequest({ authorization: 'Bearer first, Bearer second' }))),
    UnauthorizedException,
  );
});

test('Wiki API token guard rejects a request that also carries a session cookie', async () => {
  let authenticateCalled = false;
  const guard = new WikiApiTokenGuard({
    async authenticate() {
      authenticateCalled = true;
      return authenticatedToken;
    },
  } as unknown as WikiApiTokenService);
  const request = makeRequest({
    authorization: 'Bearer mwk_abcdef012345_token',
    cookie: 'theme=dark; mw_session=session-token; locale=ko',
  });

  await assert.rejects(() => guard.canActivate(contextFor(request)), UnauthorizedException);
  assert.equal(authenticateCalled, false);
});

function makeRequest(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

function contextFor(request: FastifyRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

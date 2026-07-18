import assert from 'node:assert/strict';
import test from 'node:test';
import { Algorithm, hash } from '@node-rs/argon2';
import { AccountEmailChangeService } from './account-email-change.service';
import type { SessionPayload } from '../session/session.service';

const group = {
  seedAccountId: 'account-1',
  canonicalAccountId: 'account-1',
  accountIds: ['account-1'],
};
const session = {
  sessionId: 'session-1',
  userId: 'account-1',
  tokenVersion: 1,
  isElevated: false,
  authenticatedAt: new Date().toISOString(),
} satisfies SessionPayload;

test('contact email reauthentication accepts the canonical group password', async () => {
  const passwordHash = await hash('CurrentPW1!', {
    memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32, algorithm: Algorithm.Argon2id,
  });
  const service = new AccountEmailChangeService({
    account: { async findMany() { return [{ id: 'account-1', passwordHash }]; } },
  } as never, {} as never);

  const credential = await (service as unknown as {
    reauthenticateAndResolveCredential(group: typeof group, session: SessionPayload, password?: string): Promise<{ id: string } | null>;
  }).reauthenticateAndResolveCredential(group, session, 'CurrentPW1!');

  assert.deepEqual(credential, { id: 'account-1' });
});

test('a password-bearing group never falls back to a recent OAuth timestamp', async () => {
  const service = new AccountEmailChangeService({
    account: { async findMany() { return [{ id: 'account-1', passwordHash: 'not-a-valid-match' }]; } },
  } as never, {} as never);
  await assert.rejects(
    (service as unknown as {
      reauthenticateAndResolveCredential(group: typeof group, session: SessionPayload, password?: string): Promise<unknown>;
    }).reauthenticateAndResolveCredential(group, session),
    (error: unknown) => error instanceof Error && error.message.includes('현재 비밀번호'),
  );
});

test('an OAuth-only group accepts only a login from the last fifteen minutes', async () => {
  const service = new AccountEmailChangeService({
    account: { async findMany() { return [{ id: 'account-1', passwordHash: null }]; } },
  } as never, {} as never);
  const method = (service as unknown as {
    reauthenticateAndResolveCredential(group: typeof group, session: SessionPayload, password?: string): Promise<unknown>;
  }).reauthenticateAndResolveCredential.bind(service);

  assert.equal(await method(group, session), null);
  await assert.rejects(method(group, {
    ...session,
    authenticatedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
  }), /15분/u);
});

test('multiple password credentials fail closed before an email owner is selected', async () => {
  const service = new AccountEmailChangeService({
    account: { async findMany() { return [{ id: 'a', passwordHash: 'a' }, { id: 'b', passwordHash: 'b' }]; } },
  } as never, {} as never);
  await assert.rejects(
    (service as unknown as {
      reauthenticateAndResolveCredential(group: typeof group, session: SessionPayload, password?: string): Promise<unknown>;
    }).reauthenticateAndResolveCredential(group, session, 'anything'),
    /여러 개/u,
  );
});

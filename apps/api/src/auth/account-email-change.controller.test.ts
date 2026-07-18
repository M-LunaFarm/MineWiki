import assert from 'node:assert/strict';
import test from 'node:test';
import 'reflect-metadata';
import type { SessionPayload } from '../session/session.service';
import { AccountEmailChangeController } from './account-email-change.controller';

const session = {
  sessionId: 'session', userId: 'account', tokenVersion: 1, isElevated: false,
  authenticatedAt: '2026-07-18T00:00:00.000Z',
} satisfies SessionPayload;

test('contact email controller preserves the GET, request, resend, and confirm contracts', async () => {
  const calls: unknown[] = [];
  const service = {
    async getState(received: unknown) { calls.push(['state', received]); return { currentEmail: null, hasPassword: false, pending: null }; },
    async request(received: unknown, body: unknown) { calls.push(['request', received, body]); return { accepted: true, expiresAt: 'expiry', nextResendAt: 'resend' }; },
    async resend(received: unknown) { calls.push(['resend', received]); return { accepted: true, expiresAt: 'expiry', nextResendAt: 'resend' }; },
    async confirm(token: string) { calls.push(['confirm', token]); return { success: true, reauthenticationRequired: true }; },
  };
  const headers: Record<string, string> = {};
  const reply = { header(name: string, value: string) { headers[name] = value; } };
  const controller = new AccountEmailChangeController(service as never);

  assert.deepEqual(await controller.getState(session), { currentEmail: null, hasPassword: false, pending: null });
  assert.deepEqual(await controller.request(session, { email: 'new@example.com' }), { accepted: true, expiresAt: 'expiry', nextResendAt: 'resend' });
  assert.deepEqual(await controller.resend(session), { accepted: true, expiresAt: 'expiry', nextResendAt: 'resend' });
  assert.deepEqual(await controller.confirm({ token: 'raw-token' }, reply as never), { success: true, reauthenticationRequired: true });
  assert.match(headers['Set-Cookie'] ?? '', /Max-Age=0/u);
  assert.deepEqual(calls, [
    ['state', session],
    ['request', session, { email: 'new@example.com' }],
    ['resend', session],
    ['confirm', 'raw-token'],
  ]);
});

test('contact email mutation endpoints carry explicit throttles', () => {
  for (const method of ['request', 'resend', 'confirm'] as const) {
    const handler = AccountEmailChangeController.prototype[method];
    assert.ok(Reflect.getMetadata('THROTTLER:LIMITdefault', handler));
    assert.ok(Reflect.getMetadata('THROTTLER:TTLdefault', handler));
  }
});

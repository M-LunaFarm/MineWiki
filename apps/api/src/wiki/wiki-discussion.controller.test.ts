import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { SessionPayload } from '../session/session.service';
import { WikiDiscussionController } from './wiki-discussion.controller';
import type { WikiDiscussionService, WikiDiscussionStatus, WikiDiscussionStatusFilter } from './wiki-discussion.service';
import type { WikiCaptchaService } from './wiki-captcha.service';

const captchaStub = { async assertVerified() {} } as WikiCaptchaService;

test('new discussion captcha is verified and never forwarded into discussion content', async () => {
  let captchaInput: unknown;
  let discussionInput: unknown;
  const service = {
    async createThread(receivedSession: SessionPayload, pageId: string, body: unknown) {
      discussionInput = { receivedSession, pageId, body };
      return { id: '30' };
    }
  } as unknown as WikiDiscussionService;
  const controller = new WikiDiscussionController(service, {
    async assertVerified(token: string | undefined, ip: string | undefined) { captchaInput = { token, ip }; }
  } as WikiCaptchaService);

  await controller.create(
    '10',
    { title: '주제', content: '의견', captchaToken: 'verified-token' },
    { clientIp: '192.0.2.22', sessionPayload: session } as FastifyRequest,
    { header() {} } as never,
  );

  assert.deepEqual(captchaInput, { token: 'verified-token', ip: '192.0.2.22' });
  assert.deepEqual(discussionInput, { receivedSession: session, pageId: '10', body: { title: '주제', content: '의견' } });
});

test('anonymous discussion creation verifies captcha and issues the shared secure capability cookie', async () => {
  let received: unknown;
  let cookie = '';
  const service = {
    assertAnonymousDiscussionsEnabled() {},
    async createAnonymousThread(pageId: string, body: unknown, requestIp: string, token: string | null) {
      received = { pageId, body, requestIp, token };
      return { thread: { id: '31' }, ownerToken: 'a'.repeat(43), ownerTokenIssued: true };
    },
  } as unknown as WikiDiscussionService;
  const controller = new WikiDiscussionController(service, {
    isRequired() { return true; },
    async assertVerified(token: string | undefined, ip: string | undefined) {
      assert.deepEqual({ token, ip }, { token: 'captcha', ip: '198.51.100.8' });
    },
  } as WikiCaptchaService);

  const result = await controller.create(
    '10',
    { title: '익명 주제', content: '익명 의견', captchaToken: 'captcha' },
    { clientIp: '198.51.100.8', headers: {} } as FastifyRequest,
    { header(name: string, value: string) { if (name === 'Set-Cookie') cookie = value; } } as never,
  );

  assert.deepEqual(result, { id: '31' });
  assert.deepEqual(received, {
    pageId: '10', body: { title: '익명 주제', content: '익명 의견' }, requestIp: '198.51.100.8', token: null,
  });
  assert.match(cookie, /^__Host-mw_wiki_contributor=/u);
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /Secure/u);
  assert.doesNotMatch(cookie, /actor_ip_hash|tokenDigest/u);
});

const session = { userId: 'account-1' } as SessionPayload;

test('discussion status endpoint accepts paused and forwards the authenticated actor', async () => {
  let received: { threadId: string; status: WikiDiscussionStatus; session: SessionPayload } | undefined;
  const service = {
    async setThreadStatus(actor: SessionPayload, threadId: string, status: WikiDiscussionStatus) {
      received = { threadId, status, session: actor };
      return { id: threadId, status };
    }
  } as unknown as WikiDiscussionService;
  const controller = new WikiDiscussionController(service, captchaStub);

  await controller.status('30', { status: 'paused' }, session);
  assert.deepEqual(received, { threadId: '30', status: 'paused', session });
  assert.throws(() => controller.status('30', { status: 'deleted' }, session), BadRequestException);
});

test('discussion list endpoint validates and forwards status filters', async () => {
  let receivedStatus: WikiDiscussionStatusFilter | undefined;
  let receivedPreview: boolean | undefined;
  const service = {
    async listThreadsPage(_pageId: string, _accountId: string | null, _cursor: string | undefined, _limit: number, status: WikiDiscussionStatusFilter, includePreview: boolean) {
      receivedStatus = status;
      receivedPreview = includePreview;
      return { items: [], nextCursor: null, statusCounts: { total: 0, open: 0, paused: 0, closed: 0 } };
    }
  } as unknown as WikiDiscussionService;
  const controller = new WikiDiscussionController(service, captchaStub);
  const request = { sessionPayload: session } as FastifyRequest;

  await controller.listPage('10', request, undefined, 'active', 20, 'first-latest');
  assert.equal(receivedStatus, 'active');
  assert.equal(receivedPreview, true);
  assert.throws(() => controller.listPage('10', request, undefined, 'deleted', 20), BadRequestException);
  assert.throws(() => controller.listPage('10', request, undefined, 'all', 20, 'full'), BadRequestException);
});

test('recent discussion endpoint validates and forwards global discovery filters', async () => {
  let received: unknown;
  const service = {
    async listRecent(_viewer: unknown, options: unknown) { received = options; return { items: [], nextCursor: null }; },
  } as unknown as WikiDiscussionService;
  const controller = new WikiDiscussionController(service, captchaStub);
  const request = { sessionPayload: session } as FastifyRequest;

  await controller.recent(request, 'cursor', 20, 'paused', 'oldest');
  assert.deepEqual(received, { cursor: 'cursor', limit: 20, status: 'paused', sort: 'oldest' });
  assert.throws(() => controller.recent(request, undefined, 20, 'deleted', 'newest'), BadRequestException);
  assert.throws(() => controller.recent(request, undefined, 20, 'all', 'popular'), BadRequestException);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { FastifyRequest } from 'fastify';
import type { SessionPayload } from '../session/session.service';
import { SessionGuard } from '../session/session.guard';
import { WikiEditRequestController } from './wiki-edit-request.controller';
import type { WikiEditRequestService } from './wiki-edit-request.service';
import type { WikiCaptchaService } from './wiki-captcha.service';

const captchaStub = { async assertVerified() {} } as WikiCaptchaService;

test('new-page review requests verify captcha without persisting the token', async () => {
  let captchaInput: unknown;
  let requestInput: unknown;
  const service = {
    async createForNewPage(receivedSession: SessionPayload, body: unknown) {
      requestInput = { receivedSession, body };
      return { id: '72' };
    }
  } as unknown as WikiEditRequestService;
  const controller = new WikiEditRequestController(service, {
    async assertVerified(token: string | undefined, ip: string | undefined) { captchaInput = { token, ip }; }
  } as WikiCaptchaService);
  const request = { clientIp: '192.0.2.23' } as FastifyRequest;

  await controller.createForNewPage({ namespace: 'guide', title: '새 문서', captchaToken: 'verified-token' }, session, request);

  assert.deepEqual(captchaInput, { token: 'verified-token', ip: '192.0.2.23' });
  assert.deepEqual(requestInput, { receivedSession: session, body: { namespace: 'guide', title: '새 문서' } });
});

const session = { userId: 'account-1' } as SessionPayload;

test('new-page request controller forwards the authenticated target and draft', async () => {
  let received: unknown;
  const service = {
    async createForNewPage(receivedSession: SessionPayload, body: unknown) {
      received = { receivedSession, body };
      return { id: '71', requestKind: 'create' };
    }
  } as unknown as WikiEditRequestService;
  const controller = new WikiEditRequestController(service, captchaStub);
  const body = { namespace: 'guide', title: '새 문서', contentRaw: '초안', editSummary: '새 문서 제안' };

  const result = await controller.createForNewPage(body, session, {} as FastifyRequest);

  assert.deepEqual(received, { receivedSession: session, body });
  assert.deepEqual(result, { id: '71', requestKind: 'create' });
});

test('request context controller preserves the optional viewer session', async () => {
  let received: unknown;
  const service = {
    async context(requestId: string, receivedSession: SessionPayload | null) {
      received = { requestId, receivedSession };
      return { items: [], canReview: false, viewerProfileId: null, nextCursor: null, currentRevisionId: null };
    }
  } as unknown as WikiEditRequestService;
  const controller = new WikiEditRequestController(service, captchaStub);

  await controller.context('71', { sessionPayload: session } as FastifyRequest);

  assert.deepEqual(received, { requestId: '71', receivedSession: session });
});

test('reviewable summary controller uses the authenticated session', async () => {
  let received: SessionPayload | undefined;
  const service = {
    async reviewableSummary(receivedSession: SessionPayload) {
      received = receivedSession;
      return { count: 3, capped: false };
    }
  } as unknown as WikiEditRequestService;
  const controller = new WikiEditRequestController(service, captchaStub);

  const result = await controller.reviewableSummary(session);

  assert.equal(received, session);
  assert.deepEqual(result, { count: 3, capped: false });
  const guards = Reflect.getMetadata(
    GUARDS_METADATA,
    WikiEditRequestController.prototype.reviewableSummary,
  ) as unknown[] | undefined;
  assert.ok(guards?.includes(SessionGuard));
});

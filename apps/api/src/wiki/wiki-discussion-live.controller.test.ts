import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'reflect-metadata';
import type { MessageEvent } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { FastifyRequest } from 'fastify';
import { of } from 'rxjs';
import type { SessionPayload } from '../session/session.service';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { WikiDiscussionLiveController } from './wiki-discussion-live.controller';
import type { WikiDiscussionLiveService } from './wiki-discussion-live.service';

test('discussion event endpoint forwards optional session and Last-Event-ID', async () => {
  const session = { userId: 'account-1' } as SessionPayload;
  let received: unknown[] | undefined;
  const stream = of<MessageEvent>({ type: 'sync', data: {} });
  const live = {
    async openEvents(...args: unknown[]) {
      received = args;
      return stream;
    }
  } as unknown as WikiDiscussionLiveService;
  const controller = new WikiDiscussionLiveController(live);

  const result = await controller.events(
    '30',
    { sessionPayload: session } as FastifyRequest,
    'previous-event-id'
  );

  assert.equal(result, stream);
  assert.deepEqual(received, ['30', session, 'previous-event-id']);
});

test('discussion event endpoint supports anonymous initial sync', async () => {
  let receivedSession: unknown = 'not-called';
  const live = {
    async openEvents(_threadId: string, session: unknown) {
      receivedSession = session;
      return of<MessageEvent>({ type: 'sync', data: {} });
    }
  } as unknown as WikiDiscussionLiveService;

  await new WikiDiscussionLiveController(live).events('30', {} as FastifyRequest);
  assert.equal(receivedSession, null);
});

test('discussion event endpoint has an explicit reconnect rate limit', () => {
  const handler = WikiDiscussionLiveController.prototype.events;
  assert.equal(Reflect.getMetadata('THROTTLER:LIMITdefault', handler), 30);
  assert.equal(Reflect.getMetadata('THROTTLER:TTLdefault', handler), 60);
  const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined;
  assert.ok(guards?.includes(OptionalSessionGuard));
});

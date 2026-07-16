import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import type { SessionPayload } from '../session/session.service';
import { STEP_UP_PURPOSE_METADATA } from '../session/step-up.guard';
import { WikiReportModerationController } from './wiki-report-moderation.controller';
import type { WikiReportModerationService } from './wiki-report-moderation.service';

const session = (permissions: string[] = [], groups: string[] = []): SessionPayload => ({
  sessionId: 'session-1',
  userId: 'account-1',
  tokenVersion: 1,
  isElevated: true,
  authenticatedAt: new Date('2026-07-16T12:00:00.000Z').toISOString(),
  permissions,
  groups,
});

test('moderation controller requires the dedicated permission or owner/admin access', async () => {
  const calls: SessionPayload[] = [];
  const service = {
    async listQueue(received: SessionPayload) {
      calls.push(received);
      return { items: [], nextCursor: null };
    },
  } as unknown as WikiReportModerationService;
  const controller = new WikiReportModerationController(service);

  assert.throws(
    () => controller.list(session()),
    (error: unknown) => error instanceof ForbiddenException,
  );
  await controller.list(session(['wiki.report.moderate']));
  await controller.list(session([], ['owner']));
  await controller.list(session([], ['admin']));
  assert.equal(calls.length, 3);
});

test('moderation controller is purpose-bound to the existing wiki admin step-up', () => {
  assert.equal(
    Reflect.getMetadata(STEP_UP_PURPOSE_METADATA, WikiReportModerationController),
    'wiki_admin',
  );
});

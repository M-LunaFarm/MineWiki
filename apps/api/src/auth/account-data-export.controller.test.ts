import assert from 'node:assert/strict';
import test from 'node:test';
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Readable } from 'node:stream';
import { AccountDataExportController } from './account-data-export.controller';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';

test('account data export requires an authenticated session and emits non-cacheable attachment headers', async () => {
  const guards = Reflect.getMetadata(
    GUARDS_METADATA,
    AccountDataExportController.prototype.download,
  ) as unknown[] | undefined;
  assert.ok(guards?.includes(SessionGuard));

  const headers = new Map<string, string>();
  const controller = new AccountDataExportController({
    async create() { return Readable.from(['{}']); },
  } as never);
  const session: SessionPayload = {
    sessionId: 'session', userId: 'account', tokenVersion: 1,
    isElevated: false, authenticatedAt: new Date().toISOString(),
  };
  await controller.download(session, {}, {
    header(name: string, value: string) { headers.set(name, value); },
  } as never);

  assert.equal(headers.get('Cache-Control'), 'private, no-store, max-age=0');
  assert.equal(headers.get('Pragma'), 'no-cache');
  assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(headers.get('X-Accel-Buffering'), 'no');
  assert.match(headers.get('Content-Disposition') ?? '', /^attachment; filename="minewiki-account-data-/u);
});

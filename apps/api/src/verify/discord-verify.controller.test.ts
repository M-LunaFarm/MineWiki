import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { DiscordVerifyController } from './discord-verify.controller';
import { SessionGuard } from '../session/session.guard';

test('canonical discord verify complete endpoint requires session guard', () => {
  const guards = Reflect.getMetadata(
    GUARDS_METADATA,
    DiscordVerifyController.prototype.completeSession
  ) as unknown[] | undefined;
  assert.ok(Array.isArray(guards));
  assert.ok(guards.includes(SessionGuard));
});

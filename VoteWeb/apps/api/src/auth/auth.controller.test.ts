import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthController } from './auth.controller';
import { SessionGuard } from '../session/session.guard';

test('me endpoint requires session guard', () => {
  const guards = Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.me) as
    | unknown[]
    | undefined;
  assert.ok(Array.isArray(guards));
  assert.ok(guards.includes(SessionGuard));
});

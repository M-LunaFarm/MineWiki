import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoneException } from '@nestjs/common';
import { PluginClaimController } from './plugin-claim.controller';

test('public plugin claim completion fails closed', () => {
  const controller = new PluginClaimController();

  assert.throws(() => controller.complete(), GoneException);
});

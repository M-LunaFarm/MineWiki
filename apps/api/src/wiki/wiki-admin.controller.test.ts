import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { WikiAdminController } from './wiki-admin.controller';
import type { WikiAdminService } from './wiki-admin.service';
import type { WikiProfileService } from './wiki-profile.service';

test('wiki admin controller denies non-elevated sessions', async () => {
  const controller = new WikiAdminController(
    {
      async getPages() {
        return [];
      }
    } as unknown as WikiAdminService,
    {} as WikiProfileService
  );

  await assert.rejects(
    () => controller.getPages(undefined, { sessionId: 's1', userId: 'account-1', isElevated: false }),
    (error: unknown) => error instanceof ForbiddenException
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { WikiAdminController } from './wiki-admin.controller';
import type { WikiAdminService } from './wiki-admin.service';
import type { WikiProfileService } from './wiki-profile.service';

test('wiki admin controller denies sessions without wiki admin authority', async () => {
  const controller = new WikiAdminController(
    {
      async getPages() {
        return [];
      }
    } as unknown as WikiAdminService,
    {} as WikiProfileService,
    {} as never
  );

  await assert.rejects(
    () => controller.getPages(undefined, { sessionId: 's1', userId: 'account-1', isElevated: true }),
    (error: unknown) => error instanceof ForbiddenException
  );
});

test('wiki admin controller allows explicit wiki admin permission', async () => {
  let ensured = false;
  const controller = new WikiAdminController(
    {
      async getPages() {
        return [];
      },
    } as unknown as WikiAdminService,
    {
      async ensureWikiProfile() {
        ensured = true;
        return { id: 1n };
      },
    } as unknown as WikiProfileService,
    {} as never,
  );

  const pages = await controller.getPages(undefined, {
    sessionId: 's1',
    userId: 'account-1',
    isElevated: false,
    permissions: ['wiki.admin'],
    groups: [],
  });

  assert.deepEqual(pages, []);
  assert.equal(ensured, true);
});

test('wiki revision management reads require wiki admin permission and preserve pagination inputs', async () => {
  let received: unknown[] = [];
  const controller = new WikiAdminController(
    {
      async getPageRevisions(...args: unknown[]) {
        received = args;
        return { page: {}, items: [], nextCursor: null };
      }
    } as unknown as WikiAdminService,
    { async ensureWikiProfile() { return { id: 5n }; } } as unknown as WikiProfileService,
    {} as never
  );
  const session = { sessionId: 's1', userId: 'account-1', isElevated: false, permissions: ['wiki.admin'], groups: [] };

  const result = await controller.getPageRevisions('10', '50', '25', session);

  assert.deepEqual(received, ['10', '50', '25']);
  assert.deepEqual(result.items, []);
});

test('wiki batch rollback requires its dedicated permission', async () => {
  const controller = new WikiAdminController(
    {} as WikiAdminService,
    { async ensureWikiProfile() { return { id: 5n }; } } as unknown as WikiProfileService,
    { async preview() { return { candidates: [] }; } } as never
  );
  await assert.rejects(
    controller.previewBatchRollback({ targetProfileId: '9' }, { sessionId: 's1', userId: 'account-1', isElevated: false, permissions: ['wiki.admin'], groups: [] }),
    ForbiddenException
  );
  const result = await controller.previewBatchRollback(
    { targetProfileId: '9' },
    { sessionId: 's2', userId: 'account-2', isElevated: false, permissions: ['wiki.batch_rollback'], groups: [] }
  );
  assert.deepEqual(result, { candidates: [] });
});

test('edit-summary moderation never treats elevation alone as revision authority', async () => {
  let mutated = false;
  const controller = new WikiAdminController(
    {
      async setRevisionEditSummaryHidden() {
        mutated = true;
        return {};
      }
    } as unknown as WikiAdminService,
    {} as WikiProfileService,
    {} as never
  );

  await assert.rejects(
    controller.setRevisionEditSummaryHidden(
      '101',
      { hidden: true, expectedVersion: 0, reason: '권한 없는 숨김 요청' },
      { sessionId: 's1', userId: 'account-1', isElevated: true, permissions: [], groups: [] }
    ),
    ForbiddenException
  );
  assert.equal(mutated, false);
});

test('edit-summary moderation forwards the explicit state, version, reason, and moderator profile', async () => {
  let received: unknown;
  const controller = new WikiAdminController(
    {
      async setRevisionEditSummaryHidden(input: unknown) {
        received = input;
        return {
          revisionId: '101', editSummaryHidden: true, editSummaryModerationVersion: 4,
          moderatedBy: '99', moderatedAt: '2026-07-17T00:00:00.000Z', reason: '민감 정보 제거'
        };
      }
    } as unknown as WikiAdminService,
    { async ensureWikiProfile() { return { id: 99n }; } } as unknown as WikiProfileService,
    {} as never
  );

  const result = await controller.setRevisionEditSummaryHidden(
    '101',
    { hidden: true, expectedVersion: 3, reason: '민감 정보 제거' },
    { sessionId: 's2', userId: 'account-2', isElevated: false, permissions: ['wiki.admin'], groups: [] }
  );
  assert.deepEqual(received, {
    revisionId: '101', hidden: true, expectedVersion: 3, actorProfileId: 99n, reason: '민감 정보 제거'
  });
  assert.equal(result.editSummaryModerationVersion, 4);
});

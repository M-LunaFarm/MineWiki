import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { WikiAclGroupAdminController, WikiAclGroupSelfController } from './wiki-acl-group.controller';
import type { WikiAclGroupService } from './wiki-acl-group.service';
import type { WikiProfileService } from './wiki-profile.service';

test('ACL group admin controller requires the dedicated ACL or wiki admin permission', async () => {
  const controller = new WikiAclGroupAdminController({} as WikiAclGroupService, {} as WikiProfileService);
  await assert.rejects(
    () => controller.list(undefined, undefined, undefined, {
      sessionId: 's', userId: 'account', isElevated: true, authenticatedAt: new Date().toISOString(), permissions: [], groups: []
    }),
    ForbiddenException
  );
});

test('ACL group admin controller forwards only an authorized actor profile', async () => {
  let actorProfileId: bigint | null = null;
  const controller = new WikiAclGroupAdminController({
    async createGroup(input) {
      actorProfileId = input.actorProfileId;
      return { id: '1' } as never;
    }
  } as WikiAclGroupService, {
    async ensureWikiProfile() { return { id: 8n }; }
  } as unknown as WikiProfileService);
  await controller.create({ key: 'trusted', title: '신뢰 사용자' }, {
    sessionId: 's', userId: 'account', isElevated: false, authenticatedAt: new Date().toISOString(),
    permissions: ['wiki.acl.manage'], groups: []
  });
  assert.equal(actorProfileId, 8n);
});

test('self removal forwards the centrally extracted session request IP and accepts no body IP', async () => {
  let received: Record<string, unknown> | null = null;
  const controller = new WikiAclGroupSelfController({
    async selfRemove(input) { received = input as unknown as Record<string, unknown>; return { removed: true, memberIds: ['3'] }; }
  } as WikiAclGroupService, {
    async ensureWikiProfile() { return { id: 9n }; }
  } as unknown as WikiProfileService);
  await controller.selfRemove('2', {
    sessionId: 's', userId: 'account', isElevated: false, authenticatedAt: new Date().toISOString(), requestIp: '2001:db8::10'
  });
  assert.deepEqual(received, { groupId: '2', profileId: 9n, requestIp: '2001:db8::10' });
});

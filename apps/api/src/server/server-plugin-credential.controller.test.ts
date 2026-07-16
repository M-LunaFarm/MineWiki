import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ServerController } from './server.controller';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';

const session: SessionPayload = {
  sessionId: 'session-1',
  userId: 'owner-account',
  isElevated: false,
  permissions: [],
  groups: [],
};

test('server wiki layout entitlements require an authenticated session', () => {
  const guards = Reflect.getMetadata(GUARDS_METADATA, ServerController.prototype.wikiLayouts) ?? [];
  assert.ok(guards.includes(SessionGuard));
});

interface PluginCredentialStub {
  create(serverId: string, input: { guildId: string }, actor: string): Promise<unknown>;
  [key: string]: unknown;
}

test('plugin credential creation requires Discord guild management access', async () => {
  const controller = createController({
    async assertCanManageGuild() {
      throw new ForbiddenException('Discord guild management permission is required.');
    },
  });

  await assert.rejects(
    () => controller.createPluginCredential(
      'server-1',
      { guildId: '1234567890' },
      session,
    ),
    (error: unknown) => error instanceof ForbiddenException,
  );
});

test('elevation without server authority cannot create a server wiki', async () => {
  let created = false;
  const controller = new ServerController(
    { async createServerWiki() { created = true; return {}; } } as never,
    { async isOwner() { return false; } } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  await assert.rejects(
    () => controller.createServerWiki('server-1', { ...session, isElevated: true }),
    /서버 위키를 만들거나 연결할 권한이 없습니다/
  );
  assert.equal(created, false);
});

test('elevation without server authority cannot read layout entitlements or update server wiki settings', async () => {
  let layoutsRead = false;
  let settingsRead = false;
  let settingsUpdated = false;
  const controller = new ServerController(
    {
      async getWikiLayoutSettings() { layoutsRead = true; return {}; },
      async getWikiContentSettings() { settingsRead = true; return {}; },
      async updateWikiContentSettings() { settingsUpdated = true; return {}; },
    } as never,
    { async isOwner() { return false; } } as never,
    {} as never,
    {} as never,
    {} as never,
    {
      async authorizeContentSettings() {
        throw new ForbiddenException('Wiki content settings permission is required.');
      },
    } as never,
  );
  const elevated = { ...session, isElevated: true };

  await assert.rejects(() => controller.wikiLayouts('server-1', elevated), ForbiddenException);
  await assert.rejects(() => controller.wikiSettings('server-1', elevated), ForbiddenException);
  await assert.rejects(
    () => controller.updateWikiSettings('server-1', {
      expectedVersion: 0,
      contributionPolicySource: null,
      editHelpSource: null,
      topNoticeSource: null,
      bottomNoticeSource: null,
      requireContributionPolicyAck: false,
    }, elevated),
    ForbiddenException,
  );
  assert.equal(layoutsRead, false);
  assert.equal(settingsRead, false);
  assert.equal(settingsUpdated, false);
});

test('server wiki managers receive content-only settings access through their canonical account', async () => {
  let updatedBy = '';
  const controller = new ServerController(
    {
      async getWikiContentSettings() { return { version: 3 }; },
      async updateWikiContentSettings(_serverId: string, _input: unknown, actorAccountId: string) {
        updatedBy = actorAccountId;
        return { version: 4 };
      },
    } as never,
    { async isOwner() { return false; } } as never,
    {} as never,
    {} as never,
    {} as never,
    {
      async authorizeContentSettings() {
        return { accountId: 'canonical-manager', kind: 'manager' as const };
      },
    } as never,
  );

  const read = await controller.wikiSettings('server-1', session);
  assert.deepEqual(read, {
    version: 3,
    access: {
      canManageContentSettings: true,
      canManageLayout: false,
      canManageCollaborators: false,
    },
  });
  const updated = await controller.updateWikiSettings('server-1', {
    expectedVersion: 3,
    contributionPolicySource: null,
    editHelpSource: null,
    topNoticeSource: null,
    bottomNoticeSource: null,
    requireContributionPolicyAck: false,
  }, session);
  assert.equal(updatedBy, 'canonical-manager');
  assert.equal(updated.access.canManageLayout, false);
  assert.equal(updated.access.canManageCollaborators, false);
});

test('server owner and global admin settings responses retain owner-only tabs', async () => {
  for (const kind of ['owner', 'server_admin'] as const) {
    const controller = new ServerController(
      { async getWikiContentSettings() { return { version: 3 }; } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        async authorizeContentSettings() {
          return { accountId: 'canonical-owner', kind };
        },
      } as never,
    );
    const read = await controller.wikiSettings('server-1', session);
    assert.equal(read.access.canManageLayout, true);
    assert.equal(read.access.canManageCollaborators, true);
  }
});

test('plugin credential creation binds only an accessible guild', async () => {
  let checkedGuildId = '';
  let createdGuildId = '';
  const controller = createController({
    async assertCanManageGuild(_session: SessionPayload, guildId: string) {
      checkedGuildId = guildId;
    },
  }, {
    async create(_serverId: string, input: { guildId: string }) {
      createdGuildId = input.guildId;
      return { id: 'credential-1', secret: 'one-time-secret' };
    },
  });

  const result = await controller.createPluginCredential(
    'server-1',
    { guildId: '1234567890' },
    session,
  );

  assert.equal(checkedGuildId, '1234567890');
  assert.equal(createdGuildId, '1234567890');
  assert.equal(result.secret, 'one-time-secret');
});

test('plugin credential rotation rechecks access to the bound guild', async () => {
  let rotateCalled = false;
  const controller = createController(
    {
      async assertCanManageGuild() {
        throw new ForbiddenException('Discord guild management permission is required.');
      },
    },
    {
      async create() {
        throw new Error('create should not run');
      },
      async get() {
        return { guildId: '1234567890' };
      },
      async rotate() {
        rotateCalled = true;
        return {};
      },
    },
  );

  await assert.rejects(
    () => controller.rotatePluginCredential('server-1', 'credential-1', session),
    ForbiddenException,
  );
  assert.equal(rotateCalled, false);
});

test('credential can be disabled without current guild access', async () => {
  let enabledValue = true;
  const controller = createController(
    {
      async assertCanManageGuild() {
        throw new Error('guild access should not be checked while disabling');
      },
    },
    {
      async create() {
        throw new Error('create should not run');
      },
      async setEnabled(_serverId: string, _credentialId: string, enabled: boolean) {
        enabledValue = enabled;
        return { enabled };
      },
    },
  );

  const result = await controller.updatePluginCredential(
    'server-1',
    'credential-1',
    { enabled: false },
    session,
  );
  assert.equal(result.enabled, false);
  assert.equal(enabledValue, false);
});

test('plugin diagnostics require current access to the bound guild', async () => {
  let eventsRead = false;
  const controller = createController(
    {
      async assertCanManageGuild() {
        throw new ForbiddenException('Discord guild management permission is required.');
      },
    },
    {
      async create() {
        throw new Error('create should not run');
      },
      async get() {
        return { guildId: '1234567890' };
      },
      async listEvents() {
        eventsRead = true;
        return [];
      },
    },
  );

  await assert.rejects(
    () => controller.listPluginCredentialEvents(
      'server-1',
      'credential-1',
      '50',
      session,
    ),
    ForbiddenException,
  );
  assert.equal(eventsRead, false);
});

function createController(
  guildAccess: { assertCanManageGuild(session: SessionPayload, guildId: string): Promise<void> },
  pluginCredentials: PluginCredentialStub = {
    async create() {
      throw new Error('create should not run');
    },
  },
): ServerController {
  return new ServerController(
    {} as never,
    { async isOwner() { return true; } } as never,
    {} as never,
    pluginCredentials as never,
    guildAccess as never,
    {} as never,
  );
}

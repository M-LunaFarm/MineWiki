import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { ServerController } from './server.controller';
import type { SessionPayload } from '../session/session.service';

const session: SessionPayload = {
  sessionId: 'session-1',
  userId: 'owner-account',
  isElevated: false,
  permissions: [],
  groups: [],
};

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
  pluginCredentials: { create(serverId: string, input: { guildId: string }, actor: string): Promise<any>; [key: string]: any } = {
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
  );
}

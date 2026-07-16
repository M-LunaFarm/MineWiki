import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ZodError } from 'zod';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { STEP_UP_PURPOSE_METADATA, StepUpGuard } from '../session/step-up.guard';
import { ServerWikiCollaboratorController } from './server-wiki-collaborator.controller';

const serverId = '11111111-1111-4111-8111-111111111111';
const session: SessionPayload = {
  sessionId: 'session-1',
  userId: '22222222-2222-4222-8222-222222222222',
  tokenVersion: 3,
  isElevated: true,
  authenticatedAt: '2026-07-17T00:00:00.000Z',
  permissions: ['server.admin'],
  groups: ['manager'],
};

test('collaborator controller requires SessionGuard before purpose-bound server_admin step-up', () => {
  assert.equal(
    Reflect.getMetadata(STEP_UP_PURPOSE_METADATA, ServerWikiCollaboratorController),
    'server_admin',
  );
  const guards = Reflect.getMetadata(GUARDS_METADATA, ServerWikiCollaboratorController) ?? [];
  assert.ok(guards.indexOf(SessionGuard) >= 0);
  assert.ok(guards.indexOf(StepUpGuard) > guards.indexOf(SessionGuard));
});

test('collaborator endpoints have bounded operation-specific throttles', () => {
  const expected = {
    list: 30,
    create: 8,
    update: 12,
    remove: 8,
  } as const;
  for (const [method, limit] of Object.entries(expected)) {
    const handler = ServerWikiCollaboratorController.prototype[
      method as keyof typeof ServerWikiCollaboratorController.prototype
    ];
    assert.equal(Reflect.getMetadata('THROTTLER:LIMITdefault', handler), limit);
    assert.equal(Reflect.getMetadata('THROTTLER:TTLdefault', handler), 60);
  }
});

test('controller forwards only canonical account identity and global permissions from the session', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const response = { serverId, spaceId: '9', assignableRoles: ['manager', 'editor', 'reviewer'], items: [] };
  const controller = new ServerWikiCollaboratorController({
    async list(receivedServerId: string, actor: unknown) {
      calls.push({ method: 'list', receivedServerId, actor });
      return response;
    },
    async create(receivedServerId: string, input: unknown, actor: unknown) {
      calls.push({ method: 'create', receivedServerId, input, actor });
      return response;
    },
    async update(receivedServerId: string, profileId: string, input: unknown, actor: unknown) {
      calls.push({ method: 'update', receivedServerId, profileId, input, actor });
      return response;
    },
    async remove(receivedServerId: string, profileId: string, input: unknown, actor: unknown) {
      calls.push({ method: 'remove', receivedServerId, profileId, input, actor });
      return response;
    },
  } as never);

  await controller.list(serverId, session);
  await controller.create(serverId, { username: 'Exact_User', role: 'editor', reason: '  편집 협업 요청  ' }, session);
  await controller.update(serverId, '41', { role: 'reviewer', expectedRole: 'editor', reason: '검토 역할 변경' }, session);
  await controller.remove(serverId, '41', { expectedRole: 'reviewer', reason: '협업 종료 처리' }, session);

  const actor = { accountId: session.userId, permissions: ['server.admin'] };
  assert.deepEqual(calls, [
    { method: 'list', receivedServerId: serverId, actor },
    {
      method: 'create',
      receivedServerId: serverId,
      input: { username: 'Exact_User', role: 'editor', reason: '편집 협업 요청' },
      actor,
    },
    {
      method: 'update',
      receivedServerId: serverId,
      profileId: '41',
      input: { role: 'reviewer', expectedRole: 'editor', reason: '검토 역할 변경' },
      actor,
    },
    {
      method: 'remove',
      receivedServerId: serverId,
      profileId: '41',
      input: { expectedRole: 'reviewer', reason: '협업 종료 처리' },
      actor,
    },
  ]);
});

test('controller rejects owner assignment, non-exact usernames, short reasons, and unknown fields', () => {
  const controller = new ServerWikiCollaboratorController({} as never);
  for (const body of [
    { username: 'Exact_User', role: 'owner', reason: '소유자 역할 요청' },
    { username: 'Ｅｘａｃｔ＿Ｕｓｅｒ', role: 'editor', reason: '편집 협업 요청' },
    { username: 'Exact_User', role: 'editor', reason: '짧음' },
    { username: 'Exact_User', role: 'editor', reason: '편집 협업 요청', owner: true },
  ]) {
    assert.throws(() => controller.create(serverId, body, session), ZodError);
  }
});

test('controller requires explicit expectedRole for role changes and removals', () => {
  const controller = new ServerWikiCollaboratorController({} as never);
  assert.throws(
    () => controller.update(serverId, '41', { role: 'reviewer', reason: '검토 역할 변경' }, session),
    ZodError,
  );
  assert.throws(
    () => controller.remove(serverId, '41', { reason: '협업 종료 처리' }, session),
    ZodError,
  );
});

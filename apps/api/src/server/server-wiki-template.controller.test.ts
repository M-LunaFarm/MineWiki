import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionPayload } from '../session/session.service';
import type { ServerWikiCollaboratorService } from './server-wiki-collaborator.service';
import { ServerWikiTemplateController } from './server-wiki-template.controller';
import type { ServerWikiTemplateService } from './server-wiki-template.service';

test('server wiki template controller authorizes every operation and forwards optimistic versions', async () => {
  const calls: unknown[] = [];
  const collaborators = {
    async authorizeContentSettings(serverId: string, actor: unknown) {
      calls.push({ method: 'authorize', serverId, actor });
      return { accountId: 'account-1', kind: 'manager' };
    },
  } as unknown as ServerWikiCollaboratorService;
  const templates = {
    async list(serverId: string) { calls.push({ method: 'list', serverId }); return []; },
    async create(serverId: string, accountId: string, body: unknown) { calls.push({ method: 'create', serverId, accountId, body }); return { id: '1' }; },
    async update(serverId: string, templateId: string, accountId: string, body: unknown) { calls.push({ method: 'update', serverId, templateId, accountId, body }); return { id: templateId }; },
    async archive(serverId: string, templateId: string, accountId: string, version: number) { calls.push({ method: 'archive', serverId, templateId, accountId, version }); return { id: templateId, status: 'archived' }; },
  } as unknown as ServerWikiTemplateService;
  const controller = new ServerWikiTemplateController(collaborators, templates);
  const session = { userId: 'account-1', permissions: ['server.wiki.manage'] } as SessionPayload;
  const serverId = '11111111-1111-4111-8111-111111111111';
  const body = { key: 'rules', title: '규칙', contentRaw: '본문', description: null, defaultCategory: null };

  await controller.list(serverId, session);
  await controller.create(serverId, body, session);
  await controller.update(serverId, '7', { ...body, expectedVersion: 3 }, session);
  await controller.archive(serverId, '7', '4', session);

  assert.equal(calls.filter((call) => (call as { method: string }).method === 'authorize').length, 4);
  assert.deepEqual(calls.at(-1), { method: 'archive', serverId, templateId: '7', accountId: 'account-1', version: 4 });
});

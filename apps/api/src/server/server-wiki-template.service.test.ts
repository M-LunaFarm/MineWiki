import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import type { BusinessEventService } from '../events/business-event.service';
import type { WikiProfileService } from '../wiki/wiki-profile.service';
import { ServerWikiTemplateService } from './server-wiki-template.service';

function fixture() {
  const audits: Array<{ readonly action: string; readonly input: unknown }> = [];
  const rows = new Map<bigint, Record<string, unknown>>();
  let nextId = 1n;
  const prisma = {
    serverWiki: {
      async findFirst(input: { where: { voteServerId: string } }) {
        return input.where.voteServerId === '11111111-1111-4111-8111-111111111111'
          ? { id: 7n, spaceId: 22n, voteServerId: input.where.voteServerId }
          : { id: 8n, spaceId: 33n, voteServerId: input.where.voteServerId };
      },
    },
    documentTemplate: {
      async findMany(input: { where: { spaceId: bigint; status: string } }) {
        return [...rows.values()].filter((row) => row.spaceId === input.where.spaceId && row.status === input.where.status);
      },
      async create(input: { data: Record<string, unknown> }) {
        const now = input.data.updatedAt as Date;
        const row = { id: nextId++, ...input.data, updatedAt: now };
        rows.set(row.id, row);
        return row;
      },
      async findFirst(input: { where: { id: bigint; spaceId: bigint; status: string } }) {
        const row = rows.get(input.where.id);
        return row?.spaceId === input.where.spaceId && row.status === input.where.status ? row : null;
      },
      async updateMany(input: { where: { id: bigint; spaceId: bigint; version: number }; data: Record<string, unknown> }) {
        const row = rows.get(input.where.id);
        if (!row || row.spaceId !== input.where.spaceId || row.version !== input.where.version || row.status !== 'active') return { count: 0 };
        const next = { ...row, ...input.data, version: Number(row.version) + 1 };
        if (typeof input.data.status === 'string') next.status = input.data.status;
        rows.set(input.where.id, next);
        return { count: 1 };
      },
    },
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 9n, status: 'active' }; } } as unknown as WikiProfileService;
  const events = { async audit(action: string, input: unknown) { audits.push({ action, input }); } } as unknown as BusinessEventService;
  return { service: new ServerWikiTemplateService(prisma, profiles, events), rows, audits };
}

const serverId = '11111111-1111-4111-8111-111111111111';
const input = { key: 'rules', title: '서버 규칙', description: '규칙 시작점', defaultCategory: '서버 규칙', contentRaw: '== 기본 규칙 ==\n서로 존중해 주세요.' };

test('server wiki template lifecycle stays space-scoped, versioned, and audited', async () => {
  const { service, audits } = fixture();
  const created = await service.create(serverId, 'account-1', input);
  assert.equal(created.version, 1);
  assert.deepEqual((await service.list(serverId)).map((item) => item.id), [created.id]);
  assert.deepEqual(await service.list('22222222-2222-4222-8222-222222222222'), []);

  const updated = await service.update(serverId, created.id, 'account-1', { ...input, expectedVersion: 1, title: '운영 규칙' });
  assert.equal(updated.version, 2);
  assert.equal(updated.title, '운영 규칙');
  await assert.rejects(
    () => service.update(serverId, created.id, 'account-1', { ...input, expectedVersion: 1 }),
    (error: unknown) => error instanceof ConflictException && error.getStatus() === 409,
  );

  assert.deepEqual(await service.archive(serverId, created.id, 'account-1', 2), { id: created.id, status: 'archived' });
  assert.deepEqual(await service.list(serverId), []);
  assert.deepEqual(audits.map((entry) => entry.action), [
    'server.wiki.template.create', 'server.wiki.template.update', 'server.wiki.template.archive',
  ]);
});

test('server wiki templates reject markup that normal wiki revisions cannot store', async () => {
  const { service } = fixture();
  await assert.rejects(
    () => service.create(serverId, 'account-1', { ...input, contentRaw: '<script>alert(1)</script>' }),
    /저장할 수 없는 마크업/u,
  );
});

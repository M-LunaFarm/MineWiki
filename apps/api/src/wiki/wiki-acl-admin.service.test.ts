import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PrismaService } from '../common/prisma.service';
import { WikiAdminService } from './wiki-admin.service';

test('ACL admin creates an ordered rule and immutable change log', async () => {
  const createdAt = new Date('2026-07-12T06:00:00.000Z');
  const logs: unknown[] = [];
  const audits: unknown[] = [];
  const store = {
    aclRule: {
      async aggregate() { return { _max: { sortOrder: 20 } }; },
      async create({ data }: { data: Record<string, unknown> }) {
        return { id: 9n, ...data, createdAt, updatedAt: createdAt };
      }
    },
    aclChangeLog: {
      async create({ data }: { data: unknown }) { logs.push(data); return { id: 1n }; }
    },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) { return callback(store); }
  };
  const service = new WikiAdminService(
    store as unknown as PrismaService,
    { async audit(...args: unknown[]) { audits.push(args); } } as never
  );

  const result = await service.createAclRule({
    targetType: 'namespace',
    targetId: '7',
    action: 'edit',
    effect: 'allow',
    subjectType: 'role',
    subjectValue: 'server_editor',
    reason: '서버 위키 편집자 허용',
    actorProfileId: 3n
  });

  assert.equal(result.id, '9');
  assert.equal(result.sortOrder, 30);
  assert.equal(result.targetId, '7');
  assert.equal(logs.length, 1);
  assert.equal(audits.length, 1);
});

test('ACL admin rejects resource rules without an unsigned target id', async () => {
  const service = new WikiAdminService({} as PrismaService);

  await assert.rejects(
    () => service.createAclRule({
      targetType: 'page',
      targetId: '../1',
      action: 'read',
      effect: 'deny',
      subjectType: 'perm',
      subjectValue: 'guest',
      actorProfileId: 3n
    }),
    /targetId must be an unsigned integer/
  );
});

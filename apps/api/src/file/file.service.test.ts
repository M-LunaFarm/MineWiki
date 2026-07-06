import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FilePermissionService } from './file-permission.service';
import { FileService } from './file.service';

function session(userId: string, isElevated = false) {
  return {
    sessionId: `session-${userId}`,
    userId,
    isElevated
  };
}

function createService() {
  const files = new Map<string, any>();
  const uploads = {
    async storeImage() {
      return {
        filename: 'stored.webp',
        mimeType: 'image/webp',
        size: 123,
        width: 80,
        height: 40,
        hash: 'a'.repeat(64),
        storagePath: '/tmp/stored.webp',
        publicPath: 'upload://stored.webp'
      };
    }
  };
  const prisma = {
    uploadedFile: {
      async create(args: { data: any }) {
        const now = new Date('2026-07-05T00:00:00.000Z');
        const file = {
          id: `file-${files.size + 1}`,
          status: 'active',
          visibility: 'public',
          linkedResourceType: null,
          linkedResourceId: null,
          createdAt: now,
          updatedAt: now,
          ...args.data
        };
        files.set(file.id, file);
        return file;
      },
      async findUnique(args: { where: { id: string } }) {
        return files.get(args.where.id) ?? null;
      },
      async findMany(args: { where: any; take: number }) {
        const rows = [...files.values()].filter((file) => {
          if (args.where.status && file.status !== args.where.status) return false;
          if (args.where.usageContext && file.usageContext !== args.where.usageContext) return false;
          if (args.where.OR?.length) {
            const visible = args.where.OR.some((condition: any) => {
              if (Object.keys(condition).length === 0) return true;
              if (condition.visibility?.in) return condition.visibility.in.includes(file.visibility);
              if (condition.ownerAccountId) return file.ownerAccountId === condition.ownerAccountId;
              return false;
            });
            if (!visible) return false;
          }
          const searchOr = args.where.AND?.[0]?.OR;
          if (searchOr?.length) {
            const matches = searchOr.some((condition: any) => {
              if (condition.filename?.contains) return file.filename.includes(condition.filename.contains);
              if (condition.originalName?.contains) return file.originalName?.includes(condition.originalName.contains);
              return false;
            });
            if (!matches) return false;
          }
          return true;
        });
        return rows.slice(0, args.take);
      },
      async update(args: { where: { id: string }; data: any }) {
        const current = files.get(args.where.id);
        const next = { ...current, ...args.data };
        files.set(args.where.id, next);
        return next;
      }
    }
  };
  return { service: new FileService(prisma as never, uploads as never, new FilePermissionService()), files };
}

test('file service stores canonical image metadata', async () => {
  const { service } = createService();
  const uploaded = await service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'wiki.png',
    usageContext: 'wiki_editor'
  });

  assert.equal(uploaded.id, 'file-1');
  assert.equal(uploaded.filename, 'stored.webp');
  assert.equal(uploaded.originalName, 'wiki.png');
  assert.equal(uploaded.ownerAccountId, 'account-1');
  assert.equal(uploaded.usageContext, 'wiki_editor');
  assert.equal(uploaded.visibility, 'public');
  assert.equal(uploaded.url, 'upload://stored.webp');
});

test('file service list hides private files from anonymous users', async () => {
  const { service, files } = createService();
  const publicFile = await service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'public.png',
    usageContext: 'wiki_editor'
  });
  const privateFile = await service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'private.png',
    usageContext: 'wiki_editor',
    visibility: 'private'
  });

  const anonymous = await service.listFiles({ usageContext: 'wiki_editor' });
  assert.deepEqual(anonymous.map((file) => file.filename), [publicFile.filename]);

  const owner = await service.listFiles({ usageContext: 'wiki_editor', session: session('account-1') });
  assert.equal(owner.length, 2);

  const elevated = await service.listFiles({ usageContext: 'wiki_editor', session: session('admin', true) });
  assert.equal(elevated.length, 2);
});

test('file service requires owner before delete', async () => {
  const { service } = createService();
  const uploaded = await service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'wiki.png'
  });

  await assert.rejects(() => service.deleteFile(uploaded.id, session('account-2')), /owner is required/);
  await assert.doesNotReject(() => service.deleteFile(uploaded.id, session('account-1')));
});

test('private raw file is only readable by owner or elevated session', async () => {
  const { service, files } = createService();
  const uploaded = await service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'wiki.png',
    visibility: 'private'
  });
  files.set(uploaded.id, {
    ...files.get(uploaded.id),
    publicPath: 'https://cdn.example.test/private.webp'
  });

  await assert.rejects(() => service.getRawFile(uploaded.id, null), /File not found/);
  await assert.rejects(() => service.getRawFile(uploaded.id, session('account-2')), /File not found/);
  const ownerRaw = await service.getRawFile(uploaded.id, session('account-1'));
  assert.equal(ownerRaw.redirectUrl, 'https://cdn.example.test/private.webp');
  assert.equal(ownerRaw.cacheControl, 'private, no-store');
  const adminRaw = await service.getRawFile(uploaded.id, session('admin', true));
  assert.equal(adminRaw.redirectUrl, 'https://cdn.example.test/private.webp');
});

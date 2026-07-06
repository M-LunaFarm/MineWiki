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
          id: 'file-1',
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

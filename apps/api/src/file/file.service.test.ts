import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePermissionService } from './file-permission.service';
import { FileService } from './file.service';

interface TestFile {
  id: string;
  ownerAccountId: string | null;
  filename: string;
  originalName: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  storagePath: string;
  publicPath: string;
  usageContext: string;
  visibility: string;
  license: string | null;
  sourceUrl: string | null;
  sourceText: string | null;
  linkedResourceType: string | null;
  linkedResourceId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

interface VisibilityCondition {
  visibility?: { in: string[] };
  ownerAccountId?: string;
}

interface SearchCondition {
  filename?: { contains: string };
  originalName?: { contains: string };
}

interface TestFileWhere {
  status?: string;
  usageContext?: string;
  OR?: VisibilityCondition[];
  AND?: Array<{ OR?: SearchCondition[] }>;
}

function session(userId: string, isElevated = false, permissions: string[] = []) {
  return {
    sessionId: `session-${userId}`,
    userId,
    isElevated,
    permissions,
    groups: []
  };
}

function createService(options: { denyUploadFile?: boolean; failFileDocument?: boolean } = {}) {
  const files = new Map<string, TestFile>();
  const actionCalls: string[] = [];
  const fileDocuments: Array<{ filename: string; linkedPageId: string }> = [];
  const wikiPages = new Map<bigint, { id: bigint; status: string }>([
    [7n, { id: 7n, status: 'normal' }]
  ]);
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
    },
    async readPrivateObject() {
      return Buffer.from('private s3 image');
    }
  };
  const prisma = {
    uploadedFile: {
      async create(args: { data: Record<string, unknown> }) {
        const now = new Date('2026-07-05T00:00:00.000Z');
        const file = {
          id: `file-${files.size + 1}`,
          status: 'active',
          visibility: 'public',
          license: null,
          sourceUrl: null,
          sourceText: null,
          linkedResourceType: null,
          linkedResourceId: null,
          createdAt: now,
          updatedAt: now,
          ...args.data
        } as TestFile;
        files.set(file.id, file);
        return file;
      },
      async findUnique(args: { where: { id: string } }) {
        return files.get(args.where.id) ?? null;
      },
      async findFirst(args: { where: { filename: string } }) {
        return [...files.values()].find((file) => file.filename === args.where.filename) ?? null;
      },
      async findMany(args: { where: TestFileWhere; take: number }) {
        const rows = [...files.values()].filter((file) => {
          if (args.where.status && file.status !== args.where.status) return false;
          if (args.where.usageContext && file.usageContext !== args.where.usageContext) return false;
          if (args.where.OR?.length) {
            const visible = args.where.OR.some((condition) => {
              if (Object.keys(condition).length === 0) return true;
              if (condition.visibility?.in) return condition.visibility.in.includes(file.visibility);
              if (condition.ownerAccountId) return file.ownerAccountId === condition.ownerAccountId;
              return false;
            });
            if (!visible) return false;
          }
          const searchOr = args.where.AND?.[0]?.OR;
          if (searchOr?.length) {
            const matches = searchOr.some((condition) => {
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
      async update(args: { where: { id: string }; data: Partial<TestFile> }) {
        const current = files.get(args.where.id);
        assert.ok(current);
        const next = { ...current, ...args.data };
        files.set(args.where.id, next);
        return next;
      }
    },
    wikiPage: {
      async findUnique(args: { where: { id: bigint } }) {
        return wikiPages.get(args.where.id) ?? null;
      }
    },
    wikiSpace: {
      async findUnique() {
        return null;
      }
    },
    wikiNamespace: {
      async findUnique() {
        return null;
      }
    }
  };
  const wikiPermissions = {
    async resolveActor(accountId: string) {
      return { accountId, profileId: 1n, status: 'active' };
    },
    async assertCanEditPage({ page }: { page: { status: string } | null }) {
      if (!page || page.status !== 'normal') throw new Error('Wiki page not found.');
    },
    async assertCanUsePageAction({ action }: { action: string }) {
      actionCalls.push(action);
      if (options.denyUploadFile && action === 'upload_file') throw new Error('Wiki page not found.');
    },
    async assertCanReadPage({ page }: { page: { status: string } | null }) {
      if (!page || page.status !== 'normal') throw new Error('Wiki page not found.');
    },
    async assertCanReadSpace() {
      throw new Error('Wiki space not found.');
    }
  };
  const filePermissions = new FilePermissionService(prisma as never, wikiPermissions as never);
  const wikiEdits = {
    async createFileDocumentAfterAuthorizedUpload(
      _session: unknown,
      request: { filename: string; linkedPageId: string }
    ) {
      if (options.failFileDocument) throw new Error('File document failed.');
      fileDocuments.push(request);
      return { pageId: '99' };
    }
  };
  return {
    service: new FileService(prisma as never, uploads as never, filePermissions, undefined, wikiEdits as never),
    files,
    wikiPages,
    actionCalls,
    fileDocuments
  };
}

test('file service stores canonical image metadata', async () => {
  const { service, actionCalls, fileDocuments } = createService();
  const uploaded = await service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'wiki.png',
    usageContext: 'wiki_editor',
    license: 'self-created',
    linkedResourceType: 'wiki_page',
    linkedResourceId: '7'
  }, session('account-1'));

  assert.equal(uploaded.id, 'file-1');
  assert.equal(uploaded.filename, 'stored.webp');
  assert.equal(uploaded.originalName, 'wiki.png');
  assert.equal(uploaded.ownerAccountId, 'account-1');
  assert.equal(uploaded.usageContext, 'wiki_editor');
  assert.equal(uploaded.visibility, 'restricted');
  assert.equal(uploaded.license, 'self-created');
  assert.equal(uploaded.sourceText, '업로더 직접 제작');
  assert.deepEqual(actionCalls, ['upload_file']);
  assert.deepEqual(fileDocuments, [{ filename: 'stored.webp', linkedPageId: '7' }]);
  assert.equal(uploaded.wikiDocumentPath, '/file/stored.webp');
  assert.equal(uploaded.url, 'upload://stored.webp');
});

test('file service list hides private and unlisted files from non-owners', async () => {
  const { service } = createService();
  const publicFile = await service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'public.png',
    usageContext: 'general'
  });
  await service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'private.png',
    usageContext: 'general',
    visibility: 'private'
  });
  await service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'shared-by-link.png',
    usageContext: 'general',
    visibility: 'unlisted'
  });

  const anonymous = await service.listFiles({ usageContext: 'general' });
  assert.deepEqual(anonymous.map((file) => file.filename), [publicFile.filename]);

  const otherMember = await service.listFiles({
    usageContext: 'general',
    session: session('account-2')
  });
  assert.deepEqual(otherMember.map((file) => file.filename), [publicFile.filename]);

  const owner = await service.listFiles({ usageContext: 'general', session: session('account-1') });
  assert.equal(owner.length, 3);

  const elevated = await service.listFiles({ usageContext: 'general', session: session('admin', true) });
  assert.equal(elevated.length, 3);

  const fileAdmin = await service.listFiles({
    usageContext: 'general',
    session: session('file-admin', false, ['file.admin'])
  });
  assert.equal(fileAdmin.length, 3);
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
  const directory = mkdtempSync(join(tmpdir(), 'minewiki-file-test-'));
  const storagePath = join(directory, 'private.webp');
  writeFileSync(storagePath, 'private image');
  const uploaded = await service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'wiki.png',
    visibility: 'private'
  });
  files.set(uploaded.id, {
    ...files.get(uploaded.id),
    storagePath,
    publicPath: 'https://cdn.example.test/private.webp'
  });

  try {
    await assert.rejects(() => service.getRawFile(uploaded.id, null), /File not found/);
    await assert.rejects(() => service.getRawFile(uploaded.id, session('account-2')), /File not found/);
    const ownerRaw = await service.getRawFile(uploaded.id, session('account-1'));
    assert.equal(ownerRaw.redirectUrl, undefined);
    assert.equal(ownerRaw.buffer?.toString(), 'private image');
    assert.equal(ownerRaw.cacheControl, 'private, no-store');
    const adminRaw = await service.getRawFile(uploaded.id, session('admin', true));
    assert.equal(adminRaw.redirectUrl, undefined);
    assert.equal(adminRaw.cacheControl, 'private, no-store');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('public upload path resolves through the same visibility policy', async () => {
  const { service, files } = createService();
  const uploaded = await service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'wiki.png',
    visibility: 'private'
  });
  files.set(uploaded.id, {
    ...files.get(uploaded.id),
    storagePath: 's3://minewiki/uploads/stored.webp',
    publicPath: 'https://cdn.example.test/uploads/stored.webp'
  });

  await assert.rejects(() => service.getRawFileByFilename('../stored.webp', session('account-1')), /File not found/);
  await assert.rejects(() => service.getRawFileByFilename(uploaded.filename, null), /File not found/);
  const ownerRaw = await service.getRawFileByFilename(uploaded.filename, session('account-1'));
  assert.equal(ownerRaw.redirectUrl, undefined);
  assert.equal(ownerRaw.buffer?.toString(), 'private s3 image');
  assert.equal(ownerRaw.cacheControl, 'private, no-store');
});

test('restricted wiki file follows linked page read permission', async () => {
  const { service, wikiPages } = createService();
  const uploaded = await service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'restricted.png',
    usageContext: 'wiki_editor',
    license: 'cc-by-sa-4.0',
    sourceUrl: 'https://example.com/source.png',
    visibility: 'restricted',
    linkedResourceType: 'wiki_page',
    linkedResourceId: '7'
  }, session('account-1'));

  assert.equal(uploaded.visibility, 'restricted');
  assert.equal(uploaded.linkedResourceType, 'wiki_page');
  assert.equal(uploaded.linkedResourceId, '7');
  assert.equal(uploaded.license, 'cc-by-sa-4.0');
  assert.equal(uploaded.sourceUrl, 'https://example.com/source.png');
  await assert.doesNotReject(() => service.getFile(uploaded.id, null));

  wikiPages.set(7n, { id: 7n, status: 'hidden' });
  await assert.rejects(() => service.getFile(uploaded.id, null), /Wiki page not found/);
  await assert.doesNotReject(() => service.getFile(uploaded.id, session('account-1')));
});

test('restricted upload fails closed without a linked wiki resource', async () => {
  const { service } = createService();
  await assert.rejects(
    () => service.createImage('account-1', {
      data: 'data:image/png;base64,aW1hZ2U=',
      filename: 'orphan.png',
      visibility: 'restricted'
    }, session('account-1')),
    /require a linked wiki page or space/
  );
});

test('wiki uploads require supported license metadata before storage', async () => {
  const { service, files } = createService();
  await assert.rejects(
    () => service.createImage('account-1', {
      data: 'data:image/png;base64,aW1hZ2U=',
      filename: 'missing-license.png',
      usageContext: 'wiki_editor',
      linkedResourceType: 'wiki_page',
      linkedResourceId: '7'
    }, session('account-1')),
    /license is required/
  );
  await assert.rejects(
    () => service.createImage('account-1', {
      data: 'data:image/png;base64,aW1hZ2U=',
      filename: 'missing-source.png',
      usageContext: 'wiki_editor',
      license: 'cc-by-4.0',
      linkedResourceType: 'wiki_page',
      linkedResourceId: '7'
    }, session('account-1')),
    /source URL is required/
  );
  assert.equal(files.size, 0);
});

test('wiki uploads enforce upload_file ACL separately from edit access', async () => {
  const { service, files } = createService({ denyUploadFile: true });
  await assert.rejects(
    () => service.createImage('account-1', {
      data: 'data:image/png;base64,aW1hZ2U=',
      filename: 'denied.png',
      usageContext: 'wiki_editor',
      license: 'self-created',
      linkedResourceType: 'wiki_page',
      linkedResourceId: '7'
    }, session('account-1')),
    /Wiki page not found/
  );
  assert.equal(files.size, 0);
});

test('failed file document creation disables the uploaded record', async () => {
  const { service, files } = createService({ failFileDocument: true });
  await assert.rejects(
    () => service.createImage('account-1', {
      data: 'data:image/png;base64,aW1hZ2U=',
      filename: 'orphaned.png',
      usageContext: 'wiki_editor',
      license: 'self-created',
      linkedResourceType: 'wiki_page',
      linkedResourceId: '7'
    }, session('account-1')),
    /File document failed/
  );
  assert.equal([...files.values()][0]?.status, 'deleted');
});

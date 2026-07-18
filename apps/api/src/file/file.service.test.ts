import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileReadDecision, FilePermissionService } from './file-permission.service';
import { FileService } from './file.service';

interface TestFile {
  id: string;
  ownerAccountId: string | null;
  filename: string;
  wikiFilename: string | null;
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
  deletedAt: Date | null;
  retainedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

test('shared file read policy treats owners and file administrators identically', () => {
  const privateFile = { ownerAccountId: 'owner', visibility: 'private', status: 'active' };
  assert.equal(fileReadDecision(privateFile, { accountId: 'owner' }), 'allow');
  assert.equal(fileReadDecision(privateFile, { accountId: 'admin', permissions: ['file.admin'] }), 'allow');
  assert.equal(fileReadDecision(privateFile, { accountId: 'stranger' }), 'deny');
  assert.equal(fileReadDecision({ ...privateFile, visibility: 'restricted' }, { accountId: 'stranger' }), 'linked');
  assert.equal(fileReadDecision({ ...privateFile, status: 'delete_pending' }, { accountId: 'owner' }), 'missing');
});

interface VisibilityCondition {
  visibility?: { in: string[] };
  ownerAccountId?: string;
}

interface SearchCondition {
  filename?: { contains: string };
  wikiFilename?: { contains: string };
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

function createService(options: { denyUploadFile?: boolean; failFileDocument?: boolean; referencedWikiFilename?: string; failObjectDelete?: boolean } = {}) {
  const files = new Map<string, TestFile>();
  const actionCalls: string[] = [];
  const fileDocuments: Array<{
    filename: string;
    linkedPageId?: string;
    linkedSpaceId?: string;
  }> = [];
  const deletedFileDocuments: string[] = [];
  const fileVersions: Array<Record<string, unknown>> = [];
  let deleteAttempts = 0;
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
    },
    async deleteObject() {
      deleteAttempts += 1;
      if (options.failObjectDelete) throw new Error('storage unavailable');
    }
  };
  const prisma = {
    async $transaction(callback: (store: unknown) => Promise<unknown>) {
      return callback(prisma);
    },
    async $queryRaw() {
      return options.referencedWikiFilename ? [{ sourcePageId: 7n }] : [];
    },
    uploadedFile: {
      async create(args: { data: Record<string, unknown> }) {
        const now = new Date('2026-07-05T00:00:00.000Z');
        const file = {
          id: `file-${files.size + 1}`,
          status: 'active',
          visibility: 'public',
          wikiFilename: null,
          license: null,
          sourceUrl: null,
          sourceText: null,
          linkedResourceType: null,
          linkedResourceId: null,
          deletedAt: null,
          retainedUntil: null,
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
              if (condition.wikiFilename?.contains) return file.wikiFilename?.includes(condition.wikiFilename.contains);
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
    wikiFileVersion: {
      async create({ data }: { data: Record<string, unknown> }) {
        fileVersions.push(data);
        return { id: BigInt(fileVersions.length), ...data };
      }
    },
    wikiPage: {
      async findUnique(args: { where: { id: bigint } }) {
        return wikiPages.get(args.where.id) ?? null;
      }
    },
    wikiSpace: {
      async findUnique(args: { where: { id: bigint } }) {
        return args.where.id === 3n
          ? {
              id: 3n,
              status: 'active',
              rootNamespaceCode: 'main',
              title: '메인 위키',
              createdBy: 1n,
            }
          : null;
      }
    },
    wikiNamespace: {
      async findUnique(args: { where: { code: string } }) {
        return args.where.code === 'main' ? { id: 1, code: 'main' } : null;
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
      request: { filename: string; linkedPageId?: string; linkedSpaceId?: string }
    ) {
      if (options.failFileDocument) throw new Error('File document failed.');
      fileDocuments.push(request);
      return { pageId: '99', revisionId: '101', revisionNo: 1 };
    },
    async deleteFileDocumentAfterAuthorizedUpload(_session: unknown, filename: string) {
      deletedFileDocuments.push(filename);
    }
  };
  return {
    service: new FileService(prisma as never, uploads as never, filePermissions, undefined, wikiEdits as never),
    files,
    wikiPages,
    actionCalls,
    fileDocuments,
    fileVersions,
    deletedFileDocuments,
    getDeleteAttempts: () => deleteAttempts
  };
}

test('file service stores canonical image metadata', async () => {
  const { service, actionCalls, fileDocuments, fileVersions } = createService();
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
  assert.equal(uploaded.storageFilename, 'stored.webp');
  assert.equal(uploaded.wikiFilename, 'wiki.webp');
  assert.equal(uploaded.originalName, 'wiki.png');
  assert.equal(uploaded.ownerAccountId, 'account-1');
  assert.equal(uploaded.usageContext, 'wiki_editor');
  assert.equal(uploaded.visibility, 'restricted');
  assert.deepEqual(fileVersions[0], {
    filePageId: 99n,
    pageRevisionId: 101n,
    uploadedFileId: 'file-1',
    versionNo: 1,
    isCurrent: true,
    createdByAccountId: 'account-1',
    createdAt: new Date('2026-07-05T00:00:00.000Z'),
  });
  assert.equal(uploaded.license, 'self-created');
  assert.equal(uploaded.sourceText, '업로더 직접 제작');
  assert.deepEqual(actionCalls, ['upload_file']);
  assert.deepEqual(fileDocuments, [{ filename: 'wiki.webp', linkedPageId: '7' }]);
  assert.equal(uploaded.wikiDocumentPath, '/file/wiki.webp');
  assert.equal(uploaded.url, 'upload://stored.webp');
});

test('standalone wiki uploads can bind to an editable wiki space', async () => {
  const { service, actionCalls, fileDocuments } = createService();
  const uploaded = await service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'standalone.png',
    usageContext: 'wiki_editor',
    license: 'self-created',
    linkedResourceType: 'wiki_space',
    linkedResourceId: '3',
  }, session('account-1'));

  assert.equal(uploaded.linkedResourceType, 'wiki_space');
  assert.equal(uploaded.linkedResourceId, '3');
  assert.deepEqual(actionCalls, ['upload_file']);
  assert.deepEqual(fileDocuments, [{ filename: 'standalone.webp', linkedSpaceId: '3' }]);
  assert.equal(uploaded.wikiDocumentPath, '/file/standalone.webp');
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
  assert.equal(elevated.length, 1);

  const fileAdmin = await service.listFiles({
    usageContext: 'general',
    session: session('file-admin', false, ['file.admin'])
  });
  assert.equal(fileAdmin.length, 3);
});

test('file service requires owner before delete', async () => {
  const { service, files, getDeleteAttempts } = createService();
  const uploaded = await service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'wiki.png'
  });

  await assert.rejects(() => service.deleteFile(uploaded.id, session('account-2', true)), /owner is required/);
  await assert.doesNotReject(() => service.deleteFile(uploaded.id, session('account-1')));
  assert.equal(files.get(uploaded.id)?.status, 'deleted');
  assert.equal(getDeleteAttempts(), 1);
});

test('wiki file deletion blocks current references and keeps failed object deletion retryable', async () => {
  const referenced = createService({ referencedWikiFilename: 'stored.webp' });
  const uploaded = await referenced.service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'wiki.png',
    usageContext: 'wiki_editor',
    license: 'self-created',
    linkedResourceType: 'wiki_page',
    linkedResourceId: '7'
  }, session('account-1'));
  await assert.rejects(() => referenced.service.deleteFile(uploaded.id, session('account-1')), /still referenced/);
  assert.equal(referenced.files.get(uploaded.id)?.status, 'active');
  assert.equal(referenced.getDeleteAttempts(), 0);

  const failing = createService({ failObjectDelete: true });
  const retryable = await failing.service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'general.png'
  });
  await assert.rejects(() => failing.service.deleteFile(retryable.id, session('account-1')), /Retry the same request/);
  assert.equal(failing.files.get(retryable.id)?.status, 'delete_pending');
  await assert.rejects(() => failing.service.getFile(retryable.id, session('account-1')), /File not found/);
});

test('wiki file deletion retires its document while retaining the recoverable object and logical filename', async () => {
  const { service, files, deletedFileDocuments, getDeleteAttempts } = createService();
  const uploaded = await service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: 'retire me.png',
    usageContext: 'wiki_editor',
    license: 'self-created',
    linkedResourceType: 'wiki_page',
    linkedResourceId: '7'
  }, session('account-1'));

  await service.deleteFile(uploaded.id, session('account-1'));

  assert.deepEqual(deletedFileDocuments, ['retire_me.webp']);
  assert.equal(files.get(uploaded.id)?.status, 'retained');
  assert.equal(files.get(uploaded.id)?.wikiFilename, 'retire_me.webp');
  assert.equal(getDeleteAttempts(), 0);
  assert.ok(files.get(uploaded.id)?.deletedAt instanceof Date);
  assert.ok(files.get(uploaded.id)?.retainedUntil instanceof Date);
});

test('private raw file is only readable by owner or file administrator', async () => {
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
    await assert.rejects(() => service.getRawFile(uploaded.id, session('elevated', true)), /File not found/);
    const adminRaw = await service.getRawFile(uploaded.id, session('admin', false, ['file.admin']));
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

test('failed file document creation disables the uploaded record and removes its object', async () => {
  const { service, files, getDeleteAttempts } = createService({ failFileDocument: true });
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
  assert.equal([...files.values()][0]?.wikiFilename, null);
  assert.equal(getDeleteAttempts(), 1);
});

test('wiki upload keeps the logical filename separate from immutable storage', async () => {
  const { service, files } = createService();
  const uploaded = await service.createImage('account-1', {
    data: 'data:image/png;base64,aW1hZ2U=',
    filename: '서버 아이콘.png',
    usageContext: 'wiki_editor',
    license: 'self-created',
    linkedResourceType: 'wiki_page',
    linkedResourceId: '7'
  }, session('account-1'));

  assert.equal(uploaded.filename, 'stored.webp');
  assert.equal(uploaded.storageFilename, 'stored.webp');
  assert.equal(uploaded.wikiFilename, '서버_아이콘.webp');
  assert.equal(files.get(uploaded.id)?.wikiFilename, '서버_아이콘.webp');
  assert.equal(uploaded.status, 'active');
});

test('wiki upload rejects invisible Unicode filename controls before creating a record', async () => {
  const { service, files, getDeleteAttempts } = createService();
  await assert.rejects(
    () => service.createImage('account-1', {
      data: 'data:image/png;base64,aW1hZ2U=',
      filename: 'safe\u200Bname.png',
      usageContext: 'wiki_editor',
      license: 'self-created',
      linkedResourceType: 'wiki_page',
      linkedResourceId: '7'
    }, session('account-1')),
    /Wiki filename is invalid/
  );
  assert.equal(files.size, 0);
  assert.equal(getDeleteAttempts(), 1);
});

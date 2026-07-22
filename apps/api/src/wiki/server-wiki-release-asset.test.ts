import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMarkup } from '@minewiki/wiki-core';
import { WikiReadService } from './wiki-read.service';

test('v3 release preserves v2 pinned asset semantics instead of using a live replacement', async () => {
  const requestedFileIds: string[][] = [];
  const oldFileId = '11111111-1111-4111-8111-111111111111';
  const replacementId = '22222222-2222-4222-8222-222222222222';
  const prisma = {
    serverWikiRelease: { async findUnique() { return { snapshotVersion: 3 }; } },
    serverWikiReleaseAsset: {
      async findMany() {
        return [{
          id: 1n,
          releaseId: 70n,
          serverWikiId: 50n,
          spaceId: 10n,
          wikiFilename: 'logo.png',
          uploadedFileId: oldFileId,
          wikiFileVersionId: 31n,
          sha256: 'a'.repeat(64),
          publicPath: `/uploads/${oldFileId}`,
          mimeType: 'image/png',
          originalName: 'old-logo.png',
          sizeBytes: 128,
          width: 16,
          height: 16,
          license: 'CC-BY-4.0',
          sourceUrl: null,
          sourceText: 'old attribution',
          publicReadAllowed: true,
        }];
      },
    },
    uploadedFile: {
      async findMany(input: { where: { id: { in: string[] } } }) {
        requestedFileIds.push(input.where.id.in);
        return [{
          id: oldFileId,
          status: 'retained',
          deletedAt: null,
          visibility: 'public',
          linkedResourceType: null,
          linkedResourceId: null,
        }, {
          id: replacementId,
          status: 'active',
          deletedAt: null,
          visibility: 'public',
          linkedResourceType: null,
          linkedResourceId: null,
        }];
      },
    },
    serverWikiReleaseItem: { async findMany() { return [{ pageId: 1n }]; } },
  };
  const service = new WikiReadService(prisma as never, {} as never);
  const ast = parseMarkup('[[파일:logo.png]]').ast;
  const files = await (service as unknown as {
    findRenderableFiles(
      ast: typeof ast,
      access: { accountId: null },
      releaseId: bigint,
    ): Promise<Record<string, { url: string; sourceText: string | null }>>;
  }).findRenderableFiles(ast, { accountId: null }, 70n);

  assert.deepEqual(requestedFileIds, [[oldFileId]]);
  assert.equal(files['logo.png']?.url, `/uploads/${oldFileId}`);
  assert.equal(files['logo.png']?.sourceText, 'old attribution');
});

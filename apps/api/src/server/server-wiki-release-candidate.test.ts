import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServerWikiReleaseCandidate } from './server-wiki-release-candidate';

const now = new Date('2026-07-22T00:00:00.000Z');
const sourcePage = {
  id: 1n,
  namespaceId: 3,
  spaceId: 10n,
  localPath: 'luna/대문',
  slug: 'luna/대문',
  title: 'luna/대문',
  displayTitle: '대문',
  currentRevisionId: 11n,
  pageType: 'article',
  protectionLevel: 'open',
  status: 'normal',
  createdBy: 1n,
  ownerProfileId: null,
  updatedAt: now,
};

test('candidate token pins external include revisions and immutable file versions', async () => {
  let targetRevisionId = 21n;
  let targetContent = '공용 틀 첫 버전';
  let fileId = '11111111-1111-4111-8111-111111111111';
  let fileVersionId = 31n;
  let categoryLabel: string | null = null;
  let categoryBlurred = false;
  const store = {
    async $queryRaw() { return []; },
    wikiPage: {
      async findMany() { return [sourcePage]; },
      async findUnique() {
        return {
          id: 2n,
          namespaceId: 2,
          spaceId: 2n,
          localPath: '공용',
          slug: '공용',
          title: '공용',
          displayTitle: '공용',
          currentRevisionId: targetRevisionId,
          pageType: 'article',
          protectionLevel: 'open',
          status: 'normal',
          createdBy: 2n,
          ownerProfileId: null,
          updatedAt: now,
        };
      },
    },
    wikiPageRevision: {
      async findMany() {
        return [{
          id: 11n,
          pageId: 1n,
          contentRaw: '[include(틀:공용)]\n[[파일:logo.png]]',
          contentHash: '1'.repeat(64),
          contentSize: 44,
          visibility: 'public',
        }];
      },
      async findFirst() {
        return {
          id: targetRevisionId,
          pageId: 2n,
          contentRaw: targetContent,
          contentHash: targetRevisionId === 21n ? '2'.repeat(64) : '3'.repeat(64),
          contentSize: Buffer.byteLength(targetContent, 'utf8'),
          visibility: 'public',
        };
      },
    },
    wikiPageLink: {
      async findMany() {
        return [
          { sourcePageId: 1n, sourceRevisionId: 11n, targetNamespaceCode: 'template', targetSlug: '공용', linkType: 'include', categoryLabel: null, categoryBlurred: false },
          { sourcePageId: 1n, sourceRevisionId: 11n, targetNamespaceCode: 'file', targetSlug: 'logo.png', linkType: 'file', categoryLabel: null, categoryBlurred: false },
          { sourcePageId: 1n, sourceRevisionId: 11n, targetNamespaceCode: 'category', targetSlug: '추천', linkType: 'category', categoryLabel, categoryBlurred },
        ];
      },
    },
    wikiNamespace: {
      async findMany() { return [{ id: 2, code: 'template' }]; },
    },
    uploadedFile: {
      async findMany() {
        return [{
          id: fileId,
          ownerAccountId: null,
          filename: `${fileId}.png`,
          wikiFilename: 'logo.png',
          currentWikiFilename: 'logo.png',
          originalName: 'logo.png',
          mimeType: 'image/png',
          sizeBytes: 128,
          width: 16,
          height: 16,
          sha256: fileId.startsWith('1') ? '4'.repeat(64) : '5'.repeat(64),
          storagePath: `/uploads/${fileId}.png`,
          publicPath: `/uploads/${fileId}`,
          usageContext: 'wiki_editor',
          visibility: 'public',
          license: 'CC-BY-4.0',
          sourceUrl: null,
          sourceText: null,
          linkedResourceType: null,
          linkedResourceId: null,
          status: 'active',
          deletedAt: null,
          retainedUntil: null,
          createdAt: now,
          updatedAt: now,
        }];
      },
    },
    wikiFileVersion: {
      async findMany() { return [{ id: fileVersionId, uploadedFileId: fileId }]; },
    },
  };
  const input = {
    serverWikiId: 50n,
    spaceId: 10n,
    siteSlug: 'luna',
    contentSlug: 'luna',
    publishedRelease: null,
    presentation: {
      layoutKey: 'docs',
      navigationOrder: null,
      contributionPolicySource: null,
      editHelpSource: null,
      topNoticeSource: null,
      bottomNoticeSource: null,
      seoTitle: null,
      seoDescription: null,
      seoIndexingEnabled: true,
      requireContributionPolicyAck: false,
      contributionPolicyVersion: 0,
      contentSettingsVersion: 0,
      navigationVersion: 0,
    },
    async resolvePublicReadAllowed() { return true; },
  };

  const first = await buildServerWikiReleaseCandidate(store as never, input, false);
  targetRevisionId = 22n;
  targetContent = '공용 틀 두 번째 버전';
  const includeChanged = await buildServerWikiReleaseCandidate(store as never, input, false);
  fileId = '22222222-2222-4222-8222-222222222222';
  fileVersionId = 32n;
  const fileChanged = await buildServerWikiReleaseCandidate(store as never, input, false);
  categoryLabel = '추천 문서';
  const categoryLabelChanged = await buildServerWikiReleaseCandidate(store as never, input, false);
  categoryBlurred = true;
  const categoryBlurChanged = await buildServerWikiReleaseCandidate(store as never, input, false);

  assert.equal(first.snapshotVersion, 3);
  assert.equal(first.includeDependencies[0]?.targetRevisionId, 21n);
  assert.equal(first.assets[0]?.uploadedFileId, '11111111-1111-4111-8111-111111111111');
  assert.notEqual(first.candidate.token, includeChanged.candidate.token);
  assert.notEqual(includeChanged.candidate.token, fileChanged.candidate.token);
  assert.notEqual(fileChanged.candidate.token, categoryLabelChanged.candidate.token);
  assert.notEqual(categoryLabelChanged.candidate.token, categoryBlurChanged.candidate.token);
  assert.equal(categoryBlurChanged.links.find((link) => link.linkType === 'category')?.categoryLabel, '추천 문서');
  assert.equal(categoryBlurChanged.links.find((link) => link.linkType === 'category')?.categoryBlurred, true);
});

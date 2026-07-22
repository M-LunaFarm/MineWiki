import assert from 'node:assert/strict';
import test from 'node:test';
import { loadStoredServerWikiReleaseCandidate } from './server-wiki-release-candidate-store';

const token = 'a'.repeat(64);
const presentation = {
  layoutKey: 'docs',
  navigationOrder: null,
  contributionPolicySource: null,
  editHelpSource: null,
  topNoticeSource: null,
  bottomNoticeSource: null,
  seoTitle: null,
  seoDescription: null,
  seoIndexingEnabled: true,
  brandName: null,
  brandLogoUrl: null,
  brandFaviconUrl: null,
  brandAccentColor: null,
  requireContributionPolicyAck: false,
  contributionPolicyVersion: 0,
  contentSettingsVersion: 0,
  navigationVersion: 0,
};

function candidateRecord(snapshotVersion: number, link: Record<string, unknown>, databaseVersion = snapshotVersion) {
  return {
    id: 7n,
    serverWikiId: 5n,
    spaceId: 10n,
    token,
    status: 'pending_review',
    sourcePublicationVersion: 1,
    requiredApprovals: 0,
    submissionReason: 'release candidate test',
    submittedAt: new Date('2026-07-22T00:00:00.000Z'),
    createdBy: 1n,
    siteSlug: 'luna',
    contentSlug: 'luna',
    manifestSnapshot: { token, pages: [] },
    snapshotVersion: databaseVersion,
    releaseSnapshot: {
      snapshotVersion,
      presentation,
      pages: [{
        id: '1', namespaceId: 7, spaceId: '10', localPath: 'luna/대문', slug: 'luna/대문',
        title: '대문', displayTitle: '대문', currentRevisionId: '11', pageType: 'article',
        protectionLevel: 'open', status: 'normal', createdBy: '1', ownerProfileId: null,
        updatedAt: '2026-07-22T00:00:00.000Z', revisionContent: '본문', publicReadAllowed: true,
      }],
      links: [{
        sourcePageId: '1', sourceRevisionId: '11', targetNamespaceCode: 'category',
        targetSlug: '추천', linkType: 'category', ...link,
      }],
      includeDependencies: [],
      assets: [],
    },
    changeRequest: null,
  };
}

async function load(record: ReturnType<typeof candidateRecord>) {
  return loadStoredServerWikiReleaseCandidate({
    serverWikiReleaseCandidate: { async findFirst() { return record; } },
  } as never, { id: 7n, serverWikiId: 5n, spaceId: 10n, token, lock: false });
}

test('candidate store restores legacy v2 category links with safe metadata defaults', async () => {
  const restored = await load(candidateRecord(2, {}));
  assert.equal(restored.snapshot.snapshotVersion, 2);
  assert.equal(restored.snapshot.links[0]?.categoryLabel, null);
  assert.equal(restored.snapshot.links[0]?.categoryBlurred, false);
});

test('candidate store round-trips v3 category metadata and rejects corrupt version contracts', async () => {
  const restored = await load(candidateRecord(3, { categoryLabel: '추천 문서', categoryBlurred: true }));
  assert.equal(restored.snapshot.snapshotVersion, 3);
  assert.equal(restored.snapshot.links[0]?.categoryLabel, '추천 문서');
  assert.equal(restored.snapshot.links[0]?.categoryBlurred, true);

  await assert.rejects(() => load(candidateRecord(3, {})), /stored server wiki release candidate is inconsistent/iu);
  await assert.rejects(() => load(candidateRecord(3, { categoryLabel: null, categoryBlurred: false }, 2)), /stored server wiki release candidate is inconsistent/iu);
});

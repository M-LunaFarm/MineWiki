import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertServerGitBookLinkage,
  computeServerGitBookSnapshotDigest,
  parseServerGitBookImportArgs,
  validateServerGitBookSnapshot,
} from './server-gitbook-import-contract.mjs';

function snapshot(overrides = {}) {
  const base = {
    serverId: '11111111-1111-4111-8111-111111111111',
    expectedWikiSpaceId: '42',
    expectedWikiSlug: 'server-11111111',
    sourceUrl: 'https://github.com/example/server-wiki',
    sourceRevision: 'abcdef123456',
    siteName: 'Example Server',
    host: 'play.example.com',
    pages: [{ sourcePath: 'README.md', title: '시작', content: '# 시작' }],
    ...overrides,
  };
  return base;
}

test('GitBook import is plan-only by default and prune requires explicit apply', () => {
  assert.deepEqual(parseServerGitBookImportArgs(['snapshot.json']), {
    snapshotPath: 'snapshot.json',
    apply: false,
    prune: false,
    printDigest: false,
  });
  assert.throws(() => parseServerGitBookImportArgs(['snapshot.json', '--prune']), /--apply/u);
});

test('applying requires a digest over tenant identity and page payload', () => {
  const input = snapshot();
  input.snapshotDigest = computeServerGitBookSnapshotDigest(input);
  assert.doesNotThrow(() => validateServerGitBookSnapshot(input, { requireDigest: true }));
  input.pages[0].content = '# tampered';
  assert.throws(
    () => validateServerGitBookSnapshot(input, { requireDigest: true }),
    /does not match/u,
  );
});

test('snapshot requires an HTTPS provenance URL and a root page', () => {
  assert.throws(
    () => validateServerGitBookSnapshot(snapshot({ sourceUrl: 'http://example.com/wiki' })),
    /https/u,
  );
  assert.throws(
    () =>
      validateServerGitBookSnapshot(
        snapshot({ pages: [{ sourcePath: 'guide.md', title: 'Guide', content: 'Guide' }] }),
      ),
    /README\.md/u,
  );
});

test('linkage validation rejects cross-tenant server wiki metadata', () => {
  const input = snapshot();
  const linked = {
    snapshot: input,
    server: {
      id: input.serverId,
      wikiSpaceId: 42n,
      wikiPageId: 7n,
      wikiSlug: input.expectedWikiSlug,
      name: 'Example Server',
      joinHost: 'play.example.com',
    },
    serverWiki: {
      spaceId: 42n,
      voteServerId: input.serverId,
      slug: input.expectedWikiSlug,
      serverName: 'Another Tenant',
      host: 'other.example.com',
    },
    space: {
      id: 42n,
      rootPageId: 7n,
      spaceType: 'server_wiki',
      status: 'active',
      rootNamespaceCode: 'server',
    },
    rootPage: { id: 7n, spaceId: 42n },
  };

  assert.throws(() => assertServerGitBookLinkage(linked), /canonical Server/u);
});

test('linkage validation accepts a reciprocal active server wiki', () => {
  const input = snapshot();
  assert.doesNotThrow(() =>
    assertServerGitBookLinkage({
      snapshot: input,
      server: {
        id: input.serverId,
        wikiSpaceId: 42n,
        wikiPageId: 7n,
        wikiSlug: input.expectedWikiSlug,
        name: input.siteName,
        joinHost: input.host,
      },
      serverWiki: {
        spaceId: 42n,
        voteServerId: input.serverId,
        slug: input.expectedWikiSlug,
        serverName: input.siteName,
        host: input.host,
      },
      space: {
        id: 42n,
        rootPageId: 7n,
        spaceType: 'server_wiki',
        status: 'active',
        rootNamespaceCode: 'server',
      },
      rootPage: { id: 7n, spaceId: 42n },
    }),
  );
});

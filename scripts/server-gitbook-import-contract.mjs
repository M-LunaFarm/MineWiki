import { createHash } from 'node:crypto';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function parseServerGitBookImportArgs(argv) {
  const options = {
    snapshotPath: null,
    apply: false,
    prune: false,
    printDigest: false,
  };
  for (const argument of argv) {
    if (argument === '--apply') options.apply = true;
    else if (argument === '--prune') options.prune = true;
    else if (argument === '--print-digest') options.printDigest = true;
    else if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`);
    else if (options.snapshotPath) throw new Error('Only one snapshot path may be provided.');
    else options.snapshotPath = argument;
  }
  if (!options.snapshotPath) {
    throw new Error(
      'Usage: node scripts/import-server-gitbook-snapshot.mjs <snapshot.json> [--print-digest | --apply [--prune]]',
    );
  }
  if (options.prune && !options.apply) {
    throw new Error('--prune is only valid together with --apply.');
  }
  return options;
}

export function computeServerGitBookSnapshotDigest(snapshot) {
  const payload = {
    serverId: snapshot.serverId,
    expectedWikiSpaceId: String(snapshot.expectedWikiSpaceId ?? ''),
    expectedWikiSlug: snapshot.expectedWikiSlug,
    sourceUrl: snapshot.sourceUrl,
    sourceRevision: snapshot.sourceRevision,
    siteName: snapshot.siteName ?? null,
    host: snapshot.host ?? null,
    description: snapshot.description ?? null,
    pages: snapshot.pages,
  };
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

export function validateServerGitBookSnapshot(snapshot, { requireDigest = false } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Snapshot must be a JSON object.');
  }
  requireNonEmptyString(snapshot.serverId, 'serverId');
  requireNonEmptyString(String(snapshot.expectedWikiSpaceId ?? ''), 'expectedWikiSpaceId');
  if (!/^\d+$/u.test(String(snapshot.expectedWikiSpaceId))) {
    throw new Error('expectedWikiSpaceId must be an unsigned integer string.');
  }
  requireNonEmptyString(snapshot.expectedWikiSlug, 'expectedWikiSlug');
  requireNonEmptyString(snapshot.sourceRevision, 'sourceRevision');
  requireNonEmptyString(snapshot.sourceUrl, 'sourceUrl');
  const sourceUrl = new URL(snapshot.sourceUrl);
  if (sourceUrl.protocol !== 'https:') {
    throw new Error('sourceUrl must use https.');
  }
  if (!Array.isArray(snapshot.pages) || snapshot.pages.length === 0) {
    throw new Error('pages must contain at least one page.');
  }
  const sourcePaths = new Set();
  for (const [index, page] of snapshot.pages.entries()) {
    requireNonEmptyString(page?.sourcePath, `pages[${index}].sourcePath`);
    requireNonEmptyString(page?.title, `pages[${index}].title`);
    if (typeof page?.content !== 'string') {
      throw new Error(`pages[${index}].content must be a string.`);
    }
    if (sourcePaths.has(page.sourcePath)) {
      throw new Error(`Duplicate sourcePath: ${page.sourcePath}`);
    }
    sourcePaths.add(page.sourcePath);
  }
  if (!sourcePaths.has('README.md')) {
    throw new Error('Snapshot must contain README.md as the server wiki root.');
  }
  const computedDigest = computeServerGitBookSnapshotDigest(snapshot);
  if (requireDigest) {
    if (!SHA256_PATTERN.test(snapshot.snapshotDigest ?? '')) {
      throw new Error('snapshotDigest must be a lowercase SHA-256 digest when applying.');
    }
    if (snapshot.snapshotDigest !== computedDigest) {
      throw new Error('snapshotDigest does not match the snapshot payload.');
    }
  }
  return { computedDigest };
}

export function assertServerGitBookLinkage({ snapshot, server, serverWiki, space, rootPage }) {
  if (!server || !serverWiki || !space) {
    throw new Error('Linked server wiki records are incomplete.');
  }
  const expectedSpaceId = String(snapshot.expectedWikiSpaceId);
  const actualSpaceIds = [server.wikiSpaceId, serverWiki.spaceId, space.id].map((value) =>
    value === null || value === undefined ? null : String(value),
  );
  if (actualSpaceIds.some((value) => value !== expectedSpaceId)) {
    throw new Error('Server wiki space linkage does not match expectedWikiSpaceId.');
  }
  if (
    server.wikiSlug !== snapshot.expectedWikiSlug ||
    serverWiki.slug !== snapshot.expectedWikiSlug
  ) {
    throw new Error('Server wiki slug linkage does not match expectedWikiSlug.');
  }
  if (serverWiki.voteServerId !== server.id || server.id !== snapshot.serverId) {
    throw new Error('Server and ServerWiki reciprocal identity does not match serverId.');
  }
  if (
    space.spaceType !== 'server_wiki' ||
    space.status !== 'active' ||
    space.rootNamespaceCode !== 'server'
  ) {
    throw new Error('Linked WikiSpace is not an active server space.');
  }
  if (
    !rootPage ||
    String(rootPage.id) !== String(space.rootPageId) ||
    String(rootPage.id) !== String(server.wikiPageId) ||
    String(rootPage.spaceId) !== expectedSpaceId
  ) {
    throw new Error('Server wiki root page linkage is inconsistent.');
  }
  if (serverWiki.serverName !== server.name || normalizeHost(serverWiki.host) !== normalizeHost(server.joinHost)) {
    throw new Error('ServerWiki name or host does not match the canonical Server record.');
  }
  if (snapshot.siteName && snapshot.siteName.trim() !== server.name) {
    throw new Error('Snapshot siteName does not match the canonical Server name.');
  }
  if (snapshot.host && normalizeHost(snapshot.host) !== normalizeHost(server.joinHost)) {
    throw new Error('Snapshot host does not match the canonical Server host.');
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function normalizeHost(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.$/u, '');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

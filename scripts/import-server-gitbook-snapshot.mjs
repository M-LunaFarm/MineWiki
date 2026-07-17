#!/usr/bin/env node

import './load-environment.mjs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { buildWikiSearchVector, parseMarkup } = require('../packages/wiki-core/dist/index.js');

const snapshotPath = process.argv[2];
if (!snapshotPath) {
  throw new Error('Usage: node scripts/import-server-gitbook-snapshot.mjs <snapshot.json>');
}

const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
if (!snapshot.serverId || !snapshot.sourceRevision || !Array.isArray(snapshot.pages)) {
  throw new Error('Snapshot requires serverId, sourceRevision, and pages.');
}

const prisma = new PrismaClient();
try {
  const server = await prisma.server.findUnique({ where: { id: snapshot.serverId } });
  if (!server?.wikiSpaceId || !server.wikiSlug) {
    throw new Error(`Server ${snapshot.serverId} has no linked server wiki.`);
  }
  const serverWiki = await prisma.serverWiki.findUnique({ where: { spaceId: server.wikiSpaceId } });
  const namespace = await prisma.wikiNamespace.findUnique({ where: { code: 'server' } });
  if (!serverWiki || !namespace) throw new Error('Linked server wiki records are incomplete.');

  const slug = serverWiki.slug;
  const now = new Date();
  const prepared = snapshot.pages.map((page) => ({
    ...page,
    localPath: sourcePathToLocalPath(slug, page.sourcePath),
    content: normalizeGitBookSource(page.content, page.sourcePath, snapshot.pages, slug),
  }));
  const importedPaths = new Set(prepared.map((page) => page.localPath));

  await prisma.$transaction(async (tx) => {
    await tx.serverWiki.update({
      where: { id: serverWiki.id },
      data: {
        serverName: snapshot.siteName ?? serverWiki.serverName,
        host: snapshot.host ?? serverWiki.host,
        supportedVersions: snapshot.supportedVersions ?? serverWiki.supportedVersions,
        layoutKey: 'docs',
        layoutUpdatedAt: now,
        updatedAt: now,
      },
    });
    await tx.wikiSpace.update({
      where: { id: serverWiki.spaceId },
      data: {
        name: `${snapshot.siteName ?? serverWiki.serverName} 문서`,
        title: `${snapshot.siteName ?? serverWiki.serverName} 문서`,
        description: snapshot.description ?? null,
        updatedAt: now,
      },
    });

    const existingPages = await tx.wikiPage.findMany({ where: { spaceId: serverWiki.spaceId } });
    for (const existing of existingPages) {
      if (!importedPaths.has(existing.localPath)) {
        await tx.wikiPage.update({ where: { id: existing.id }, data: { status: 'deleted', updatedAt: now } });
      }
    }

    for (const pageInput of prepared) {
      const contentAst = parseMarkup(pageInput.content).ast;
      const contentSize = Buffer.byteLength(pageInput.content, 'utf8');
      let page = await tx.wikiPage.findUnique({
        where: { spaceId_localPath: { spaceId: serverWiki.spaceId, localPath: pageInput.localPath } },
      });
      if (!page) {
        page = await tx.wikiPage.create({
          data: {
            namespaceId: namespace.id,
            spaceId: serverWiki.spaceId,
            localPath: pageInput.localPath,
            slug: pageInput.localPath,
            title: pageInput.localPath,
            displayTitle: pageInput.title,
            pageType: 'server',
            protectionLevel: 'open',
            status: 'normal',
            currentContentSize: contentSize,
            createdBy: serverWiki.createdBy,
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      const currentRevision = page.currentRevisionId
        ? await tx.wikiPageRevision.findUnique({ where: { id: page.currentRevisionId } })
        : null;
      const revision = await tx.wikiPageRevision.create({
        data: {
          pageId: page.id,
          revisionNo: (currentRevision?.revisionNo ?? 0) + 1,
          parentRevisionId: currentRevision?.id ?? null,
          contentRaw: pageInput.content,
          contentAst,
          contentHash: createHash('sha256').update(pageInput.content).digest('hex'),
          contentSize,
          syntaxVersion: 'bwm-0.3',
          editSummary: `GitBook 동기화 (${snapshot.sourceRevision.slice(0, 12)})`,
          isMinor: false,
          createdBy: serverWiki.createdBy,
          actorType: 'system',
          actorUserId: serverWiki.createdBy,
          createdAt: now,
          visibility: 'public',
        },
      });
      await tx.wikiPage.update({
        where: { id: page.id },
        data: {
          displayTitle: pageInput.title,
          currentRevisionId: revision.id,
          currentContentSize: contentSize,
          status: 'normal',
          updatedAt: now,
        },
      });
      await tx.wikiSearchDocument.upsert({
        where: { pageId: page.id },
        create: {
          pageId: page.id,
          revisionId: revision.id,
          searchVector: buildWikiSearchVector([
            pageInput.localPath,
            pageInput.title,
            pageInput.content,
          ]),
          updatedAt: now,
        },
        update: {
          revisionId: revision.id,
          searchVector: buildWikiSearchVector([
            pageInput.localPath,
            pageInput.title,
            pageInput.content,
          ]),
          updatedAt: now,
        },
      });
      await tx.wikiPageRenderCache.deleteMany({ where: { pageId: page.id } });
      await tx.wikiRecentChange.create({
        data: {
          pageId: page.id,
          revisionId: revision.id,
          actorId: serverWiki.createdBy,
          changeType: currentRevision ? 'edit' : 'create',
          title: pageInput.title,
          namespaceCode: 'server',
          summary: `GitBook 동기화 (${snapshot.sourceRevision.slice(0, 12)})`,
          isMinor: false,
          createdAt: now,
        },
      });
      if (pageInput.sourcePath === 'README.md') {
        await tx.wikiSpace.update({ where: { id: serverWiki.spaceId }, data: { rootPageId: page.id } });
        await tx.server.update({ where: { id: server.id }, data: { wikiPageId: page.id } });
      }
    }
  }, { timeout: 120_000 });

  process.stdout.write(`Imported ${prepared.length} GitBook pages into /server/${slug}.\n`);
} finally {
  await prisma.$disconnect();
}

function sourcePathToLocalPath(slug, sourcePath) {
  if (sourcePath === 'README.md') return slug;
  const withoutExtension = sourcePath.replace(/\.md$/u, '');
  const relative = withoutExtension.endsWith('/README')
    ? withoutExtension.slice(0, -'/README'.length)
    : withoutExtension;
  return `${slug}/${relative}`;
}

function normalizeGitBookSource(source, sourcePath, pages, slug) {
  const pagePaths = new Set(pages.map((page) => page.sourcePath));
  let content = String(source ?? '').replace(/^---\n[\s\S]*?\n---\n/u, '');
  content = content
    .replace(/\{%\s*hint[^%]*%\}/gu, '> **안내**  ')
    .replace(/\{%\s*endhint\s*%\}/gu, '')
    .replace(/\{%\s*tabs\s*%\}|\{%\s*endtabs\s*%\}/gu, '')
    .replace(/\{%\s*tab\s+title="([^"]+)"\s*%\}/gu, '## $1')
    .replace(/\{%\s*endtab\s*%\}/gu, '')
    .replace(/\{%\s*content-ref[^%]*%\}|\{%\s*endcontent-ref\s*%\}/gu, '')
    .replace(/<figure[^>]*>[\s\S]*?<figcaption>([\s\S]*?)<\/figcaption>[\s\S]*?<\/figure>/giu, (_match, caption) => stripHtml(caption).trim())
    .replace(/<figure[^>]*>[\s\S]*?<\/figure>/giu, '')
    .replace(/!\[[^\]]*\]\([^)]*\.gitbook\/assets[^)]*\)/giu, '')
    .replace(/<img[^>]+\.gitbook\/assets[^>]*>/giu, '');

  const rewrite = (target) => {
    if (/^(?:[a-z]+:|#|\/)/iu.test(target)) return target;
    const [rawPath, anchor = ''] = target.split('#', 2);
    const decoded = decodeURIComponent(rawPath || '');
    const base = path.posix.dirname(sourcePath);
    let resolved = path.posix.normalize(path.posix.join(base, decoded));
    if (resolved.endsWith('/')) resolved += 'README.md';
    if (!resolved.endsWith('.md') && pagePaths.has(`${resolved}.md`)) resolved += '.md';
    if (!pagePaths.has(resolved)) return target;
    const localPath = sourcePathToLocalPath(slug, resolved);
    const route = localPath === slug ? `/server/${encodeURIComponent(slug)}` : `/server/${localPath.split('/').map(encodeURIComponent).join('/')}`;
    return anchor ? `${route}#${encodeURIComponent(anchor)}` : route;
  };
  content = content.replace(/\]\(([^)]+)\)/gu, (_match, target) => `](${rewrite(target)})`);
  content = content.replace(/href="([^"]+)"/gu, (_match, target) => `href="${rewrite(target)}"`);
  return content.trim() || `# ${sourcePath}`;
}

function stripHtml(value) {
  return String(value).replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ');
}

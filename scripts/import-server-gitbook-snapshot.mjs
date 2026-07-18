#!/usr/bin/env node

import './load-environment.mjs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertServerGitBookLinkage,
  parseServerGitBookImportArgs,
  validateServerGitBookSnapshot,
} from './server-gitbook-import-contract.mjs';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { buildWikiSearchVector, parseMarkup } = require('../packages/wiki-core/dist/index.js');

const args = parseServerGitBookImportArgs(process.argv.slice(2));
const snapshot = JSON.parse(await readFile(args.snapshotPath, 'utf8'));
const { computedDigest } = validateServerGitBookSnapshot(snapshot, { requireDigest: args.apply });
if (args.printDigest) {
  process.stdout.write(`${computedDigest}\n`);
  process.exit(0);
}

const prisma = new PrismaClient();
try {
  const context = await loadLinkedContext(prisma, snapshot);
  assertServerGitBookLinkage({ snapshot, ...context });

  const slug = context.serverWiki.slug;
  const now = new Date();
  const prepared = snapshot.pages.map((page) => ({
    ...page,
    localPath: sourcePathToLocalPath(slug, page.sourcePath),
    content: normalizeGitBookSource(page.content, page.sourcePath, snapshot.pages, slug),
  }));
  const importedPaths = new Set(prepared.map((page) => page.localPath));
  const existingPages = await prisma.wikiPage.findMany({
    where: { spaceId: context.serverWiki.spaceId },
    select: { id: true, localPath: true },
  });
  const existingPaths = new Set(existingPages.map((page) => page.localPath));
  const plan = {
    mode: args.apply ? 'apply' : 'plan',
    serverId: context.server.id,
    wikiSpaceId: String(context.serverWiki.spaceId),
    wikiSlug: context.serverWiki.slug,
    sourceUrl: snapshot.sourceUrl,
    sourceRevision: snapshot.sourceRevision,
    snapshotDigest: computedDigest,
    create: prepared.filter((page) => !existingPaths.has(page.localPath)).map((page) => page.localPath),
    update: prepared.filter((page) => existingPaths.has(page.localPath)).map((page) => page.localPath),
    prune: args.prune
      ? existingPages.filter((page) => !importedPaths.has(page.localPath)).map((page) => page.localPath)
      : [],
  };
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  if (!args.apply) {
    process.stdout.write('Plan only. Add snapshotDigest to the snapshot and pass --apply to write.\n');
  }

  if (args.apply) {
    await prisma.$transaction(async (tx) => {
    await lockLinkedContext(tx, context);
    const lockedContext = await loadLinkedContext(tx, snapshot);
    assertServerGitBookLinkage({ snapshot, ...lockedContext });
    const { server, serverWiki, namespace } = lockedContext;
    await tx.serverWiki.update({
      where: { id: serverWiki.id },
      data: {
        serverName: server.name,
        host: server.joinHost,
        layoutKey: 'docs',
        layoutUpdatedAt: now,
        updatedAt: now,
      },
    });
    await tx.wikiSpace.update({
      where: { id: serverWiki.spaceId },
      data: {
        name: `${server.name} 문서`,
        title: `${server.name} 문서`,
        description: snapshot.description ?? null,
        updatedAt: now,
      },
    });

    if (args.prune) {
      const pagesToCheck = await tx.wikiPage.findMany({ where: { spaceId: serverWiki.spaceId } });
      for (const existing of pagesToCheck) {
        if (!importedPaths.has(existing.localPath)) {
          await tx.wikiPage.update({
            where: { id: existing.id },
            data: { status: 'deleted', updatedAt: now },
          });
        }
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
          previousPublicRevisionId: currentRevision?.id ?? null,
          actorId: serverWiki.createdBy,
          spaceId: page.spaceId,
          changeType: currentRevision ? 'edit' : 'create',
          title: pageInput.title,
          localPath: page.localPath,
          namespaceCode: 'server',
          summary: `GitBook 동기화 (${snapshot.sourceRevision.slice(0, 12)})`,
          sizeDelta: revision.contentSize - (currentRevision?.contentSize ?? 0),
          eventAudience: 'restricted',
          isMinor: false,
          createdAt: now,
        },
      });
      if (pageInput.sourcePath === 'README.md') {
        await tx.wikiSpace.update({ where: { id: serverWiki.spaceId }, data: { rootPageId: page.id } });
        await tx.server.update({ where: { id: server.id }, data: { wikiPageId: page.id } });
      }
    }
    await tx.auditEvent.create({
      data: {
        category: 'wiki',
        action: 'server_gitbook_import',
        severity: 'info',
        actorProfileId: serverWiki.createdBy,
        subjectType: 'server_wiki',
        subjectId: String(serverWiki.id),
        metadata: {
          serverId: server.id,
          wikiSpaceId: String(serverWiki.spaceId),
          wikiSlug: serverWiki.slug,
          sourceUrl: snapshot.sourceUrl,
          sourceRevision: snapshot.sourceRevision,
          snapshotDigest: computedDigest,
          pages: prepared.length,
          pruned: plan.prune.length,
        },
        createdAt: now,
      },
    });
    }, { timeout: 120_000 });

    process.stdout.write(`Imported ${prepared.length} GitBook pages into /server/${slug}.\n`);
  }
} finally {
  await prisma.$disconnect();
}

async function loadLinkedContext(client, snapshotInput) {
  const server = await client.server.findUnique({ where: { id: snapshotInput.serverId } });
  if (!server?.wikiSpaceId || !server.wikiSlug || !server.wikiPageId) {
    throw new Error(`Server ${snapshotInput.serverId} has no complete linked server wiki.`);
  }
  const [serverWiki, space, rootPage, namespace] = await Promise.all([
    client.serverWiki.findUnique({ where: { spaceId: server.wikiSpaceId } }),
    client.wikiSpace.findUnique({ where: { id: server.wikiSpaceId } }),
    client.wikiPage.findUnique({ where: { id: server.wikiPageId } }),
    client.wikiNamespace.findUnique({ where: { code: 'server' } }),
  ]);
  if (!serverWiki || !space || !rootPage || !namespace) {
    throw new Error('Linked server wiki records are incomplete.');
  }
  return { server, serverWiki, space, rootPage, namespace };
}

async function lockLinkedContext(tx, context) {
  await tx.$queryRawUnsafe('SELECT id FROM Server WHERE id = ? FOR UPDATE', context.server.id);
  await tx.$queryRawUnsafe(
    'SELECT id FROM server_wikis WHERE id = ? FOR UPDATE',
    context.serverWiki.id,
  );
  await tx.$queryRawUnsafe(
    'SELECT id FROM wiki_spaces WHERE id = ? FOR UPDATE',
    context.serverWiki.spaceId,
  );
  await tx.$queryRawUnsafe('SELECT id FROM pages WHERE id = ? FOR UPDATE', context.rootPage.id);
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

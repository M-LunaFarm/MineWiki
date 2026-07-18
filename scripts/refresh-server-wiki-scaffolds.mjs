#!/usr/bin/env node

import './load-environment.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { parseMarkup, hashContent } = require('../packages/wiki-core/dist/index.js');
const {
  buildServerWikiMainPage,
  buildServerWikiStarterPages,
} = require('../apps/api/dist/apps/api/src/server/server-wiki-scaffold.js');
const {
  WikiLinkIndexService,
} = require('../apps/api/dist/apps/api/src/wiki/wiki-link-index.service.js');

const prisma = new PrismaClient();
const wikiLinks = new WikiLinkIndexService();
let refreshedPages = 0;
let skippedPages = 0;

try {
  const servers = await prisma.server.findMany({
    where: { wikiSpaceId: { not: null }, wikiSlug: { not: null } },
  });
  for (const server of servers) {
    const serverWiki = await prisma.serverWiki.findUnique({
      where: { voteServerId: server.id },
    });
    if (!serverWiki || !isCanonicalLink(server, serverWiki)) {
      skippedPages += 1;
      continue;
    }
    const pages = await loadRefreshCandidates(prisma, server, serverWiki);
    if (pages.length === 0) continue;

    const refreshed = await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT id FROM Server WHERE id = ? FOR UPDATE', server.id);
      await tx.$queryRawUnsafe(
        'SELECT id FROM server_wikis WHERE id = ? FOR UPDATE',
        serverWiki.id,
      );
      const updatedPageIds = [];
      for (const candidate of pages) {
        await tx.$queryRawUnsafe('SELECT id FROM pages WHERE id = ? FOR UPDATE', candidate.page.id);
        const page = await tx.wikiPage.findUnique({ where: { id: candidate.page.id } });
        if (!page?.currentRevisionId || page.currentRevisionId !== candidate.revision.id) {
          skippedPages += 1;
          continue;
        }
        const currentRevision = await tx.wikiPageRevision.findUnique({
          where: { id: page.currentRevisionId },
        });
        if (!currentRevision || !isPristineScaffoldRevision(currentRevision, candidate.summary)) {
          skippedPages += 1;
          continue;
        }
        const parsed = parseMarkup(candidate.contentRaw);
        const contentSize = Buffer.byteLength(candidate.contentRaw, 'utf8');
        const revision = await tx.wikiPageRevision.create({
          data: {
            pageId: page.id,
            revisionNo: currentRevision.revisionNo + 1,
            parentRevisionId: currentRevision.id,
            contentRaw: candidate.contentRaw,
            contentAst: parsed.ast,
            contentHash: hashContent(candidate.contentRaw),
            contentSize,
            syntaxVersion: 'bwm-0.3',
            editSummary: '서버 위키 기본 문서 확장',
            isMinor: false,
            createdBy: serverWiki.createdBy,
            actorType: 'system',
            actorUserId: serverWiki.createdBy,
            createdAt: new Date(),
            visibility: 'public',
          },
        });
        await tx.wikiPage.update({
          where: { id: page.id },
          data: {
            currentRevisionId: revision.id,
            currentContentSize: contentSize,
            updatedAt: revision.createdAt,
          },
        });
        await wikiLinks.replaceForRevision(
          tx,
          page.id,
          revision.id,
          parsed.links,
          parsed.categories,
          parsed.includes,
          {
            contentSize,
            contentRaw: candidate.contentRaw,
            fileNames: [],
            redirectTarget: parsed.redirectTarget,
          },
        );
        await tx.wikiPageRenderCache.deleteMany({ where: { pageId: page.id } });
        await tx.wikiRecentChange.create({
          data: {
            pageId: page.id,
            revisionId: revision.id,
            previousPublicRevisionId: currentRevision.id,
            actorId: serverWiki.createdBy,
            spaceId: page.spaceId,
            changeType: 'edit',
            title: page.title,
            localPath: page.localPath,
            namespaceCode: 'server',
            summary: revision.editSummary,
            sizeDelta: revision.contentSize - currentRevision.contentSize,
            eventAudience: 'restricted',
            isMinor: false,
            createdAt: revision.createdAt,
          },
        });
        updatedPageIds.push(page.id.toString());
      }
      if (updatedPageIds.length > 0) {
        await tx.auditEvent.create({
          data: {
            category: 'wiki',
            action: 'server_wiki_scaffold_refresh',
            severity: 'info',
            actorProfileId: serverWiki.createdBy,
            subjectType: 'server_wiki',
            subjectId: serverWiki.id.toString(),
            metadata: {
              serverId: server.id,
              pageIds: updatedPageIds,
              version: 2,
            },
            createdAt: new Date(),
          },
        });
      }
      return updatedPageIds.length;
    }, { timeout: 60_000 });
    refreshedPages += refreshed;
  }
} finally {
  await prisma.$disconnect();
}

process.stdout.write(`Refreshed ${refreshedPages} pristine server wiki pages; skipped ${skippedPages}.\n`);

async function loadRefreshCandidates(client, server, serverWiki) {
  const starterPages = buildServerWikiStarterPages(server);
  const definitions = [
    {
      localPath: serverWiki.slug,
      contentRaw: buildServerWikiMainPage(server),
      summary: '서버 위키 대문 생성',
    },
    ...starterPages.map((page) => ({
      localPath: `${serverWiki.slug}/${page.path}`,
      contentRaw: page.contentRaw,
      summary: `서버 위키 ${page.title} 생성`,
    })),
  ];
  const pages = await client.wikiPage.findMany({
    where: {
      spaceId: serverWiki.spaceId,
      localPath: { in: definitions.map((definition) => definition.localPath) },
    },
  });
  const pageByPath = new Map(pages.map((page) => [page.localPath, page]));
  const candidates = [];
  for (const definition of definitions) {
    const page = pageByPath.get(definition.localPath);
    if (!page?.currentRevisionId) continue;
    const revision = await client.wikiPageRevision.findUnique({
      where: { id: page.currentRevisionId },
    });
    if (!revision || !isPristineScaffoldRevision(revision, definition.summary)) {
      skippedPages += 1;
      continue;
    }
    candidates.push({ ...definition, page, revision });
  }
  return candidates;
}

function isPristineScaffoldRevision(revision, expectedSummary) {
  return revision.revisionNo === 1
    && revision.parentRevisionId === null
    && revision.visibility === 'public'
    && revision.editSummary === expectedSummary;
}

function isCanonicalLink(server, serverWiki) {
  return server.wikiSpaceId === serverWiki.spaceId
    && server.wikiSlug === serverWiki.slug
    && serverWiki.serverName.trim() === server.name.trim()
    && normalizeHost(serverWiki.host) === normalizeHost(server.joinHost);
}

function normalizeHost(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.+$/u, '');
}

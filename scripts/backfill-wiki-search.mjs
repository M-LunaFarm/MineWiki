#!/usr/bin/env node

import './load-environment.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { buildWikiSearchVector } = require('../packages/wiki-core/dist/index.js');

const prisma = new PrismaClient();
const batchSize = 100;
let cursor;
let indexedPages = 0;

try {
  while (true) {
    const pages = await prisma.wikiPage.findMany({
      where: {
        currentRevisionId: { not: null },
        status: { in: ['normal', 'active', 'published'] }
      },
      select: {
        id: true,
        currentRevisionId: true,
        title: true,
        displayTitle: true,
        slug: true,
        localPath: true
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    if (pages.length === 0) break;
    const revisions = await prisma.wikiPageRevision.findMany({
      where: {
        id: { in: pages.map((page) => page.currentRevisionId) },
        visibility: 'public'
      },
      select: { id: true, contentRaw: true }
    });
    const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
    const documents = pages.flatMap((page) => {
      const revision = revisionById.get(page.currentRevisionId);
      if (!revision) return [];
      return [{
        pageId: page.id,
        revisionId: revision.id,
        searchVector: buildWikiSearchVector([
          page.title,
          page.displayTitle,
          page.slug,
          page.localPath,
          revision.contentRaw
        ]),
        updatedAt: new Date()
      }];
    });
    await prisma.$transaction(async (tx) => {
      await tx.wikiSearchDocument.deleteMany({ where: { pageId: { in: pages.map((page) => page.id) } } });
      if (documents.length > 0) await tx.wikiSearchDocument.createMany({ data: documents });
    });
    indexedPages += documents.length;
    cursor = pages.at(-1).id;
  }
  await prisma.$executeRawUnsafe(`
    DELETE sd
    FROM wiki_search_documents AS sd
    LEFT JOIN pages AS p ON p.id = sd.page_id
    LEFT JOIN page_revisions AS r ON r.id = p.current_revision_id
    WHERE p.id IS NULL
       OR p.current_revision_id IS NULL
       OR r.id IS NULL
       OR p.current_revision_id <> sd.revision_id
       OR p.status NOT IN ('normal', 'active', 'published')
       OR r.visibility <> 'public'
  `);
  process.stdout.write(`Indexed ${indexedPages} current public wiki search documents.\n`);
} finally {
  await prisma.$disconnect();
}

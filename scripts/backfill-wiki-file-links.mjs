#!/usr/bin/env node

import './load-environment.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { collectWikiFileNames, parseMarkup } = require('../packages/wiki-core/dist/index.js');

const prisma = new PrismaClient();
const batchSize = 100;
let cursor;
let indexedPages = 0;
let indexedFiles = 0;

try {
  while (true) {
    const pages = await prisma.wikiPage.findMany({
      where: { currentRevisionId: { not: null }, status: { not: 'deleted' } },
      select: { id: true, currentRevisionId: true },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    if (pages.length === 0) break;
    const revisions = await prisma.wikiPageRevision.findMany({
      where: { id: { in: pages.map((page) => page.currentRevisionId) }, visibility: 'public' },
      select: { id: true, pageId: true, contentRaw: true }
    });
    const revisionByPage = new Map(revisions.map((revision) => [revision.pageId, revision]));
    for (const page of pages) {
      const revision = revisionByPage.get(page.id);
      if (!revision) continue;
      const fileNames = [...collectWikiFileNames(parseMarkup(revision.contentRaw).ast)]
        .filter((fileName) => fileName && fileName.length <= 255 && !/@[A-Za-z0-9가-힣_]+(?:=[^@\n]*)?@/u.test(fileName));
      await prisma.$transaction(async (tx) => {
        await tx.wikiPageLink.deleteMany({ where: { sourcePageId: page.id, linkType: 'file' } });
        if (fileNames.length > 0) {
          await tx.wikiPageLink.createMany({
            data: [...new Set(fileNames)].map((fileName) => ({
              sourcePageId: page.id,
              sourceRevisionId: revision.id,
              targetNamespaceCode: 'file',
              targetSlug: fileName,
              linkType: 'file',
              createdAt: new Date()
            })),
            skipDuplicates: true
          });
        }
      });
      indexedPages += 1;
      indexedFiles += fileNames.length;
    }
    cursor = pages.at(-1).id;
  }
  process.stdout.write(`Indexed ${indexedFiles} file references from ${indexedPages} current wiki pages.\n`);
} finally {
  await prisma.$disconnect();
}

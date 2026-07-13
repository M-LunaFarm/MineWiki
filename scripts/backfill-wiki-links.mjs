#!/usr/bin/env node

import './load-environment.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
// Root scripts are not workspace package consumers, so resolve the artifact that
// the package command builds instead of relying on an app-local pnpm symlink.
const { parseLinkTarget, parseMarkup, slugifyTitle } = require('../packages/wiki-core/dist/index.js');

const prisma = new PrismaClient();
const batchSize = 100;
let cursor;
let indexedPages = 0;
let indexedLinks = 0;
let indexedCategories = 0;

try {
  const namespaces = await prisma.wikiNamespace.findMany({ select: { id: true, code: true } });
  const namespaceById = new Map(namespaces.map((item) => [item.id, item.code]));
  while (true) {
    const pages = await prisma.wikiPage.findMany({
      where: { currentRevisionId: { not: null }, status: { not: 'deleted' } },
      select: {
        id: true,
        namespaceId: true,
        localPath: true,
        currentRevisionId: true
      },
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
      const namespaceCode = namespaceById.get(page.namespaceId);
      if (!revision || !namespaceCode) continue;
      const parsed = parseMarkup(revision.contentRaw);
      const links = normalizeLinks(namespaceCode, page.localPath, parsed.links);
      const categories = normalizeCategories(parsed.categories);
      await prisma.$transaction(async (tx) => {
        await tx.wikiPageLink.deleteMany({ where: { sourcePageId: page.id } });
        if (links.length > 0) {
          await tx.wikiPageLink.createMany({
            data: links.map((link) => ({
              sourcePageId: page.id,
              sourceRevisionId: revision.id,
              targetNamespaceCode: link.targetNamespaceCode,
              targetSlug: link.targetSlug,
              linkType: 'link',
              createdAt: new Date()
            })),
            skipDuplicates: true
          });
        }
        if (categories.length > 0) {
          await tx.wikiPageLink.createMany({
            data: categories.map((category) => ({
              sourcePageId: page.id,
              sourceRevisionId: revision.id,
              targetNamespaceCode: 'category',
              targetSlug: category,
              linkType: 'category',
              createdAt: new Date()
            })),
            skipDuplicates: true
          });
        }
      });
      indexedPages += 1;
      indexedLinks += links.length;
      indexedCategories += categories.length;
    }
    cursor = pages.at(-1).id;
  }
  process.stdout.write(`Indexed ${indexedLinks} links and ${indexedCategories} categories from ${indexedPages} current wiki pages.\n`);
} finally {
  await prisma.$disconnect();
}

function normalizeCategories(categories) {
  return [...new Set(categories.map((category) => slugifyTitle(category)).filter((category) => category && category.length <= 255))];
}

function normalizeLinks(namespaceCode, localPath, targets) {
  const normalized = new Map();
  for (const target of targets) {
    const parsed = parseLinkTarget(target);
    const resolved = namespaceCode === 'server' && parsed.namespace === 'main' && !target.includes(':')
      ? { targetNamespaceCode: 'server', targetSlug: slugifyTitle(`${slugifyTitle(localPath).split('/')[0]}/${parsed.title}`) }
      : { targetNamespaceCode: parsed.namespace, targetSlug: slugifyTitle(parsed.title) };
    if (!resolved.targetSlug || resolved.targetSlug.length > 255 || resolved.targetNamespaceCode.length > 32) continue;
    normalized.set(`${resolved.targetNamespaceCode}:${resolved.targetSlug}`, resolved);
  }
  return [...normalized.values()];
}

import { Injectable } from '@nestjs/common';
import { buildWikiSearchVector, parseLinkTarget, slugifyTitle } from '@minewiki/wiki-core';
import type { PrismaService } from '../common/prisma.service';

type WikiLinkStore = Pick<PrismaService, 'wikiPage' | 'wikiNamespace' | 'wikiPageLink' | 'wikiSearchDocument'>;

@Injectable()
export class WikiLinkIndexService {
  async replaceForRevision(
    store: WikiLinkStore,
    pageId: bigint,
    revisionId: bigint,
    links: readonly string[],
    categories: readonly string[] = [],
    includes: readonly string[] = [],
    metrics?: { readonly contentSize: number; readonly contentRaw?: string }
  ): Promise<void> {
    const page = await store.wikiPage.findUnique({
      where: { id: pageId },
      select: { namespaceId: true, localPath: true, slug: true, title: true, displayTitle: true }
    });
    if (!page) return;
    const namespace = await store.wikiNamespace.findUnique({
      where: { id: page.namespaceId },
      select: { code: true }
    });
    if (!namespace) return;

    const normalized = new Map<string, { targetNamespaceCode: string; targetSlug: string; linkType: string }>();
    for (const target of links) {
      if (containsIncludePlaceholder(target)) continue;
      const resolved = resolveTarget(namespace.code, page.localPath, target);
      if (!resolved.targetSlug || resolved.targetSlug.length > 255 || resolved.targetNamespaceCode.length > 32) {
        continue;
      }
      normalized.set(`link:${resolved.targetNamespaceCode}:${resolved.targetSlug}`, { ...resolved, linkType: 'link' });
    }
    for (const category of categories) {
      if (containsIncludePlaceholder(category)) continue;
      const targetSlug = slugifyTitle(category);
      if (!targetSlug || targetSlug.length > 255) continue;
      normalized.set(`category:category:${targetSlug}`, {
        targetNamespaceCode: 'category',
        targetSlug,
        linkType: 'category'
      });
    }
    for (const include of includes) {
      const resolved = resolveTarget(namespace.code, page.localPath, include);
      if (!resolved.targetSlug || resolved.targetSlug.length > 255 || resolved.targetNamespaceCode.length > 32) {
        continue;
      }
      normalized.set(`include:${resolved.targetNamespaceCode}:${resolved.targetSlug}`, {
        ...resolved,
        linkType: 'include'
      });
    }
    await store.wikiPageLink.deleteMany({ where: { sourcePageId: pageId } });
    if (normalized.size > 0) {
      await store.wikiPageLink.createMany({
        data: [...normalized.values()].map((target) => ({
          sourcePageId: pageId,
          sourceRevisionId: revisionId,
          targetNamespaceCode: target.targetNamespaceCode,
          targetSlug: target.targetSlug,
          linkType: target.linkType,
          createdAt: new Date()
        })),
        skipDuplicates: true
      });
    }
    if (metrics) {
      await store.wikiPage.update({
        where: { id: pageId },
        data: {
          currentContentSize: metrics.contentSize,
          currentCategoryCount: [...normalized.values()].filter((target) => target.linkType === 'category').length
        }
      });
      if (metrics.contentRaw !== undefined) {
        const searchVector = buildWikiSearchVector([
          page.title,
          page.displayTitle,
          page.slug,
          page.localPath,
          metrics.contentRaw
        ]);
        await store.wikiSearchDocument.upsert({
          where: { pageId },
          create: {
            pageId,
            revisionId,
            searchVector,
            updatedAt: new Date()
          },
          update: {
            revisionId,
            searchVector,
            updatedAt: new Date()
          }
        });
      }
    }
  }
}

function containsIncludePlaceholder(value: string) {
  return /@[A-Za-z0-9가-힣_]+(?:=[^@\n]*)?@/u.test(value);
}

function resolveTarget(namespaceCode: string, localPath: string, target: string) {
  const parsed = parseLinkTarget(target);
  if (namespaceCode === 'server' && parsed.namespace === 'main' && !target.includes(':')) {
    const [serverSlug] = slugifyTitle(localPath).split('/');
    return {
      targetNamespaceCode: 'server',
      targetSlug: slugifyTitle(`${serverSlug}/${parsed.title}`)
    };
  }
  return {
    targetNamespaceCode: parsed.namespace,
    targetSlug: slugifyTitle(parsed.title)
  };
}

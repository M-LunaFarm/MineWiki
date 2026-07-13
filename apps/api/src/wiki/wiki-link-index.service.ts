import { Injectable } from '@nestjs/common';
import { parseLinkTarget, slugifyTitle } from '@minewiki/wiki-core';
import type { PrismaService } from '../common/prisma.service';

type WikiLinkStore = Pick<PrismaService, 'wikiPage' | 'wikiNamespace' | 'wikiPageLink'>;

@Injectable()
export class WikiLinkIndexService {
  async replaceForRevision(
    store: WikiLinkStore,
    pageId: bigint,
    revisionId: bigint,
    links: readonly string[]
  ): Promise<void> {
    const page = await store.wikiPage.findUnique({
      where: { id: pageId },
      select: { namespaceId: true, localPath: true }
    });
    if (!page) return;
    const namespace = await store.wikiNamespace.findUnique({
      where: { id: page.namespaceId },
      select: { code: true }
    });
    if (!namespace) return;

    const normalized = new Map<string, { targetNamespaceCode: string; targetSlug: string }>();
    for (const target of links) {
      const resolved = resolveTarget(namespace.code, page.localPath, target);
      if (!resolved.targetSlug || resolved.targetSlug.length > 255 || resolved.targetNamespaceCode.length > 32) {
        continue;
      }
      normalized.set(`${resolved.targetNamespaceCode}:${resolved.targetSlug}`, resolved);
    }
    await store.wikiPageLink.deleteMany({ where: { sourcePageId: pageId } });
    if (normalized.size === 0) return;
    await store.wikiPageLink.createMany({
      data: [...normalized.values()].map((target) => ({
        sourcePageId: pageId,
        sourceRevisionId: revisionId,
        targetNamespaceCode: target.targetNamespaceCode,
        targetSlug: target.targetSlug,
        linkType: 'link',
        createdAt: new Date()
      })),
      skipDuplicates: true
    });
  }
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

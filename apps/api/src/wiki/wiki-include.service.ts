import { Injectable } from '@nestjs/common';
import {
  applyIncludeParametersToAst,
  type AstNode,
  type InlineNode,
  parseLinkTarget,
  parseMarkup,
  slugifyTitle
} from '@minewiki/wiki-core';
import { PrismaService } from '../common/prisma.service';
import {
  WikiPermissionService,
  type WikiPermissionActor,
  type WikiPublishedPageBoundary,
} from './wiki-permission.service';
import { wikiLinkResolutionContext } from './wiki-link-context';

const MAX_INCLUDE_OCCURRENCES = 20;
const MAX_UNIQUE_INCLUDE_TARGETS = 20;
const MAX_INCLUDED_SOURCE_BYTES = 1024 * 1024;

interface IncludeSource {
  readonly pageId: bigint;
  readonly ast: AstNode[];
  readonly bytes: number;
}

export interface WikiIncludeExpansion {
  readonly ast: AstNode[];
  readonly includedSourceBytes: number;
}

@Injectable()
export class WikiIncludeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiPermissions: WikiPermissionService
  ) {}

  async expand(input: {
    readonly ast: readonly AstNode[];
    readonly accountId: string | null;
    readonly actor?: WikiPermissionActor | null;
    readonly requestIp?: string | null;
    readonly sourcePageId: bigint;
    readonly sourceNamespace: string;
    readonly sourceLocalPath: string;
    readonly releaseId?: bigint;
    readonly publicationBoundary?: WikiPublishedPageBoundary;
  }): Promise<WikiIncludeExpansion> {
    let occurrence = 0;
    let includedSourceBytes = 0;
    const uniqueTargets = new Set<string>();
    const sourceKey = `${input.sourceNamespace}:${slugifyTitle(input.sourceLocalPath)}`;
    const memo = new Map<string, Promise<IncludeSource | null>>();

    const resolveInclude = async (node: {
      readonly target: string;
      readonly params: Record<string, string>;
    }): Promise<AstNode[] | null> => {
      occurrence += 1;
      const includeIndex = occurrence;
      if (includeIndex > MAX_INCLUDE_OCCURRENCES) return null;
      const target = resolveContextualTarget(input.sourceNamespace, input.sourceLocalPath, node.target);
      const targetKey = `${target.namespace}:${slugifyTitle(target.title)}`;
      uniqueTargets.add(targetKey);
      if (targetKey === sourceKey || uniqueTargets.size > MAX_UNIQUE_INCLUDE_TARGETS) return null;

      let sourcePromise = memo.get(targetKey);
      if (!sourcePromise) {
        sourcePromise = this.loadSource(target.namespace, target.title, {
          accountId: input.accountId,
          actor: input.actor,
          requestIp: input.requestIp,
          releaseId: input.releaseId,
          sourcePageId: input.sourcePageId,
          publicationBoundary: input.publicationBoundary,
        });
        memo.set(targetKey, sourcePromise);
      }
      const source = await sourcePromise;
      if (!source || source.pageId === input.sourcePageId || includedSourceBytes + source.bytes > MAX_INCLUDED_SOURCE_BYTES) {
        return null;
      }
      includedSourceBytes += source.bytes;
      return disableNestedIncludes(
        applyIncludeParametersToAst(
          source.ast,
          node.params,
          `inc-${includeIndex}-`,
          { calleeTitle: callerFullTitle(input.sourceNamespace, input.sourceLocalPath) }
        )
      );
    };

    const expandInline = async (nodes: readonly InlineNode[]): Promise<InlineNode[]> => {
      const output: InlineNode[] = [];
      for (const node of nodes) {
        if (node.type === 'include') {
          const children = await resolveInclude(node);
          output.push(children
            ? { ...node, state: 'resolved', children }
            : unavailableInline(node));
          continue;
        }
        if (node.type === 'internal_link' || node.type === 'external_link') {
          output.push(node.labelChildren
            ? { ...node, labelChildren: await expandInline(node.labelChildren) }
            : node);
          continue;
        }
        if ('children' in node && node.children) {
          output.push({ ...node, children: await expandInline(node.children) } as InlineNode);
          continue;
        }
        output.push(node);
      }
      return output;
    };

    const expandList = async (node: Extract<AstNode, { type: 'list' }>): Promise<Extract<AstNode, { type: 'list' }>> => ({
      ...node,
      items: await mapSequential(node.items, async (item) => ({
        children: await expandInline(item.children),
        nested: await mapSequential(item.nested, expandList),
      })),
    });

    const expandNodes = async (nodes: readonly AstNode[]): Promise<AstNode[]> => {
      const output: AstNode[] = [];
      for (const node of nodes) {
      if (node.type === 'heading') {
        output.push(node.children ? { ...node, children: await expandInline(node.children) } : node);
        continue;
      }
      if (node.type === 'paragraph') {
        output.push({ ...node, children: await expandInline(node.children) });
        continue;
      }
      if (node.type === 'list') {
        output.push(await expandList(node));
        continue;
      }
      if (node.type === 'wiki_table') {
        output.push({
          ...node,
          caption: await expandInline(node.caption),
          rows: await mapSequential(node.rows, async (row) => ({
            ...row,
            cells: await mapSequential(row.cells, async (cell) => ({
              ...cell,
              children: await expandInline(cell.children),
              ...(cell.blocks ? { blocks: await expandNodes(cell.blocks) } : {}),
            })),
          })),
        });
        continue;
      }
      if (node.type === 'indent') {
        output.push({ ...node, children: await expandNodes(node.children) });
        continue;
      }
      if (node.type === 'folding') {
        output.push({ ...node, title: await expandInline(node.title), children: await expandNodes(node.children) });
        continue;
      }
      if (node.type === 'conditional') {
        output.push(node.state === 'hidden' ? node : { ...node, children: await expandNodes(node.children) });
        continue;
      }
      if (node.type === 'wiki_style') {
        output.push({ ...node, children: await expandNodes(node.children) });
        continue;
      }
      if (node.type === 'blockquote') {
        output.push({ ...node, children: await expandNodes(node.children) });
        continue;
      }
      if (node.type === 'include') {
        const children = await resolveInclude(node);
        output.push(children ? { ...node, state: 'resolved', children } : unavailable(node));
        continue;
      }
      output.push(node);
      }
      return output;
    };

    return {
      ast: await expandNodes(input.ast),
      includedSourceBytes
    };
  }

  private async loadSource(
    namespaceCode: string,
    title: string,
    access: {
      readonly accountId: string | null;
      readonly actor?: WikiPermissionActor | null;
      readonly requestIp?: string | null;
      readonly releaseId?: bigint;
      readonly sourcePageId: bigint;
      readonly publicationBoundary?: WikiPublishedPageBoundary;
    }
  ): Promise<IncludeSource | null> {
    try {
      const namespace = await this.prisma.wikiNamespace.findUnique({
        where: { code: namespaceCode },
        select: { id: true }
      });
      if (!namespace) return null;
      const releaseDelegate = (this.prisma as unknown as {
        serverWikiRelease?: { findUnique(args: unknown): Promise<{ snapshotVersion: number } | null> };
      }).serverWikiRelease;
      const release = access.releaseId && releaseDelegate
        ? await releaseDelegate.findUnique({
            where: { id: access.releaseId },
            select: { snapshotVersion: true },
          })
        : null;
      const releasedItem = access.releaseId && namespaceCode === 'server'
        ? await this.prisma.serverWikiReleaseItem.findFirst({
            where: {
              releaseId: access.releaseId,
              namespaceId: namespace.id,
              slug: slugifyTitle(title),
            },
          })
        : null;
      const releasedInclude = access.releaseId && (release?.snapshotVersion ?? 0) >= 2 && namespaceCode !== 'server'
        ? await this.prisma.serverWikiReleaseInclude.findFirst({
            where: {
              releaseId: access.releaseId,
              sourcePageId: access.sourcePageId,
              targetNamespaceCode: namespaceCode,
              targetSlug: slugifyTitle(title),
            },
          })
        : null;
      if (access.releaseId && (release?.snapshotVersion ?? 0) >= 2 && namespaceCode !== 'server' && !releasedInclude) {
        return null;
      }
      if (releasedInclude?.publicReadAllowed === false) return null;
      const page = releasedItem
        ? {
            id: releasedItem.pageId,
            namespaceId: releasedItem.namespaceId,
            spaceId: releasedItem.spaceId,
            localPath: releasedItem.localPath,
            title: releasedItem.title,
            protectionLevel: releasedItem.protectionLevel,
            status: releasedItem.pageStatus,
            createdBy: releasedItem.createdBy,
            ownerProfileId: releasedItem.ownerProfileId,
            currentRevisionId: releasedItem.revisionId,
          }
        : releasedInclude
          ? {
              id: releasedInclude.targetPageId,
              namespaceId: releasedInclude.targetNamespaceId,
              spaceId: releasedInclude.targetSpaceId,
              localPath: releasedInclude.targetLocalPath,
              title: releasedInclude.targetTitle,
              protectionLevel: releasedInclude.targetProtectionLevel,
              status: releasedInclude.targetPageStatus,
              createdBy: releasedInclude.targetCreatedBy,
              ownerProfileId: releasedInclude.targetOwnerProfileId,
              currentRevisionId: releasedInclude.targetRevisionId,
            }
        : await this.prisma.wikiPage.findUnique({
            where: {
              namespaceId_slug: {
                namespaceId: namespace.id,
                slug: slugifyTitle(title)
              }
            }
          });
      if (!page?.currentRevisionId || (access.releaseId && namespaceCode === 'server' && !releasedItem)) return null;
      const revision = await this.prisma.wikiPageRevision.findFirst({
        where: {
          id: page.currentRevisionId,
          pageId: page.id,
          visibility: 'public'
        }
      });
      if (!revision) return null;
      if (releasedInclude && (
        revision.contentHash !== releasedInclude.contentHash
        || revision.contentSize !== releasedInclude.contentSize
      )) return null;
      await this.wikiPermissions.assertCanReadPage({
        ...access,
        page,
        revision,
        publicationProof: releasedItem && access.publicationBoundary
          ? { boundary: access.publicationBoundary, item: releasedItem }
          : undefined,
      });
      const parsed = parseMarkup(revision.contentRaw, {
        linkResolution: wikiLinkResolutionContext(namespaceCode, page.localPath),
      });
      if (parsed.blockingErrors.length > 0 || parsed.redirectTarget) return null;
      return {
        pageId: page.id,
        ast: parsed.ast,
        bytes: Buffer.byteLength(revision.contentRaw, 'utf8')
      };
    } catch {
      // Missing, private, hidden, deleted and malformed targets intentionally
      // collapse to one indistinguishable result to avoid ACL probing.
      return null;
    }
  }
}

function unavailable(node: Extract<AstNode, { type: 'include' }>): AstNode {
  return { ...node, state: 'unavailable', children: undefined };
}

function unavailableInline(node: Extract<InlineNode, { type: 'include' }>): InlineNode {
  return { ...node, state: 'unavailable', children: undefined };
}

async function mapSequential<T, U>(values: readonly T[], mapper: (value: T) => Promise<U>): Promise<U[]> {
  const output: U[] = [];
  for (const value of values) output.push(await mapper(value));
  return output;
}

function disableNestedIncludes(nodes: readonly AstNode[]): AstNode[] {
  return nodes.map((node): AstNode => {
    if (node.type === 'include') return unavailable(node);
    if (node.type === 'heading') return node.children
      ? { ...node, children: disableNestedInlineIncludes(node.children) }
      : node;
    if (node.type === 'paragraph') return { ...node, children: disableNestedInlineIncludes(node.children) };
    if (node.type === 'list') return disableNestedListIncludes(node);
    if (node.type === 'wiki_table') return {
      ...node,
      caption: disableNestedInlineIncludes(node.caption),
      rows: node.rows.map((row) => ({
        ...row,
        cells: row.cells.map((cell) => ({
          ...cell,
          children: disableNestedInlineIncludes(cell.children),
          ...(cell.blocks ? { blocks: disableNestedIncludes(cell.blocks) } : {}),
        })),
      })),
    };
    if (node.type === 'indent') return { ...node, children: disableNestedIncludes(node.children) };
    if (node.type === 'folding') return {
      ...node,
      title: disableNestedInlineIncludes(node.title),
      children: disableNestedIncludes(node.children),
    };
    if (node.type === 'conditional') return node.state === 'visible'
      ? { ...node, children: disableNestedIncludes(node.children) }
      : node;
    if (node.type === 'wiki_style') return { ...node, children: disableNestedIncludes(node.children) };
    if (node.type === 'blockquote') return { ...node, children: disableNestedIncludes(node.children) };
    return node;
  });
}

function disableNestedInlineIncludes(nodes: readonly InlineNode[]): InlineNode[] {
  return nodes.map((node): InlineNode => {
    if (node.type === 'include') return unavailableInline(node);
    if (node.type === 'internal_link' || node.type === 'external_link') return node.labelChildren
      ? { ...node, labelChildren: disableNestedInlineIncludes(node.labelChildren) }
      : node;
    if ('children' in node && node.children) {
      return { ...node, children: disableNestedInlineIncludes(node.children) } as InlineNode;
    }
    return node;
  });
}

function disableNestedListIncludes(node: Extract<AstNode, { type: 'list' }>): Extract<AstNode, { type: 'list' }> {
  return {
    ...node,
    items: node.items.map((item) => ({
      children: disableNestedInlineIncludes(item.children),
      nested: item.nested.map(disableNestedListIncludes),
    })),
  };
}

function callerFullTitle(namespace: string, localPath: string) {
  if (namespace === 'main') return localPath;
  const displayName = ({
    mod: '모드', modpack: '모드팩', server: '서버', dev: '개발', guide: '가이드',
    data: '데이터', help: '도움말', project: '프로젝트', template: '틀', user: '사용자',
    category: '분류', file: '파일'
  } as Record<string, string>)[namespace];
  return displayName ? `${displayName}:${localPath}` : localPath;
}

function resolveContextualTarget(namespace: string, localPath: string, target: string) {
  const parsed = parseLinkTarget(target);
  if (namespace !== 'server' || parsed.namespace !== 'main' || target.includes(':')) {
    return parsed;
  }
  const [serverSlug] = slugifyTitle(localPath).split('/');
  return {
    namespace: 'server' as const,
    title: `${serverSlug}/${parsed.title}`
  };
}

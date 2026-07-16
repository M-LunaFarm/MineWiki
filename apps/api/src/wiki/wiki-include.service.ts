import { Injectable } from '@nestjs/common';
import {
  applyIncludeParametersToAst,
  type AstNode,
  parseLinkTarget,
  parseMarkup,
  slugifyTitle
} from '@minewiki/wiki-core';
import { PrismaService } from '../common/prisma.service';
import { WikiPermissionService, type WikiPermissionActor } from './wiki-permission.service';

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
  }): Promise<WikiIncludeExpansion> {
    let occurrence = 0;
    let includedSourceBytes = 0;
    const uniqueTargets = new Set<string>();
    const sourceKey = `${input.sourceNamespace}:${slugifyTitle(input.sourceLocalPath)}`;
    const memo = new Map<string, Promise<IncludeSource | null>>();

    const expandNodes = async (nodes: readonly AstNode[]): Promise<AstNode[]> => Promise.all(nodes.map(async (node): Promise<AstNode> => {
      if (node.type === 'folding') {
        return { ...node, children: await expandNodes(node.children) };
      }
      if (node.type === 'wiki_style') {
        return { ...node, children: await expandNodes(node.children) };
      }
      if (node.type !== 'include') return node;

      occurrence += 1;
      const includeIndex = occurrence;
      if (includeIndex > MAX_INCLUDE_OCCURRENCES) return unavailable(node);
      const target = resolveContextualTarget(input.sourceNamespace, input.sourceLocalPath, node.target);
      const targetKey = `${target.namespace}:${slugifyTitle(target.title)}`;
      uniqueTargets.add(targetKey);
      if (
        targetKey === sourceKey ||
        uniqueTargets.size > MAX_UNIQUE_INCLUDE_TARGETS
      ) {
        return unavailable(node);
      }

      let sourcePromise = memo.get(targetKey);
      if (!sourcePromise) {
        sourcePromise = this.loadSource(target.namespace, target.title, {
          accountId: input.accountId,
          actor: input.actor,
          requestIp: input.requestIp
        });
        memo.set(targetKey, sourcePromise);
      }
      const source = await sourcePromise;
      if (
        !source ||
        source.pageId === input.sourcePageId ||
        includedSourceBytes + source.bytes > MAX_INCLUDED_SOURCE_BYTES
      ) {
        return unavailable(node);
      }
      includedSourceBytes += source.bytes;
      const children = disableNestedIncludes(
        applyIncludeParametersToAst(
          source.ast,
          node.params,
          `inc-${includeIndex}-`,
          { calleeTitle: callerFullTitle(input.sourceNamespace, input.sourceLocalPath) }
        )
      );
      return { ...node, state: 'resolved', children };
    }));

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
    }
  ): Promise<IncludeSource | null> {
    try {
      const namespace = await this.prisma.wikiNamespace.findUnique({
        where: { code: namespaceCode },
        select: { id: true }
      });
      if (!namespace) return null;
      const page = await this.prisma.wikiPage.findUnique({
        where: {
          namespaceId_slug: {
            namespaceId: namespace.id,
            slug: slugifyTitle(title)
          }
        }
      });
      if (!page?.currentRevisionId) return null;
      const revision = await this.prisma.wikiPageRevision.findFirst({
        where: {
          id: page.currentRevisionId,
          pageId: page.id,
          visibility: 'public'
        }
      });
      if (!revision) return null;
      await this.wikiPermissions.assertCanReadPage({ ...access, page, revision });
      const parsed = parseMarkup(revision.contentRaw);
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

function disableNestedIncludes(nodes: readonly AstNode[]): AstNode[] {
  return nodes.map((node): AstNode => {
    if (node.type === 'include') return unavailable(node);
    if (node.type === 'folding') return { ...node, children: disableNestedIncludes(node.children) };
    if (node.type === 'wiki_style') return { ...node, children: disableNestedIncludes(node.children) };
    return node;
  });
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

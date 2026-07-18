import { slugifyTitle } from '@minewiki/wiki-core';

const GROUP_ID_PATTERN = /^group:[a-z0-9][a-z0-9_-]{0,63}$/u;
const PAGE_NODE_ID_PATTERN = /^page:(\d+)$/u;
const UNORGANIZED_GROUP_ID = 'group:unorganized';

export interface ServerWikiNavigationPage {
  readonly id: bigint;
  readonly title: string;
  readonly localPath: string;
  readonly displayTitle: string;
}

export type ServerWikiNavigationDocumentNode =
  | { readonly id: string; readonly kind: 'group'; readonly title: string; readonly parentId: string | null }
  | { readonly id: string; readonly kind: 'page'; readonly pageId: string; readonly parentId: string | null };

export interface ServerWikiNavigationDocument {
  readonly version: 1;
  readonly nodes: readonly ServerWikiNavigationDocumentNode[];
}

export type ResolvedServerWikiNavigationNode<T extends ServerWikiNavigationPage = ServerWikiNavigationPage> =
  | { readonly id: string; readonly kind: 'group'; readonly title: string; readonly parentId: string | null; readonly depth: number }
  | { readonly id: string; readonly kind: 'page'; readonly page: T; readonly parentId: string | null; readonly depth: number };

export type ServerWikiReleaseNavigationNode<T extends ServerWikiNavigationPage = ServerWikiNavigationPage> =
  | {
      readonly nodeKey: string;
      readonly kind: 'group';
      readonly page: null;
      readonly parentKey: string | null;
      readonly title: string;
      readonly position: number;
      readonly depth: number;
      readonly hasChildren: boolean;
    }
  | {
      readonly nodeKey: string;
      readonly kind: 'page';
      readonly page: T;
      readonly parentKey: string | null;
      readonly title: string;
      readonly position: number;
      readonly depth: number;
      readonly hasChildren: boolean;
    };

/**
 * Materializes the presentation-only document tree used by immutable releases.
 * Release readers can query this compact structure without loading page bodies or
 * the full-text search vector from every release item.
 */
export function buildServerWikiReleaseNavigation<T extends ServerWikiNavigationPage>(
  serverSlug: string,
  pages: readonly T[],
  stored: unknown,
): Array<ServerWikiReleaseNavigationNode<T>> {
  const resolved = resolveServerWikiNavigationTree(serverSlug, pages, stored);
  const parentKeys = new Set(resolved.flatMap((node) => node.parentId ? [node.parentId] : []));
  return resolved.map((node, position) => node.kind === 'group'
    ? {
        nodeKey: node.id,
        kind: 'group' as const,
        page: null,
        parentKey: node.parentId,
        title: node.title,
        position,
        depth: node.depth,
        hasChildren: parentKeys.has(node.id),
      }
    : {
        nodeKey: node.id,
        kind: 'page' as const,
        page: node.page,
        parentKey: node.parentId,
        title: serverWikiNavigationTitle(serverSlug, node.page.displayTitle),
        position,
        depth: node.depth,
        hasChildren: parentKeys.has(node.id),
      });
}

export function resolveServerWikiNavigationTree<T extends ServerWikiNavigationPage>(
  serverSlug: string,
  pages: readonly T[],
  stored: unknown,
): Array<ResolvedServerWikiNavigationNode<T>> {
  const pageById = new Map(pages.map((page) => [page.id.toString(), page]));
  const decoded = decodeServerWikiNavigationDocument(stored);
  const nodes = Array.isArray(stored)
    ? legacyOrderedPageNodes(serverSlug, pages, decoded)
    : decoded
      ? reconcileStoredNodes(decoded, pages)
    : defaultPageNodes(serverSlug, pages);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const rootPage = pages.find((page) => serverWikiPageRelativePath(serverSlug, page) === '');
  const rootNodeId = rootPage ? pageNodeId(rootPage.id.toString()) : null;
  const parentById = new Map(nodes.map((node) => [node.id, safeParentId(node, nodeById)]));

  for (const node of nodes) {
    if (node.id === rootNodeId) {
      parentById.set(node.id, null);
      continue;
    }
    const visited = new Set([node.id]);
    let parentId = parentById.get(node.id) ?? null;
    while (parentId) {
      if (visited.has(parentId)) {
        parentById.set(node.id, rootNodeId && rootNodeId !== node.id ? rootNodeId : null);
        break;
      }
      visited.add(parentId);
      parentId = parentById.get(parentId) ?? null;
    }
  }

  const rank = new Map(nodes.map((node, index) => [node.id, index]));
  const children = new Map<string | null, ServerWikiNavigationDocumentNode[]>();
  for (const node of nodes) {
    const parentId = parentById.get(node.id) ?? null;
    const group = children.get(parentId) ?? [];
    group.push(node);
    children.set(parentId, group);
  }
  const compare = (left: ServerWikiNavigationDocumentNode, right: ServerWikiNavigationDocumentNode) => {
    if (left.id === rootNodeId) return -1;
    if (right.id === rootNodeId) return 1;
    return (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id);
  };
  for (const group of children.values()) group.sort(compare);

  const visibleMemo = new Map<string, boolean>();
  const hasVisiblePage = (nodeId: string, stack = new Set<string>()): boolean => {
    const cached = visibleMemo.get(nodeId);
    if (cached !== undefined) return cached;
    if (stack.has(nodeId)) return false;
    stack.add(nodeId);
    const node = nodeById.get(nodeId);
    const visible = node?.kind === 'page'
      ? pageById.has(node.pageId) || (children.get(nodeId) ?? []).some((child) => hasVisiblePage(child.id, stack))
      : (children.get(nodeId) ?? []).some((child) => hasVisiblePage(child.id, stack));
    stack.delete(nodeId);
    visibleMemo.set(nodeId, visible);
    return visible;
  };

  const resolved: Array<ResolvedServerWikiNavigationNode<T>> = [];
  const visited = new Set<string>();
  const visit = (node: ServerWikiNavigationDocumentNode, visibleParentId: string | null, depth: number) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    let childParentId = visibleParentId;
    let childDepth = depth;
    if (node.kind === 'group') {
      if (hasVisiblePage(node.id)) {
        resolved.push({ id: node.id, kind: 'group', title: node.title, parentId: visibleParentId, depth });
        childParentId = node.id;
        childDepth += 1;
      }
    } else {
      const page = pageById.get(node.pageId);
      if (page) {
        resolved.push({ id: node.id, kind: 'page', page, parentId: visibleParentId, depth });
        childParentId = node.id;
        childDepth += 1;
      }
    }
    for (const child of children.get(node.id) ?? []) visit(child, childParentId, childDepth);
  };
  for (const node of children.get(null) ?? []) visit(node, null, 0);
  for (const node of [...nodes].sort(compare)) visit(node, null, 0);
  return resolved;
}

export function orderServerWikiNavigationPages<T extends ServerWikiNavigationPage>(
  serverSlug: string,
  pages: readonly T[],
  stored: unknown,
) {
  return resolveServerWikiNavigationTree(serverSlug, pages, stored)
    .filter((node): node is Extract<ResolvedServerWikiNavigationNode<T>, { kind: 'page' }> => node.kind === 'page')
    .map((node) => ({
      page: node.page,
      relativePath: serverWikiPageRelativePath(serverSlug, node.page),
      parentId: node.parentId,
      depth: node.depth,
    }));
}

export function decodeServerWikiNavigationDocument(value: unknown): ServerWikiNavigationDocument | null {
  if (Array.isArray(value)) {
    const seen = new Set<string>();
    const nodes: ServerWikiNavigationDocumentNode[] = [];
    for (const item of value) {
      if (typeof item !== 'string' || !/^\d+$/u.test(item) || seen.has(item)) continue;
      seen.add(item);
      nodes.push({ id: pageNodeId(item), kind: 'page', pageId: item, parentId: null });
    }
    return nodes.length > 0 ? { version: 1, nodes } : null;
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.nodes)) return null;
  const nodes: ServerWikiNavigationDocumentNode[] = [];
  const seen = new Set<string>();
  for (const raw of value.nodes) {
    const node = decodeNode(raw);
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push(node);
  }
  return { version: 1, nodes };
}

export function validateServerWikiNavigationDocument(
  value: unknown,
  pageIds: readonly string[],
  maximumDepth = 8,
  rootPageId?: string,
): ServerWikiNavigationDocument {
  const decoded = decodeServerWikiNavigationDocument(value);
  if (!decoded || !isRecord(value) || value.version !== 1) {
    throw new Error('SERVER_WIKI_NAVIGATION_INVALID_DOCUMENT');
  }
  if (!Array.isArray(value.nodes) || value.nodes.length !== decoded.nodes.length) {
    throw new Error('SERVER_WIKI_NAVIGATION_INVALID_NODE');
  }
  if (decoded.nodes.length > pageIds.length + 100) throw new Error('SERVER_WIKI_NAVIGATION_TOO_MANY_GROUPS');
  const nodeIds = new Set(decoded.nodes.map((node) => node.id));
  if (nodeIds.size !== decoded.nodes.length) throw new Error('SERVER_WIKI_NAVIGATION_DUPLICATE_NODE');
  const expectedPages = new Set(pageIds);
  const actualPages = decoded.nodes.filter((node) => node.kind === 'page').map((node) => node.pageId);
  if (actualPages.length !== expectedPages.size || new Set(actualPages).size !== actualPages.length
    || actualPages.some((pageId) => !expectedPages.has(pageId))) {
    throw new Error('SERVER_WIKI_NAVIGATION_PAGE_SET_MISMATCH');
  }
  const rootNodeId = rootPageId ? pageNodeId(rootPageId) : null;
  const firstRootNode = decoded.nodes.find((node) => node.parentId === null);
  if (rootNodeId) {
    const rootNode = decoded.nodes.find((node) => node.id === rootNodeId);
    if (!rootNode || rootNode.parentId !== null || firstRootNode?.id !== rootNodeId) {
      throw new Error('SERVER_WIKI_NAVIGATION_INVALID_ROOT');
    }
  }
  for (const node of decoded.nodes) {
    if (node.parentId && (!nodeIds.has(node.parentId) || node.parentId === node.id)) {
      throw new Error('SERVER_WIKI_NAVIGATION_INVALID_PARENT');
    }
    const visited = new Set([node.id]);
    let parentId = node.parentId;
    let depth = 0;
    while (parentId) {
      if (visited.has(parentId)) throw new Error('SERVER_WIKI_NAVIGATION_CYCLE');
      visited.add(parentId);
      depth += 1;
      if (depth > maximumDepth) throw new Error('SERVER_WIKI_NAVIGATION_TOO_DEEP');
      parentId = decoded.nodes.find((candidate) => candidate.id === parentId)?.parentId ?? null;
    }
  }
  const parentsWithPages = new Set<string>();
  for (const page of decoded.nodes.filter((node) => node.kind === 'page')) {
    let parentId = page.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      parentsWithPages.add(parentId);
      parentId = decoded.nodes.find((candidate) => candidate.id === parentId)?.parentId ?? null;
    }
  }
  if (decoded.nodes.some((node) => node.kind === 'group' && !parentsWithPages.has(node.id))) {
    throw new Error('SERVER_WIKI_NAVIGATION_EMPTY_GROUP');
  }
  return decoded;
}

export function serverWikiPageRelativePath(
  serverSlug: string,
  page: Pick<ServerWikiNavigationPage, 'title' | 'localPath'>,
): string {
  return slugifyTitle(page.title) === slugifyTitle(serverSlug)
    ? ''
    : serverWikiRelativePath(serverSlug, page.localPath);
}

export function serverWikiNavigationTitle(serverSlug: string, displayTitle: string): string {
  const title = displayTitle.trim();
  const duplicatedPrefix = `${serverSlug.trim()}/`;
  return title.startsWith(duplicatedPrefix) ? title.slice(duplicatedPrefix.length) : title;
}

function reconcileStoredNodes(
  document: ServerWikiNavigationDocument,
  pages: readonly ServerWikiNavigationPage[],
): ServerWikiNavigationDocumentNode[] {
  const nodes = [...document.nodes];
  const configuredPageIds = new Set(nodes.filter((node) => node.kind === 'page').map((node) => node.pageId));
  const missingPages = pages.filter((page) => !configuredPageIds.has(page.id.toString()));
  if (missingPages.length === 0) return nodes;
  let groupId = UNORGANIZED_GROUP_ID;
  let suffix = 2;
  while (nodes.some((node) => node.id === groupId)) groupId = `${UNORGANIZED_GROUP_ID}-${suffix++}`;
  nodes.push({ id: groupId, kind: 'group', title: '정리되지 않은 문서', parentId: null });
  for (const page of missingPages.sort((left, right) => left.localPath.localeCompare(right.localPath, 'ko'))) {
    nodes.push({ id: pageNodeId(page.id.toString()), kind: 'page', pageId: page.id.toString(), parentId: groupId });
  }
  return nodes;
}

function legacyOrderedPageNodes(
  serverSlug: string,
  pages: readonly ServerWikiNavigationPage[],
  decoded: ServerWikiNavigationDocument | null,
): ServerWikiNavigationDocumentNode[] {
  const rank = new Map((decoded?.nodes ?? []).map((node, index) => [node.id, index]));
  return defaultPageNodes(serverSlug, pages).sort((left, right) => {
    const leftRank = rank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.id.localeCompare(right.id);
  });
}

function defaultPageNodes(
  serverSlug: string,
  pages: readonly ServerWikiNavigationPage[],
): ServerWikiNavigationDocumentNode[] {
  const byRelativePath = new Map(pages.map((page) => [serverWikiPageRelativePath(serverSlug, page), page]));
  const root = byRelativePath.get('') ?? null;
  return [...pages]
    .sort((left, right) => {
      if (left === root) return -1;
      if (right === root) return 1;
      return left.localPath.localeCompare(right.localPath, 'ko')
        || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    })
    .map((page) => {
      const relativePath = serverWikiPageRelativePath(serverSlug, page);
      const parts = relativePath.split('/').filter(Boolean);
      let parentId: string | null = root && root !== page ? pageNodeId(root.id.toString()) : null;
      for (let length = parts.length - 1; length > 0; length -= 1) {
        const ancestor = byRelativePath.get(parts.slice(0, length).join('/'));
        if (ancestor && ancestor !== page) {
          parentId = pageNodeId(ancestor.id.toString());
          break;
        }
      }
      return { id: pageNodeId(page.id.toString()), kind: 'page' as const, pageId: page.id.toString(), parentId };
    });
}

function decodeNode(value: unknown): ServerWikiNavigationDocumentNode | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const parentId = value.parentId === null ? null : typeof value.parentId === 'string' ? value.parentId : null;
  if (value.kind === 'group' && GROUP_ID_PATTERN.test(value.id) && typeof value.title === 'string') {
    const title = value.title.trim();
    return title && title.length <= 80 ? { id: value.id, kind: 'group', title, parentId } : null;
  }
  if (value.kind === 'page' && typeof value.pageId === 'string' && /^\d+$/u.test(value.pageId)
    && PAGE_NODE_ID_PATTERN.exec(value.id)?.[1] === value.pageId) {
    return { id: value.id, kind: 'page', pageId: value.pageId, parentId };
  }
  return null;
}

function safeParentId(
  node: ServerWikiNavigationDocumentNode,
  nodeById: ReadonlyMap<string, ServerWikiNavigationDocumentNode>,
): string | null {
  return node.parentId && node.parentId !== node.id && nodeById.has(node.parentId) ? node.parentId : null;
}

function pageNodeId(pageId: string): string {
  return `page:${pageId}`;
}

function serverWikiRelativePath(serverSlug: string, localPath: string): string {
  const normalizedSlug = serverSlug.trim().replace(/^\/+|\/+$/gu, '');
  const normalizedPath = localPath.trim().replace(/^\/+|\/+$/gu, '');
  if (normalizedPath === normalizedSlug) return '';
  return normalizedPath.startsWith(`${normalizedSlug}/`)
    ? normalizedPath.slice(normalizedSlug.length + 1)
    : normalizedPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

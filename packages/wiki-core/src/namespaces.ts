import type { NamespaceCode } from './types.js';
import { normalizeTitle, slugifyTitle } from './normalize.js';

export const namespaceSpecs: Array<{
  code: NamespaceCode;
  displayName: string;
  pathPrefix: string;
  isContent: boolean;
}> = [
  { code: 'main', displayName: '일반', pathPrefix: '/wiki', isContent: true },
  { code: 'mod', displayName: '모드', pathPrefix: '/wiki/모드', isContent: true },
  { code: 'modpack', displayName: '모드팩', pathPrefix: '/wiki/모드팩', isContent: true },
  { code: 'server', displayName: '서버', pathPrefix: '/wiki/서버', isContent: true },
  { code: 'dev', displayName: '개발', pathPrefix: '/dev', isContent: true },
  { code: 'guide', displayName: '가이드', pathPrefix: '/wiki/가이드', isContent: true },
  { code: 'data', displayName: '데이터', pathPrefix: '/wiki/데이터', isContent: true },
  { code: 'help', displayName: '도움말', pathPrefix: '/wiki/도움말', isContent: false },
  { code: 'project', displayName: '프로젝트', pathPrefix: '/wiki/프로젝트', isContent: false },
  { code: 'template', displayName: '틀', pathPrefix: '/wiki/틀', isContent: false },
  { code: 'user', displayName: '사용자', pathPrefix: '/user', isContent: false },
  { code: 'category', displayName: '분류', pathPrefix: '/wiki/category', isContent: false },
  { code: 'file', displayName: '파일', pathPrefix: '/file', isContent: false }
];

const prefixToNamespace: Array<[string, NamespaceCode]> = [
  ['main', 'main'],
  ['modpack', 'modpack'],
  ['mod', 'mod'],
  ['server', 'server'],
  ['dev', 'dev'],
  ['develop', 'dev'],
  ['guide', 'guide'],
  ['data', 'data'],
  ['help', 'help'],
  ['project', 'project'],
  ['template', 'template'],
  ['user', 'user'],
  ['category', 'category'],
  ['file', 'file'],
  ['files', 'file'],
  ['모드팩', 'modpack'],
  ['모드', 'mod'],
  ['서버', 'server'],
  ['개발', 'dev'],
  ['가이드', 'guide'],
  ['데이터', 'data'],
  ['도움말', 'help'],
  ['프로젝트', 'project'],
  ['틀', 'template'],
  ['사용자', 'user'],
  ['분류', 'category'],
  ['파일', 'file']
];

const MAX_LINK_CONTEXT_BYTES = 4096;
const MAX_LINK_PATH_SEGMENTS = 64;

export interface WikiLinkResolutionContext {
  /** Current document path within its wiki or isolated server-wiki. */
  currentDocumentPath: string;
  /** Namespace inherited by relative links. Isolated server-wikis use main. */
  namespace?: NamespaceCode;
}

export type ResolvedWikiLinkTarget =
  | { target: string; fragment: string | null }
  | { error: string };

/**
 * Resolves NamuMark subpage and parent links without accepting an arbitrary
 * route base. Absolute links remain untouched, while fragments are separated
 * from page dependency metadata.
 */
export function resolveWikiLinkTarget(
  rawTarget: string,
  context?: WikiLinkResolutionContext
): ResolvedWikiLinkTarget {
  const normalizedTarget = normalizeTitle(rawTarget).replaceAll('\\', '/');
  if (/%(?:2e|2f|5c)/iu.test(normalizedTarget)) {
    return { error: '중첩된 경로 인코딩은 내부 링크에 사용할 수 없습니다.' };
  }
  const fragmentIndex = normalizedTarget.indexOf('#');
  const pageTarget = (fragmentIndex >= 0 ? normalizedTarget.slice(0, fragmentIndex) : normalizedTarget).trim();
  const fragment = fragmentIndex >= 0
    ? normalizeTitle(normalizedTarget.slice(fragmentIndex + 1))
    : null;

  if (!pageTarget) {
    return fragment
      ? { target: '', fragment }
      : { error: '내부 링크 대상이 비어 있습니다.' };
  }

  const relative = pageTarget.startsWith('/') || pageTarget === '..' || pageTarget.startsWith('../');
  if (!relative || !context) return { target: normalizeTitle(pageTarget), fragment };

  const contextPath = normalizeTitle(context.currentDocumentPath).replaceAll('\\', '/');
  if (
    Buffer.byteLength(contextPath, 'utf8') > MAX_LINK_CONTEXT_BYTES
    || (context.namespace && !namespaceSpecs.some((spec) => spec.code === context.namespace))
  ) {
    return { error: '상대 링크 해석 기준이 올바르지 않습니다.' };
  }

  const currentSegments = normalizedPathSegments(contextPath);
  if (
    !currentSegments
    || currentSegments.length > MAX_LINK_PATH_SEGMENTS
  ) {
    return { error: '상대 링크 해석 기준이 올바르지 않습니다.' };
  }

  const resolvedSegments = [...currentSegments];
  for (const segment of pageTarget.split('/')) {
    const normalizedSegment = normalizeTitle(segment);
    if (!normalizedSegment || normalizedSegment === '.') continue;
    if (normalizedSegment === '..') {
      if (resolvedSegments.length === 0) {
        return { error: '상대 링크가 문서 루트를 벗어날 수 없습니다.' };
      }
      resolvedSegments.pop();
      continue;
    }
    resolvedSegments.push(normalizedSegment);
    if (resolvedSegments.length > MAX_LINK_PATH_SEGMENTS) {
      return { error: '상대 링크 경로가 너무 깊습니다.' };
    }
  }

  const title = resolvedSegments.join('/');
  if (!title || Buffer.byteLength(title, 'utf8') > MAX_LINK_CONTEXT_BYTES) {
    return { error: '상대 링크 대상이 올바르지 않습니다.' };
  }
  const namespace = context.namespace ?? 'main';
  return {
    target: namespace === 'main' ? title : `${namespace}:${title}`,
    fragment
  };
}

function normalizedPathSegments(path: string): string[] | null {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    const normalized = normalizeTitle(segment);
    if (!normalized) continue;
    if (normalized === '.' || normalized === '..') return null;
    segments.push(normalized);
  }
  return segments;
}

export function resolveWikiPath(path: string) {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const [head, ...rest] = clean.split('/');
  if (head === 'wiki') {
    const nested = prefixToNamespace.find(([prefix]) => prefix === rest[0]);
    if (nested) {
      const titlePath = rest.slice(1).join('/');
      if (nested[1] === 'user') return resolveUserPath(titlePath);
      return { namespace: nested[1], title: normalizeTitle(titlePath), slug: slugifyTitle(titlePath) };
    }
    const titlePath = rest.join('/');
    return { namespace: 'main' as NamespaceCode, title: normalizeTitle(titlePath), slug: slugifyTitle(titlePath) };
  }
  const matched = prefixToNamespace.find(([prefix]) => prefix === head);
  if (matched) {
    if (matched[1] === 'user') return resolveUserPath(rest.join('/'));
    return {
      namespace: matched[1],
      title: normalizeTitle(rest.join('/')),
      slug: slugifyTitle(rest.join('/'))
    };
  }
  return { namespace: 'main' as NamespaceCode, title: normalizeTitle(clean), slug: slugifyTitle(clean) };
}

function resolveUserPath(path: string) {
  const [encodedUsername = '', ...encodedDocumentParts] = path.split('/');
  const username = decodeURIComponent(encodedUsername).trim();
  const documentTitle = normalizeTitle(encodedDocumentParts.join('/'));
  const title = documentTitle ? `${username}/${documentTitle}` : username;
  const documentSlug = slugifyTitle(documentTitle);
  return {
    namespace: 'user' as NamespaceCode,
    title,
    slug: documentSlug ? `${username}/${documentSlug}` : username
  };
}

export function wikiUrl(namespace: NamespaceCode, title: string) {
  const encodedTitle = slugifyTitle(title).split('/').map((part) => encodeURIComponent(part)).join('/');
  if (namespace === 'mod') return `/mod/${encodedTitle}`;
  if (namespace === 'modpack') return `/modpack/${encodedTitle}`;
  if (namespace === 'server') return `/server/${encodedTitle}`;
  if (namespace === 'dev') return `/dev/${encodedTitle}`;
  if (namespace === 'help') return `/help/${encodedTitle}`;
  if (namespace === 'project') return `/project/${encodedTitle}`;
  if (namespace === 'guide') return `/guide/${encodedTitle}`;
  if (namespace === 'data') return `/data/${encodedTitle}`;
  if (namespace === 'template') return `/template/${encodedTitle}`;
  if (namespace === 'user') return `/user/${encodedTitle}`;
  if (namespace === 'category') return `/wiki/category/${encodedTitle}`;
  const spec = namespaceSpecs.find((item) => item.code === namespace) ?? namespaceSpecs[0];
  return `${encodePathPrefix(spec.pathPrefix)}/${encodedTitle}`;
}

function encodePathPrefix(pathPrefix: string) {
  return pathPrefix
    .split('/')
    .map((part) => (part ? encodeURIComponent(part) : ''))
    .join('/');
}

export function parseLinkTarget(target: string) {
  const [prefix, ...rest] = normalizeTitle(target).split(':');
  const ns = prefixToNamespace.find(([name]) => name === prefix);
  if (ns && rest.length > 0) return { namespace: ns[1], title: rest.join(':') };
  return { namespace: 'main' as NamespaceCode, title: normalizeTitle(target) };
}

export function wikiLinkKey(target: string) {
  const parsed = parseLinkTarget(target);
  return `${parsed.namespace}:${slugifyTitle(parsed.title)}`;
}

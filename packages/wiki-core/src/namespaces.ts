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
  { code: 'file', displayName: '파일', pathPrefix: '/file', isContent: false }
];

const prefixToNamespace: Array<[string, NamespaceCode]> = [
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
  ['파일', 'file']
];

export function resolveWikiPath(path: string) {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const [head, ...rest] = clean.split('/');
  if (head === 'wiki') {
    const titlePath = rest.join('/');
    return { namespace: 'main' as NamespaceCode, title: normalizeTitle(titlePath), slug: slugifyTitle(titlePath) };
  }
  const matched = prefixToNamespace.find(([prefix]) => prefix === head);
  if (matched) {
    return {
      namespace: matched[1],
      title: normalizeTitle(rest.join('/')),
      slug: slugifyTitle(rest.join('/'))
    };
  }
  return { namespace: 'main' as NamespaceCode, title: normalizeTitle(clean), slug: slugifyTitle(clean) };
}

export function wikiUrl(namespace: NamespaceCode, title: string) {
  const encodedTitle = slugifyTitle(title).split('/').map((part) => encodeURIComponent(part)).join('/');
  if (namespace === 'mod') return `/mod/${encodedTitle}`;
  if (namespace === 'modpack') return `/modpack/${encodedTitle}`;
  if (namespace === 'server') return `/server/${encodedTitle}`;
  if (namespace === 'dev') return `/dev/${encodedTitle}`;
  if (namespace === 'help') return `/help/${encodedTitle}`;
  if (namespace === 'project') return `/project/${encodedTitle}`;
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

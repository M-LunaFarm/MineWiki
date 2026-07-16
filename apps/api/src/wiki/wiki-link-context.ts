import type { NamespaceCode, WikiLinkResolutionContext } from '@minewiki/wiki-core';

const NAMESPACE_CODES = new Set<NamespaceCode>([
  'main', 'mod', 'modpack', 'server', 'dev', 'guide', 'data', 'help', 'project',
  'template', 'file', 'category', 'user',
]);

export function wikiLinkResolutionContext(
  namespaceCode: string,
  localPath: string | null | undefined,
): WikiLinkResolutionContext {
  const normalizedPath = typeof localPath === 'string'
    ? localPath.trim().replace(/^\/+|\/+$/gu, '')
    : '';
  if (namespaceCode === 'server') {
    const [, ...relativeSegments] = normalizedPath.split('/');
    return { currentDocumentPath: relativeSegments.join('/'), namespace: 'main' };
  }
  return {
    currentDocumentPath: normalizedPath,
    namespace: NAMESPACE_CODES.has(namespaceCode as NamespaceCode)
      ? namespaceCode as NamespaceCode
      : 'main',
  };
}

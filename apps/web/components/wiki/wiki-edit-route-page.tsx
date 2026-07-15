import { fetchWikiPageByPath } from '../../lib/wiki-server-api';
import { buildWikiRoutePath, decodeWikiRouteSegment } from '../../lib/wiki-routes.mjs';
import { WikiEditorClient } from './wiki-editor-client';
import { ServerWikiWorkspace } from './server-wiki-workspace';

interface WikiEditRoutePageProps {
  readonly prefix: 'wiki' | 'mod' | 'modpack' | 'server' | 'dev' | 'guide' | 'data' | 'help' | 'project' | 'template' | 'user' | 'category' | 'file';
  readonly segments?: string[];
}

const namespaceByPrefix = {
  wiki: 'main',
  mod: 'mod',
  modpack: 'modpack',
  server: 'server',
  dev: 'dev',
  guide: 'guide',
  data: 'data',
  help: 'help',
  project: 'project',
  template: 'template',
  user: 'user',
  category: 'category',
  file: 'file'
} as const;

export async function WikiEditRoutePage({ prefix, segments = [] }: WikiEditRoutePageProps) {
  const title = segments.length > 0 ? segments.map(decodeWikiRouteSegment).join('/') : '대문';
  const routePath = buildWikiRoutePath(prefix, segments);
  const page = await fetchWikiPageByPath(routePath).catch(() => null);

  const editor = (
    <WikiEditorClient
      page={page}
      namespace={namespaceByPrefix[prefix]}
      title={title}
      routePath={routePath}
    />
  );
  if (prefix === 'server' && page?.serverWiki) {
    return <ServerWikiWorkspace page={page} section="편집">{editor}</ServerWikiWorkspace>;
  }
  return editor;
}

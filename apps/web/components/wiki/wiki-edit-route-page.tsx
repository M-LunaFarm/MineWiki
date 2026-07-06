import { fetchWikiPageByPath } from '../../lib/wiki-api';
import { WikiEditorClient } from './wiki-editor-client';

interface WikiEditRoutePageProps {
  readonly prefix: 'wiki' | 'mod' | 'modpack' | 'server' | 'dev' | 'help' | 'project' | 'file';
  readonly segments?: string[];
}

const namespaceByPrefix = {
  wiki: 'main',
  mod: 'mod',
  modpack: 'modpack',
  server: 'server',
  dev: 'dev',
  help: 'help',
  project: 'project',
  file: 'file'
} as const;

export async function WikiEditRoutePage({ prefix, segments = [] }: WikiEditRoutePageProps) {
  const title = segments.length > 0 ? segments.map(decodeURIComponent).join('/') : '대문';
  const suffix = segments.map((segment) => encodeURIComponent(segment)).join('/');
  const routePath = `/${prefix}${suffix ? `/${suffix}` : '/대문'}`;
  const page = await fetchWikiPageByPath(routePath).catch(() => null);

  return (
    <WikiEditorClient
      page={page}
      namespace={namespaceByPrefix[prefix]}
      title={title}
      routePath={routePath}
    />
  );
}

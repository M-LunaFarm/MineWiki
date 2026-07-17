import { fetchServerWikiPresentation, fetchWikiPageByPath } from '../../lib/wiki-server-api';
import { buildWikiRoutePath, decodeWikiRouteSegment } from '../../lib/wiki-routes.mjs';
import { WikiEditorClient } from './wiki-editor-client';
import { WikiEditorLoadError } from './wiki-editor-load-error';
import { ServerWikiWorkspace } from './server-wiki-workspace';

interface WikiEditRoutePageProps {
  readonly prefix: 'wiki' | 'mod' | 'modpack' | 'server' | 'serverWiki' | 'dev' | 'guide' | 'data' | 'help' | 'project' | 'template' | 'user' | 'category' | 'file';
  readonly segments?: string[];
}

const namespaceByPrefix = {
  wiki: 'main',
  mod: 'mod',
  modpack: 'modpack',
  server: 'server',
  serverWiki: 'server',
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
  let title = segments.length > 0 ? segments.map(decodeWikiRouteSegment).join('/') : '대문';
  const routePath = buildWikiRoutePath(prefix, segments);
  let page;
  try {
    page = await fetchWikiPageByPath(routePath);
  } catch {
    return (
      <WikiEditorLoadError
        title="편집 정보를 불러오지 못했습니다"
        message="문서 존재 여부를 확인할 수 없어 새 문서 편집기를 열지 않았습니다. 잠시 후 다시 시도해 주세요."
        backHref={routePath}
      />
    );
  }
  let serverContextPage = page;
  if (prefix === 'serverWiki') {
    const rootPage = page ?? (segments[0]
      ? await fetchWikiPageByPath(buildWikiRoutePath('serverWiki', [segments[0]]))
      : null);
    serverContextPage = rootPage;
    const contentSlug = rootPage?.serverWiki?.contentSlug;
    if (contentSlug) {
      const relativeTitle = segments.slice(1).map(decodeWikiRouteSegment).join('/');
      title = relativeTitle ? `${contentSlug}/${relativeTitle}` : contentSlug;
    }
  }
  const serverSlug = prefix === 'server' || prefix === 'serverWiki'
    ? serverContextPage?.serverWiki?.contentSlug ?? (segments[0] ? decodeWikiRouteSegment(segments[0]) : null)
    : null;
  let presentation = null;
  let presentationLoadFailed = false;
  if (serverSlug) {
    try {
      presentation = await fetchServerWikiPresentation(serverSlug);
    } catch {
      presentationLoadFailed = true;
    }
  }

  const editor = (
    <WikiEditorClient
      page={page}
      namespace={namespaceByPrefix[prefix]}
      title={title}
      routePath={routePath}
      presentation={presentation}
      presentationLoadFailed={presentationLoadFailed}
    />
  );
  if ((prefix === 'server' || prefix === 'serverWiki') && serverContextPage?.serverWiki) {
    return <ServerWikiWorkspace page={serverContextPage} section="편집">{editor}</ServerWikiWorkspace>;
  }
  return editor;
}

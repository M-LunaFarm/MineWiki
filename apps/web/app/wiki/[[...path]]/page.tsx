import { WikiRoutePage } from '../../../components/wiki/wiki-route-page';
import { WikiEditRoutePage } from '../../../components/wiki/wiki-edit-route-page';
import { WikiHistoryRoutePage } from '../../../components/wiki/wiki-history-route-page';
import { parseStandardWikiToolRoute } from '../../../lib/wiki-routes.mjs';

interface PageProps {
  readonly params: Promise<{ path?: string[] }>;
  readonly searchParams: Promise<{ redirect?: string | string[]; noRedirect?: string | string[] }>;
}

export const revalidate = 60;

export default async function WikiPage({ params, searchParams }: PageProps) {
  const resolvedParams = await params;
  const resolvedSearchParams = await searchParams;
  const path = resolvedParams.path ?? [];
  const toolRoute = parseStandardWikiToolRoute(path);
  if (toolRoute?.tool === 'edit') return <WikiEditRoutePage prefix="wiki" segments={toolRoute.documentSegments} />;
  if (toolRoute?.tool === 'history') return <WikiHistoryRoutePage prefix="wiki" segments={toolRoute.documentSegments} />;
  const redirect = firstQueryValue(resolvedSearchParams.redirect);
  const noRedirect = firstQueryValue(resolvedSearchParams.noRedirect);
  const followRedirects = redirect !== '0' && noRedirect !== '1' && noRedirect !== 'true';
  return <WikiRoutePage prefix="wiki" segments={resolvedParams.path} followRedirects={followRedirects} />;
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

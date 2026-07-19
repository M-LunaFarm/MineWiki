import { getSiteUrl } from './metadata';

export const CUSTOM_DOMAIN_HOST_HEADER = 'x-minewiki-custom-host';
export const CUSTOM_DOMAIN_SITE_SLUG_HEADER = 'x-minewiki-site-slug';

export interface ServerWikiPublicRouteContext {
  readonly customHostname: string;
  readonly siteSlug: string;
}

export function serverWikiPublicPath(
  platformPath: string,
  context?: ServerWikiPublicRouteContext | null,
): string {
  if (!context) return platformPath;
  const parsed = new URL(platformPath, 'https://minewiki.invalid');
  const prefix = `/serverWiki/${encodeURIComponent(context.siteSlug)}`;
  if (parsed.pathname !== prefix && !parsed.pathname.startsWith(`${prefix}/`)) {
    return serverWikiPlatformUrl(platformPath);
  }
  const pathname = parsed.pathname === prefix ? '/' : parsed.pathname.slice(prefix.length);
  return `${pathname}${parsed.search}${parsed.hash}`;
}

export function serverWikiPlatformUrl(path: string): string {
  return new URL(path, `${getSiteUrl()}/`).toString();
}

export function serverWikiCanonicalUrl(
  platformPath: string,
  context?: ServerWikiPublicRouteContext | null,
): string {
  if (!context) return platformPath;
  return new URL(serverWikiPublicPath(platformPath, context), `https://${context.customHostname}`).toString();
}

export function rewriteServerWikiHtmlLinks(
  html: string,
  context?: ServerWikiPublicRouteContext | null,
): string {
  if (!context) return html;
  const prefix = `/serverWiki/${encodeURIComponent(context.siteSlug)}`;
  const links = html.replace(/\bhref=(['"])([^'"]+)\1/giu, (match, quote: string, href: string) => {
    if (href !== prefix && !href.startsWith(`${prefix}/`) && !href.startsWith(`${prefix}?`) && !href.startsWith(`${prefix}#`)) {
      return match;
    }
    return `href=${quote}${serverWikiPublicPath(href, context)}${quote}`;
  });
  const platformSearchPath = `${prefix}/_search`;
  return links.replace(/\baction=(['"])([^'"]+)\1/giu, (match, quote: string, action: string) => (
    action === platformSearchPath ? `action=${quote}/_search${quote}` : match
  ));
}

export function readServerWikiPublicRouteContext(
  requestHeaders: Pick<Headers, 'get'>,
  siteSlug: string | undefined,
): ServerWikiPublicRouteContext | null {
  const customHostname = requestHeaders.get(CUSTOM_DOMAIN_HOST_HEADER)?.trim().toLowerCase();
  const routedSiteSlug = requestHeaders.get(CUSTOM_DOMAIN_SITE_SLUG_HEADER)?.trim();
  if (!customHostname || !routedSiteSlug || routedSiteSlug !== siteSlug) return null;
  return { customHostname, siteSlug: routedSiteSlug };
}

import { normalizeApiBaseUrl } from '../../../../lib/runtime-config';
import { getSiteUrl } from '../../../../lib/metadata';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const response = await fetch(`${normalizeApiBaseUrl(process.env.INTERNAL_API_BASE_URL)}/v1/wiki/server-wikis/${encodeURIComponent(slug)}/sitemap`, { cache: 'no-store' });
  if (!response.ok) return new Response('Not found', { status: 404 });
  const body = await response.json() as { items: Array<{ path: string; lastModified: string }> };
  const urls = body.items.map((item) => `<url><loc>${xml(new URL(item.path, getSiteUrl()).toString())}</loc><lastmod>${xml(item.lastModified)}</lastmod></url>`).join('');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300, stale-while-revalidate=300' } });
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
};

function xml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => XML_ENTITIES[character]!);
}

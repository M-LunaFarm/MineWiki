import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import { getSiteUrl } from '../../lib/metadata';

export const dynamic = 'force-dynamic';

export async function GET() {
  const response = await fetch(`${normalizeApiBaseUrl(process.env.INTERNAL_API_BASE_URL)}/v1/wiki/server-wikis/sitemap-index`, { cache: 'no-store' });
  if (!response.ok) return new Response('Sitemap unavailable', { status: 503 });
  const body = await response.json() as { items: Array<{ slug: string }> };
  const sitemaps = body.items.map((item) => `<sitemap><loc>${xml(new URL(`/sitemaps/server-wikis/${encodeURIComponent(item.slug)}`, getSiteUrl()).toString())}</loc></sitemap>`).join('');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemaps}</sitemapindex>`, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300, stale-while-revalidate=300' } });
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
};

function xml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => XML_ENTITIES[character]!);
}

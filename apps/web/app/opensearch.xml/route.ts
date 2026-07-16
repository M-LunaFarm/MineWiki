import { getSiteUrl } from '../../lib/metadata';

export const dynamic = 'force-static';

export function GET() {
  const siteUrl = getSiteUrl();
  const searchTemplate = `${siteUrl}/search?q={searchTerms}`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>MineWiki</ShortName>
  <Description>한국 Minecraft 서버와 MineWiki 문서를 통합 검색합니다.</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Language>ko-KR</Language>
  <Contact>support@minewiki.kr</Contact>
  <Url type="text/html" method="get" template="${escapeXml(searchTemplate)}" />
  <Image height="64" width="64" type="image/png">${escapeXml(`${siteUrl}/icon`)}</Image>
</OpenSearchDescription>
`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/opensearchdescription+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

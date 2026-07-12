import { ImageResponse } from 'next/og';
import { DEFAULT_SITE_DESCRIPTION } from '../../lib/metadata';

export const runtime = 'edge';

export function GET(request: Request) {
  const url = new URL(request.url);
  const title = truncate(url.searchParams.get('title') ?? 'MineWiki', 62);
  const description = truncate(
    url.searchParams.get('description') ?? DEFAULT_SITE_DESCRIPTION,
    118,
  );

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#f1efe8',
          color: '#20251f',
          padding: '68px',
          fontFamily: 'Arial, sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '18px',
            fontSize: '34px',
            fontWeight: 800,
          }}
        >
          <div
            style={{
              width: '58px',
              height: '58px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '12px',
              background: '#123d31',
              color: '#9af2d5',
              fontSize: '18px',
              letterSpacing: '-2px',
            }}
          >
            MW
          </div>
          <div style={{ display: 'flex' }}>
            MineWiki<span style={{ color: '#197052' }}>.kr</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div
            style={{
              maxWidth: '930px',
              fontSize: title.length > 34 ? '62px' : '76px',
              lineHeight: 1.04,
              fontWeight: 900,
              letterSpacing: '-1px',
            }}
          >
            {title}
          </div>
          <div
            style={{
              maxWidth: '860px',
              color: '#596159',
              fontSize: '28px',
              lineHeight: 1.35,
            }}
          >
            {description}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: '1px solid #aaa79e',
            paddingTop: '28px',
            color: '#6e756d',
            fontSize: '24px',
          }}
        >
          <span>서버 랭킹 · 위키 · 리뷰</span>
          <span>minewiki.kr</span>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    },
  );
}

function truncate(value: string, maxLength: number) {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}

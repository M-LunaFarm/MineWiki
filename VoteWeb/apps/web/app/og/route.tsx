import { ImageResponse } from 'next/og';
import { DEFAULT_SITE_DESCRIPTION } from '../../lib/metadata';

export const runtime = 'edge';

export function GET(request: Request) {
  const url = new URL(request.url);
  const title = truncate(url.searchParams.get('title') ?? 'Lunaf.kr', 62);
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
          background: '#0b0d10',
          color: '#f8fafc',
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
              width: '56px',
              height: '56px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '14px',
              border: '1px solid rgba(19, 236, 128, 0.45)',
              background: 'rgba(19, 236, 128, 0.12)',
              color: '#13ec80',
            }}
          >
            L
          </div>
          <div style={{ display: 'flex' }}>
            Lunaf<span style={{ color: '#13ec80' }}>.kr</span>
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
              color: '#b8c0c8',
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
            borderTop: '1px solid #272c33',
            paddingTop: '28px',
            color: '#8f98a3',
            fontSize: '24px',
          }}
        >
          <span>한국 마인크래프트 서버 목록</span>
          <span>lunaf.kr</span>
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

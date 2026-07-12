import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#123d31', color: '#9af2d5', fontFamily: 'Arial, sans-serif', fontSize: 74, fontWeight: 900, letterSpacing: '-8px', paddingRight: '6px' }}>
      MW
    </div>,
    size,
  );
}

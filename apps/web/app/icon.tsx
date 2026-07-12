import { ImageResponse } from 'next/og';

export const size = { width: 512, height: 512 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#123d31', color: '#9af2d5', fontFamily: 'Arial, sans-serif', fontSize: 212, fontWeight: 900, letterSpacing: '-22px', paddingRight: '18px' }}>
      MW
    </div>,
    size,
  );
}

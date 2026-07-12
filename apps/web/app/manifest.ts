import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'MineWiki',
    short_name: 'MineWiki',
    description: '한국 마인크래프트 서버 랭킹과 위키',
    start_url: '/',
    display: 'standalone',
    background_color: '#f4f2ec',
    theme_color: '#123d31',
    lang: 'ko',
    icons: [
      { src: '/icon', sizes: '512x512', type: 'image/png' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  };
}

import type { Metadata } from 'next';

export const SITE_NAME = 'MineWiki';

export const DEFAULT_SITE_DESCRIPTION =
  '한국 마인크래프트 서버를 검색하고, 투표와 리뷰로 운영 상태를 비교하세요.';

const DEFAULT_OG_TITLE = 'MineWiki';

export function getSiteUrl() {
  return normalizeSiteUrl(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://minewiki.kr');
}

export function createPageMetadata({
  title,
  description,
  path,
  imageTitle,
  imageDescription,
  images,
  noIndex = false,
}: {
  readonly title: string;
  readonly description: string;
  readonly path: string;
  readonly imageTitle?: string;
  readonly imageDescription?: string;
  readonly images?: NonNullable<Metadata['openGraph']>['images'];
  readonly noIndex?: boolean;
}): Metadata {
  const fullTitle = title.includes(SITE_NAME) ? title : `${title} | ${SITE_NAME}`;
  const ogImages = images ?? [
    {
      url: buildOgImageUrl(imageTitle ?? title, imageDescription ?? description),
      width: 1200,
      height: 630,
      alt: fullTitle,
    },
  ];

  return {
    title,
    description,
    alternates: {
      canonical: path,
    },
    openGraph: {
      title: fullTitle,
      description,
      url: path,
      siteName: SITE_NAME,
      locale: 'ko_KR',
      type: 'website',
      images: ogImages,
    },
    twitter: {
      card: 'summary_large_image',
      title: fullTitle,
      description,
      images: ogImages,
    },
    robots: noIndex ? { index: false, follow: false } : { index: true, follow: true },
  };
}

export function buildOgImageUrl(title: string, description?: string) {
  const url = new URL('/og', getSiteUrl());
  url.searchParams.set('title', title || DEFAULT_OG_TITLE);
  if (description) {
    url.searchParams.set('description', description);
  }
  return url.toString();
}

function normalizeSiteUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed || 'https://minewiki.kr';
}

export { default } from './servers/page';

import { createPageMetadata } from '../lib/metadata';

export const metadata = createPageMetadata({
  title: '마인크래프트 서버 순위',
  description: '한국 마인크래프트 서버를 실시간 동접, 투표, 리뷰, 에디션 기준으로 비교하세요.',
  path: '/',
});

export const revalidate = 60;

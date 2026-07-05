import { createPageMetadata } from '../../lib/metadata';

export const metadata = createPageMetadata({
  title: '계정 인증',
  description: 'MineWiki 계정 로그인과 회원가입을 진행합니다.',
  path: '/auth',
  noIndex: true,
});

export { default } from '../login/page';

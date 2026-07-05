import type { Metadata } from 'next';
import { AccountClientPage } from './account-client';
import { createPageMetadata } from '../../lib/metadata';

export const metadata: Metadata = createPageMetadata({
  title: '계정 및 보안',
  description:
    'MineWiki 계정, 로그인 수단, 보안 세션, Minecraft 소유권 확인을 관리하는 사용자 센터입니다.',
  path: '/me',
  noIndex: true,
});

export default function AccountPage() {
  return <AccountClientPage />;
}

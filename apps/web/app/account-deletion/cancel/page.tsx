import type { Metadata } from 'next';
import { AccountDeletionCancelClient } from './cancel-client';

export const metadata: Metadata = {
  title: '계정 종료 요청 취소',
  description: 'MineWiki 계정 종료 요청을 유예기간 안에 취소합니다.',
  robots: { index: false, follow: false },
};

export default function AccountDeletionCancelPage() {
  return <AccountDeletionCancelClient />;
}

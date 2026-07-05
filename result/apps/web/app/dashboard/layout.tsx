import type { ReactNode } from 'react';
import { createPageMetadata } from '../../lib/metadata';

export const metadata = createPageMetadata({
  title: '대시보드',
  description: '내가 운영하는 서버의 투표, 리뷰, 검증 상태를 관리하세요.',
  path: '/dashboard',
  noIndex: true,
});

export default function DashboardLayout({ children }: { readonly children: ReactNode }) {
  return <>{children}</>;
}

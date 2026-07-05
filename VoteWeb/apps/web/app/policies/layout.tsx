import type { ReactNode } from 'react';
import { createPageMetadata } from '../../lib/metadata';

export const metadata = createPageMetadata({
  title: '운영 정책 센터',
  description:
    'Lunaf.kr 서비스 이용약관, 개인정보처리방침, 운영/투표 정책 및 개정 이력을 확인하세요.',
  path: '/policies',
});

export default function PoliciesLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

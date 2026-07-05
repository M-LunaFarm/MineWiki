import type { ReactNode } from 'react';
import { createPageMetadata } from '../../../lib/metadata';

export const metadata = createPageMetadata({
  title: '서버 등록',
  description: 'Lunaf.kr에 마인크래프트 서버를 등록하고 검증 정보를 설정하세요.',
  path: '/servers/register',
  noIndex: true,
});

export default function RegisterServerLayout({ children }: { readonly children: ReactNode }) {
  return <>{children}</>;
}

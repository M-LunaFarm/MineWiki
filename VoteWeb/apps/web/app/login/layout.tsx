import type { ReactNode } from 'react';
import { createPageMetadata } from '../../lib/metadata';

export const metadata = createPageMetadata({
  title: '로그인',
  description: 'Lunaf 계정으로 로그인하거나 새 계정을 만들 수 있습니다.',
  path: '/login',
  noIndex: true,
});

export default function LoginLayout({ children }: { readonly children: ReactNode }) {
  return <>{children}</>;
}

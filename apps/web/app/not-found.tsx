import type { Metadata } from 'next';
import { WikiMissingPage } from '../components/wiki/wiki-missing-page';

export const metadata: Metadata = {
  title: '페이지를 찾을 수 없습니다',
  robots: { index: false, follow: false },
};

export default function NotFoundPage() {
  return <WikiMissingPage />;
}

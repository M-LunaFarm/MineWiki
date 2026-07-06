import { Suspense } from 'react';
import { SupportRedesignPage } from '../../../components/support/support-redesign-page';
import { createPageMetadata } from '../../../lib/metadata';

export const metadata = createPageMetadata({
  title: '문의 접수',
  description: 'MineWiki 이용 중 발생한 문제를 고객센터에 접수하세요.',
  path: '/support/new',
});

export default function SupportNewPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#111214] p-6 text-[#F4F4F5]">
          <div className="mx-auto max-w-7xl rounded-lg border border-[#34363A] bg-[#18191C] p-6 text-sm text-[#A7A9AF]">
            문의 접수 화면을 불러오는 중입니다.
          </div>
        </div>
      }
    >
      <SupportRedesignPage />
    </Suspense>
  );
}

import { Suspense } from 'react';
import { SupportRedesignPage } from '../../components/support/support-redesign-page';
import { createPageMetadata } from '../../lib/metadata';

export const metadata = createPageMetadata({
  title: '고객센터',
  description: 'MineWiki 이용, 서버 정보, 투표 이상, 결제 문의를 접수하세요.',
  path: '/support',
});

export default function SupportPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#111214] p-6 text-[#F4F4F5]">
          <div className="mx-auto max-w-7xl rounded-lg border border-[#34363A] bg-[#18191C] p-6 text-sm text-[#A7A9AF]">
            고객센터를 불러오는 중입니다.
          </div>
        </div>
      }
    >
      <SupportRedesignPage />
    </Suspense>
  );
}

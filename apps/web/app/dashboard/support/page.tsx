import { Suspense } from 'react';
import type { Metadata } from 'next';
import { SupportRedesignPage } from '../../../components/support/support-redesign-page';
import { createPageMetadata } from '../../../lib/metadata';

export const metadata: Metadata = createPageMetadata({
  title: '고객지원 관리',
  description: '문의 인박스, 배정 상태, 처리 상태를 확인하고 응답합니다.',
  path: '/dashboard/support',
  noIndex: true,
});

export default function DashboardSupportPage() {
  return (
    <Suspense fallback={<SupportConsoleFallback />}>
      <SupportRedesignPage mode="agent" />
    </Suspense>
  );
}

function SupportConsoleFallback() {
  return (
    <div className="min-h-screen bg-[#111214] p-6 text-[#F4F4F5]">
      <div className="mx-auto max-w-7xl rounded-lg border border-[#34363A] bg-[#18191C] p-6 text-sm text-[#A7A9AF]">
        고객지원 운영 콘솔을 불러오는 중입니다.
      </div>
    </div>
  );
}

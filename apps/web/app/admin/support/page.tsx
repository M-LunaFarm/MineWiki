import { Suspense, type ReactNode } from 'react';
import type { Metadata } from 'next';
import { Headphones, Inbox, ShieldCheck, TimerReset } from 'lucide-react';
import { SupportCenter } from '../../../components/support/support-center';

export const metadata: Metadata = {
  title: '지원 관리',
  robots: { index: false, follow: false },
};

export default function AdminSupportPage() {
  return (
    <div className="min-h-screen bg-[#121212] px-4 py-8 text-white">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="rounded-lg border border-[#2f3438] bg-[#181a1d]">
          <div className="flex flex-col gap-4 border-b border-[#2f3438] px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8f98a3]">
                Support Operations
              </p>
              <h1 className="mt-1 text-2xl font-semibold text-white">지원 관리</h1>
              <p className="mt-1 text-sm text-[#b8c0c8]">
                문의 인박스, 배정 상태, 처리 상태를 확인하고 응답하실 수 있습니다.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <SupportState icon={<Inbox className="h-4 w-4" />} label="인박스" value="전체" />
              <SupportState icon={<TimerReset className="h-4 w-4" />} label="새로고침" value="자동" />
              <SupportState icon={<ShieldCheck className="h-4 w-4" />} label="권한" value="상담원" />
            </div>
          </div>
          <div className="flex items-center gap-2 px-5 py-3 text-xs text-[#b8c0c8]">
            <Headphones className="h-4 w-4 text-[#13ec80]" />
            상담원 권한 또는 support.admin 권한이 있는 계정만 인박스를 볼 수 있습니다.
          </div>
        </section>

        <Suspense
          fallback={
            <div className="rounded-lg border border-[#2f3438] bg-[#181a1d] p-6 text-sm text-[#b8c0c8]">
              지원 콘솔을 불러오는 중입니다.
            </div>
          }
        >
          <SupportCenter mode="agent" />
        </Suspense>
      </div>
    </div>
  );
}

function SupportState({
  icon,
  label,
  value,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="min-w-[116px] rounded-md border border-[#30363d] bg-[#111315] px-3 py-2">
      <div className="flex items-center gap-2 text-[#8f98a3]">
        {icon}
        <span className="text-[11px] font-medium">{label}</span>
      </div>
      <p className="mt-1 text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

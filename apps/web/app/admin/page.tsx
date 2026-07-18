import Link from 'next/link';
import { BookOpenCheck, ClipboardList, Crown, Flag, GitMerge, Headphones, ShieldCheck, UserRoundX, UsersRound } from 'lucide-react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '관리자 센터',
  robots: { index: false, follow: false },
};

const ADMIN_TOOLS: ReadonlyArray<{
  readonly href: string;
  readonly title: string;
  readonly description: string;
  readonly icon: typeof UsersRound;
  readonly accent?: boolean;
}> = [
  {
    href: '/admin/billing',
    title: '서버 위키 요금제 권한',
    description: '프리미엄 레이아웃 권한을 부여·연장·회수하고 결제 참조와 감사 이력을 확인합니다.',
    icon: Crown,
  },
  {
    href: '/admin/reviews',
    title: '리뷰 신고',
    description: '신고된 서버 리뷰를 배정하고 해결·기각 및 공개 상태를 관리합니다.',
    icon: Flag,
  },
  {
    href: '/admin/users',
    title: '사용자 및 계정 보안',
    description: '계정 상태와 연결 로그인을 확인하고 역할 또는 긴급 정지·복구 조치를 관리합니다.',
    icon: UsersRound,
    accent: true,
  },
  {
    href: '/admin/account-deletions',
    title: '계정 종료 운영',
    description: '14일 유예, 자산 이전 조건과 계정 비식별화 처리 상태를 관리합니다.',
    icon: UserRoundX,
  },
  {
    href: '/admin/account-merges',
    title: '계정 연결 검토',
    description: 'Discord·이메일·Minecraft 로그인 충돌의 소유권 증거를 확인하고 안전하게 연결합니다.',
    icon: GitMerge,
  },
  {
    href: '/admin/support',
    title: '고객 지원',
    description: '계정, 인증, 서버 소유권과 플러그인 문의를 처리합니다.',
    icon: Headphones,
  },
  {
    href: '/admin/wiki',
    title: '위키 운영',
    description: '문서 보호, 리비전 공개 상태와 롤백 작업을 관리합니다.',
    icon: BookOpenCheck,
  },
  {
    href: '/admin/audit',
    title: '감사 이벤트',
    description: '보안과 운영 변경 이력을 민감정보 없이 추적합니다.',
    icon: ClipboardList,
  },
];

export default function AdminHomePage() {
  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[radial-gradient(circle_at_top_right,rgba(20,199,148,0.13),transparent_40%),#15181b] p-6 sm:p-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-[#35e5b7]">
              <ShieldCheck className="h-4 w-4" />
              MineWiki Operations
            </div>
            <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              관리자 센터
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
              계정 권한, 고객 지원, 위키 운영과 감사 기록을 한곳에서 관리합니다.
              모든 권한 변경은 기록되며 최소 권한 원칙을 따릅니다.
            </p>
          </div>
          <span className="w-fit rounded-full border border-[#35e5b7]/25 bg-[#35e5b7]/10 px-3 py-1.5 text-xs font-semibold text-[#79f2cf]">
            보호된 운영 영역
          </span>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {ADMIN_TOOLS.map((tool) => {
          const Icon = tool.icon;
          return (
            <Link
              key={tool.href}
              href={tool.href}
              className={`group rounded-2xl border p-6 transition duration-200 hover:-translate-y-0.5 ${
                tool.accent
                  ? 'border-[#35e5b7]/25 bg-[#10231e] hover:border-[#35e5b7]/45'
                  : 'border-white/[0.08] bg-[#17191c] hover:border-white/[0.16] hover:bg-[#1a1d20]'
              }`}
            >
              <span className="inline-flex rounded-xl border border-white/[0.08] bg-black/20 p-3 text-[#35e5b7]">
                <Icon className="h-5 w-5" />
              </span>
              <h2 className="mt-5 text-lg font-bold text-white">{tool.title}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-400">{tool.description}</p>
              <span className="mt-5 inline-flex text-xs font-bold text-[#35e5b7] group-hover:text-[#79f2cf]">
                관리 화면 열기 →
              </span>
            </Link>
          );
        })}
      </section>
    </div>
  );
}

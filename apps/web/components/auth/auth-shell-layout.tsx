'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

interface AuthShellLayoutProps {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}

export function AuthShellLayout({ title, description, children }: AuthShellLayoutProps) {
  return (
    <main className="min-h-screen bg-[#f4f0e6] text-[#1f2328]">
      <div className="grid min-h-screen lg:grid-cols-[minmax(320px,0.92fr)_minmax(420px,1.08fr)]">
        <aside className="flex flex-col justify-between border-b border-[#ded7c8] bg-[#fcfaf5] px-5 py-5 sm:px-8 lg:border-b-0 lg:border-r lg:px-10 lg:py-8">
          <div>
            <Link href="/" className="flex w-fit items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#13ec80] text-base font-bold text-[#0f1713]">
                L
              </div>
              <span className="text-lg font-semibold text-[#1f2328]">
                MineWiki<span className="text-[#16824d]">.kr</span>
              </span>
            </Link>

            <div className="mt-14 max-w-sm lg:mt-20">
              <p className="text-xs font-semibold text-[#5f6f64]">계정 보안</p>
              <h1 className="mt-3 text-3xl font-semibold leading-tight text-[#1f2328] sm:text-4xl">
                MineWiki 계정 접근
              </h1>
              <p className="mt-4 text-sm leading-6 text-[#5f6368]">
                로그인, 이메일 인증, 비밀번호 재설정은 계정 소유자 확인을 위해 등록된 이메일
                기준으로 처리됩니다.
              </p>
            </div>

            <div className="mt-10 space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6d6255]">
                확인 사항
              </h3>

              <GuideRow
                title="등록 이메일 사용"
                description="가입 시 사용한 이메일 주소로 인증 및 복구 메일이 발송됩니다."
                icon="alternate_email"
              />
              <GuideRow
                title="메일함 확인"
                description="수신함에 메일이 없으면 스팸함과 프로모션함을 함께 확인해 주세요."
                icon="mark_email_read"
              />
              <GuideRow
                title="공용 기기 주의"
                description="공용 기기에서는 로그인 상태 유지 기능을 사용하지 않는 것이 좋습니다."
                icon="devices"
              />
            </div>
          </div>

          <div className="mt-12 flex flex-wrap gap-5 border-t border-[#ded7c8] pt-6 text-xs text-[#6d6255]">
            <Link className="transition-colors hover:text-[#16824d]" href="/policies/terms">
              이용약관
            </Link>
            <Link className="transition-colors hover:text-[#16824d]" href="/policies/privacy">
              개인정보처리방침
            </Link>
            <Link className="transition-colors hover:text-[#16824d]" href="/support">
              고객센터
            </Link>
            <span className="ml-auto">MineWiki Corp.</span>
          </div>
        </aside>

        <section className="flex items-center justify-center px-4 py-10 sm:px-8 lg:px-12">
          <div className="w-full max-w-[440px] rounded-lg border border-[#ded7c8] bg-white p-6 shadow-[0_24px_70px_rgba(35,31,25,0.12)] sm:p-8">
            <div className="mb-7">
              <h2 className="text-2xl font-semibold text-[#1f2328]">{title}</h2>
              <p className="mt-2 text-sm leading-5 text-[#666b72]">{description}</p>
            </div>
            {children}
          </div>
        </section>
      </div>
    </main>
  );
}

function GuideRow(props: { title: string; description: string; icon: string }) {
  const { title, description, icon } = props;
  return (
    <div className="flex gap-3">
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[#e9f5ee]">
        <span className="material-symbols-outlined text-xl text-[#16824d]">{icon}</span>
      </div>
      <div>
        <h4 className="text-sm font-semibold text-[#252a30]">{title}</h4>
        <p className="mt-1 text-xs leading-5 text-[#666b72]">{description}</p>
      </div>
    </div>
  );
}

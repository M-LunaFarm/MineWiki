'use client';

import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, BookOpen, MailCheck, ShieldCheck } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

interface AuthShellLayoutProps {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}

export function AuthShellLayout({ title, description, children }: AuthShellLayoutProps) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-[#070a0c] text-white">
      <Image
        src="/images/minewiki-discovery-world.png"
        alt=""
        fill
        priority
        sizes="100vw"
        className="object-cover object-[64%_center] opacity-45"
      />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(7,10,12,.98)_0%,rgba(7,10,12,.88)_48%,rgba(7,10,12,.72)_100%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(0deg,#070a0c_0%,transparent_45%,rgba(7,10,12,.7)_100%)]" />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1440px] flex-col px-4 py-5 sm:px-7 lg:px-10 lg:py-7">
        <header className="flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3" aria-label="MineWiki 홈">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#35e5b7]/30 bg-[#35e5b7]/10 text-[#35e5b7]">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <span className="text-lg font-black tracking-[-.03em]">MineWiki<span className="text-[#35e5b7]">.kr</span></span>
          </Link>
          <Link href="/" className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs font-semibold text-slate-300 backdrop-blur-md transition hover:border-[#35e5b7]/30 hover:text-white">
            <ArrowLeft className="h-4 w-4" /> 홈으로
          </Link>
        </header>

        <div className="grid flex-1 items-center gap-10 py-6 lg:grid-cols-[minmax(0,1fr)_minmax(420px,520px)] lg:py-14">
          <section className="hidden max-w-2xl lg:block lg:pb-12">
            <p className="text-xs font-bold uppercase tracking-[.2em] text-[#35e5b7]">Secure MineWiki Account</p>
            <h1 className="mt-5 text-4xl font-black leading-[1.08] tracking-[-.045em] sm:text-5xl lg:text-6xl">
              하나의 계정으로<br /><span className="text-[#35e5b7]">서버와 지식</span>을 연결하세요.
            </h1>
            <p className="mt-5 max-w-xl text-sm leading-7 text-slate-300 sm:text-base">
              서버 리뷰, 투표 신뢰 인증, 위키 기여와 고객지원까지 MineWiki 공식 계정에서 안전하게 이어집니다.
            </p>

            <div className="mt-9 grid max-w-xl gap-3 sm:grid-cols-3">
              <GuideRow title="안전한 복구" description="등록 이메일 기반" icon={<MailCheck />} />
              <GuideRow title="검증된 활동" description="Minecraft 인증 연계" icon={<ShieldCheck />} />
              <GuideRow title="공식 지원" description="support@minewiki.kr" icon={<BookOpen />} />
            </div>
          </section>

          <section className="auth-flow w-full rounded-2xl border border-white/10 bg-[#09100f]/90 p-5 shadow-[0_32px_100px_rgba(0,0,0,.55)] backdrop-blur-xl sm:p-8">
            <div className="mb-7 border-b border-white/[0.08] pb-5">
              <p className="text-[11px] font-bold uppercase tracking-[.16em] text-[#35e5b7]">MineWiki Account</p>
              <h2 className="mt-2 text-2xl font-extrabold tracking-[-.025em] text-white">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-400">{description}</p>
            </div>
            {children}
          </section>
        </div>

        <footer className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/[0.08] pt-5 text-[11px] text-slate-500">
          <span>© 2026 MineWiki · minewiki.kr</span>
          <Link href="/policies/terms" className="hover:text-[#35e5b7]">이용약관</Link>
          <Link href="/policies/privacy" className="hover:text-[#35e5b7]">개인정보처리방침</Link>
          <Link href="/support" className="hover:text-[#35e5b7]">고객센터</Link>
          <a href="mailto:support@minewiki.kr" className="sm:ml-auto hover:text-[#35e5b7]">support@minewiki.kr</a>
        </footer>
      </div>
    </main>
  );
}

function GuideRow({ title, description, icon }: { readonly title: string; readonly description: string; readonly icon: ReactElement }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-black/25 p-3.5 backdrop-blur-sm">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#35e5b7]/10 text-[#35e5b7] [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      <h3 className="mt-3 text-xs font-bold text-white">{title}</h3>
      <p className="mt-1 text-[11px] text-slate-500">{description}</p>
    </div>
  );
}

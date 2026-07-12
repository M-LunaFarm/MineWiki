import Image from 'next/image';
import Link from 'next/link';

import { createPageMetadata } from '../../../lib/metadata';

export const metadata = createPageMetadata({
  title: '종이 질감 메인페이지 시안',
  description: 'MineWiki 서버 디렉터리의 종이 질감 메인페이지 디자인 시안 3종을 비교합니다.',
  path: '/design/home-paper',
  noIndex: true,
});

const concepts = [
  { number: 1, src: '/design/home-paper/concept-1.png' },
  { number: 2, src: '/design/home-paper/concept-2.png' },
  { number: 3, src: '/design/home-paper/concept-3.png' },
] as const;

export default function PaperHomeDesignPage() {
  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
      <header className="mx-auto max-w-3xl text-center">
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.22em] text-brand-300">MineWiki home design review</p>
        <h1 className="mt-3 font-display text-3xl font-extrabold tracking-tight text-white sm:text-4xl">종이 질감 메인페이지 시안</h1>
        <p className="mt-4 text-sm leading-7 text-slate-300 sm:text-base">상단 통계와 서버 등록 CTA를 덜어내고, 서버 검색과 비교에 집중한 세 가지 방향입니다. 이미지를 누르면 원본 크기로 열립니다.</p>
      </header>
      <div className="mt-10 space-y-10">
        {concepts.map((concept) => (
          <article key={concept.number} id={`concept-${concept.number}`} className="overflow-hidden rounded-2xl border border-white/10 bg-surface-200 shadow-2xl shadow-black/20">
            <div className="flex items-center gap-4 border-b border-white/10 p-5"><span className="flex size-10 items-center justify-center rounded-xl bg-brand-500 font-display text-lg font-extrabold text-white">{concept.number}</span><h2 className="font-display text-lg font-bold text-white">메인페이지 시안 {concept.number}</h2></div>
            <Link href={concept.src} target="_blank" aria-label={`${concept.number}번 메인페이지 시안 원본으로 열기`} className="group block bg-slate-950/50 p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-300">
              <Image src={concept.src} alt={`${concept.number}번 MineWiki 종이 질감 메인페이지 시안`} width={1440} height={1024} priority={concept.number === 1} className="h-auto w-full rounded-xl border border-white/5 transition group-hover:opacity-90" />
            </Link>
          </article>
        ))}
      </div>
      <p className="mt-10 text-center text-sm text-slate-400">확인 후 <span className="font-semibold text-slate-200">1, 2, 3</span> 중 하나를 골라주세요.</p>
    </main>
  );
}

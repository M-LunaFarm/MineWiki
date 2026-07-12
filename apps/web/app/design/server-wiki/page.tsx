import Image from 'next/image';
import Link from 'next/link';

import { createPageMetadata } from '../../../lib/metadata';

export const metadata = createPageMetadata({
  title: '서버 위키 디자인 시안',
  description: 'MineWiki 서버 위키의 GitBook 스타일 디자인 시안 3종을 비교합니다.',
  path: '/design/server-wiki',
  noIndex: true,
});

const concepts = [
  {
    number: 1,
    title: '정석 문서형',
    description: '정보 구조와 문서 탐색을 가장 선명하게 보여주는 GitBook 중심 구성',
    src: '/design/server-wiki/concept-1.png',
  },
  {
    number: 2,
    title: '서버 브랜딩형',
    description: '서버의 개성과 주요 정보를 문서 탐색 경험에 함께 담은 구성',
    src: '/design/server-wiki/concept-2.png',
  },
  {
    number: 3,
    title: '위키 집중형',
    description: '콘텐츠 가독성과 페이지 이동에 집중한 밀도 높은 문서 구성',
    src: '/design/server-wiki/concept-3.png',
  },
] as const;

export default function ServerWikiDesignPage() {
  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
      <header className="mx-auto max-w-3xl text-center">
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.22em] text-brand-300">
          MineWiki design review
        </p>
        <h1 className="mt-3 font-display text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
          서버 위키 디자인 시안
        </h1>
        <p className="mt-4 text-sm leading-7 text-slate-300 sm:text-base">
          GitBook처럼 문서를 빠르게 탐색하면서도 서버 정보와 브랜딩을 살리는 세 가지 방향입니다.
          이미지를 누르면 원본 크기로 확인할 수 있습니다.
        </p>
      </header>

      <div className="mt-10 grid gap-8 xl:grid-cols-3">
        {concepts.map((concept) => (
          <article
            key={concept.number}
            id={`concept-${concept.number}`}
            className="overflow-hidden rounded-2xl border border-white/10 bg-surface-200 shadow-2xl shadow-black/20"
          >
            <div className="flex min-h-28 items-start gap-4 border-b border-white/10 p-5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-500 font-display text-lg font-extrabold text-white shadow-lg shadow-brand-500/20">
                {concept.number}
              </span>
              <div>
                <h2 className="font-display text-lg font-bold text-white">{concept.title}</h2>
                <p className="mt-1 text-sm leading-6 text-slate-400">{concept.description}</p>
              </div>
            </div>

            <Link
              href={concept.src}
              target="_blank"
              className="group block bg-slate-950/50 p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-300"
              aria-label={`${concept.number}번 시안 원본으로 열기`}
            >
              <Image
                src={concept.src}
                alt={`${concept.number}번 MineWiki 서버 위키 디자인 시안`}
                width={1536}
                height={1024}
                priority={concept.number === 1}
                className="h-auto w-full rounded-xl border border-white/5 transition duration-200 group-hover:opacity-90"
              />
            </Link>
          </article>
        ))}
      </div>

      <p className="mt-10 text-center text-sm text-slate-400">
        마음에 드는 방향을 확인한 뒤 <span className="font-semibold text-slate-200">1, 2, 3</span> 중
        하나를 알려주세요.
      </p>
    </main>
  );
}

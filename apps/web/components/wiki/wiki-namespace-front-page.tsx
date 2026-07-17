import Link from 'next/link';
import { ArrowRight, BookOpen, Clock3, FileText, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WikiRecentChangeSummary, WikiSpecialDocumentResponse } from '../../lib/wiki-api';

interface WikiNamespaceFrontPageProps {
  readonly namespace: string;
  readonly routePath: string;
  readonly pageCount: number;
  readonly recent: readonly WikiRecentChangeSummary[];
  readonly featured: WikiSpecialDocumentResponse['items'];
  readonly showSearch: boolean;
}

const namespaceCopy: Record<string, { title: string; description: string }> = {
  main: { title: 'MineWiki 둘러보기', description: '마인크래프트 지식, 서버 정보와 편집 도움말을 한곳에서 찾아보세요.' },
  mod: { title: '모드 문서 둘러보기', description: '설치, 의존성, 장치, 설정과 버전 호환성 문서를 찾아보세요.' },
  modpack: { title: '모드팩 문서 둘러보기', description: '설치부터 진행 순서, 권장 사양과 서버 운영 정보를 모아봅니다.' },
  dev: { title: '개발 문서 둘러보기', description: 'Paper, Fabric, 데이터팩, 프로토콜과 자동화 자료를 찾아보세요.' },
  guide: { title: '가이드 둘러보기', description: '처음 시작하는 플레이부터 서버 이용과 문제 해결까지 단계별로 확인하세요.' },
  data: { title: '데이터 문서 둘러보기', description: '블록, 아이템, 엔티티, 식별자와 버전별 구조화 데이터를 확인하세요.' },
  help: { title: '도움말 둘러보기', description: '검색, 편집, 계정과 서버 위키 운영에 필요한 사용법을 확인하세요.' },
  project: { title: '프로젝트 문서 둘러보기', description: 'MineWiki의 운영 정책, 공지와 개선 작업을 확인하세요.' },
  template: { title: '틀 문서 둘러보기', description: '문서에서 재사용하는 정보 상자와 안내 컴포넌트의 사용법을 확인하세요.' },
  file: { title: '파일 문서 둘러보기', description: '이미지와 파일의 출처, 작성자와 라이선스 정보를 확인하세요.' },
};

export function WikiNamespaceFrontPage({ namespace, routePath, pageCount, recent, featured, showSearch }: WikiNamespaceFrontPageProps) {
  const copy = namespaceCopy[namespace] ?? namespaceCopy.main;
  const filteredFeatured = featured.filter((item) => item.routePath !== routePath).slice(0, 6);
  const featuredPaths = new Set(filteredFeatured.map((item) => item.routePath));
  const filteredRecent = recent.filter((item) => item.routePath !== routePath && !featuredPaths.has(item.routePath)).slice(0, 6);

  return (
    <section className="space-y-6 border-t border-white/10 pt-8" aria-labelledby="namespace-front-page-title">
      <div className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:flex-row sm:items-end sm:justify-between sm:p-6">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-300">Knowledge space</p>
          <h2 id="namespace-front-page-title" className="mt-2 text-2xl font-bold text-white sm:text-3xl">{copy.title}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-400">{copy.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.07] px-4 py-3">
          <FileText className="size-5 text-emerald-300" aria-hidden="true" />
          <div><strong className="block text-xl text-white">{pageCount.toLocaleString('ko-KR')}</strong><span className="text-xs text-slate-500">공개 문서</span></div>
        </div>
      </div>

      {showSearch ? (
        <form action="/search" method="get" role="search" aria-label={`${copy.title} 검색`} className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-black/15 p-4 sm:flex-row">
          <label className="sr-only" htmlFor={`namespace-search-${namespace}`}>검색어</label>
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-slate-600" aria-hidden="true" />
            <input id={`namespace-search-${namespace}`} type="search" name="q" autoComplete="off" placeholder={`${copy.title}에서 검색`} className="min-h-12 w-full rounded-xl border border-white/10 bg-black/20 pl-11 pr-4 text-white outline-none placeholder:text-slate-600 focus:border-emerald-300/60 focus:ring-2 focus:ring-emerald-300/10" />
          </div>
          <input type="hidden" name="namespace" value={namespace} />
          <button type="submit" className="btn-primary min-h-12 px-6">문서 검색</button>
        </form>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-2">
        <FrontPageList
          icon={<BookOpen className="size-4" aria-hidden="true" />}
          eyebrow="Start here"
          title="먼저 읽어볼 문서"
          empty="아직 추천할 문서가 충분하지 않습니다. 대문을 편집해 첫 안내를 연결해 주세요."
          items={filteredFeatured.map((item) => ({ path: item.routePath, title: item.displayTitle, meta: item.value ? `${item.value.toLocaleString('ko-KR')}자` : '핵심 문서' }))}
        />
        <FrontPageList
          icon={<Clock3 className="size-4" aria-hidden="true" />}
          eyebrow="Recently updated"
          title="최근 업데이트"
          empty="이 공간에는 아직 최근 변경이 없습니다."
          items={filteredRecent.map((item) => ({ path: item.routePath, title: item.title, meta: formatDate(item.createdAt) }))}
        />
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-dashed border-white/15 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div><h3 className="font-semibold text-white">문서를 더 알차게 만들어 주세요</h3><p className="mt-1 text-sm text-slate-500">잘못된 정보 수정, 관련 문서 연결과 출처 보강부터 시작할 수 있습니다.</p></div>
        <Link href="/wiki/special" className="btn-ghost min-h-11 shrink-0">특수 문서에서 할 일 찾기 <ArrowRight className="size-4" aria-hidden="true" /></Link>
      </div>
    </section>
  );
}

function FrontPageList({ icon, eyebrow, title, empty, items }: { readonly icon: ReactNode; readonly eyebrow: string; readonly title: string; readonly empty: string; readonly items: ReadonlyArray<{ readonly path: string; readonly title: string; readonly meta: string }> }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-start gap-3"><span className="grid size-9 place-items-center rounded-lg bg-emerald-400/10 text-emerald-300">{icon}</span><div><p className="text-[11px] font-bold uppercase tracking-[0.15em] text-emerald-300">{eyebrow}</p><h3 className="mt-1 text-lg font-bold text-white">{title}</h3></div></div>
      {items.length > 0 ? <ul className="mt-5 divide-y divide-white/[0.07]">{items.map((item) => <li key={item.path}><Link href={item.path} className="group flex min-h-14 items-center gap-3 py-3"><span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-300 group-hover:text-white">{item.title}</span><span className="shrink-0 text-xs text-slate-600">{item.meta}</span><ArrowRight className="size-3.5 shrink-0 text-slate-700 group-hover:text-emerald-300" aria-hidden="true" /></Link></li>)}</ul> : <p className="mt-5 rounded-lg border border-dashed border-white/10 px-4 py-5 text-sm leading-6 text-slate-500">{empty}</p>}
    </section>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' }).format(new Date(value));
}

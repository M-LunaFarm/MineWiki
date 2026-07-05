'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, FileText, LifeBuoy, Search } from 'lucide-react';

type PolicyCategory = 'all' | 'terms' | 'privacy' | 'operations' | 'voting';
type PolicyStatus = 'active' | 'upcoming';
type SortOption = 'latest' | 'importance';

interface PolicyDoc {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly category: Exclude<PolicyCategory, 'all'>;
  readonly version: string;
  readonly status: PolicyStatus;
  readonly updatedAt: string;
  readonly effectiveAt?: string;
  readonly href?: string;
  readonly importance: number;
}

const CATEGORY_LABELS: Record<PolicyCategory, string> = {
  all: '전체 문서',
  terms: '약관',
  privacy: '개인정보',
  operations: '운영',
  voting: '투표',
};

const DOCS: PolicyDoc[] = [
  {
    id: 'terms-core',
    title: '통합 이용약관',
    summary: '서비스 이용 조건, 권리·의무, 제재 및 분쟁 해결 절차를 규정합니다.',
    category: 'terms',
    version: 'v1.0',
    status: 'active',
    updatedAt: '2026-02-17',
    href: '/policies/terms',
    importance: 100,
  },
  {
    id: 'privacy-core',
    title: '개인정보 처리방침',
    summary: '최소 수집, 보관·파기, 위탁 및 정보주체 권리 행사 절차를 안내합니다.',
    category: 'privacy',
    version: 'v1.0',
    status: 'active',
    updatedAt: '2026-02-17',
    href: '/policies/privacy',
    importance: 95,
  },
  {
    id: 'youth',
    title: '청소년 보호 정책',
    summary: '제한 콘텐츠 기준, 긴급 신고 처리, 운영자 의무 및 제재 기준을 명시합니다.',
    category: 'operations',
    version: 'v1.0',
    status: 'active',
    updatedAt: '2026-02-17',
    href: '/policies/youth',
    importance: 80,
  },
  {
    id: 'server-ops',
    title: '서버 등록 및 운영 정책',
    summary: '등록·검증 절차, 브랜드/자산 사용, 외부 연동 및 제재 기준을 설명합니다.',
    category: 'operations',
    version: 'v1.0',
    status: 'active',
    updatedAt: '2026-02-17',
    href: '/policies/usage',
    importance: 90,
  },
  {
    id: 'vote-policy',
    title: '투표 무결성 정책',
    summary: '24시간 1회 원칙, 어뷰징 무효 처리, 이의 제기 절차를 안내합니다.',
    category: 'voting',
    version: 'v1.0',
    status: 'active',
    updatedAt: '2026-02-17',
    href: '/policies/voting',
    importance: 88,
  },
  {
    id: 'billing',
    title: '유료 서비스 정책',
    summary: '노출형 상품의 결제·취소·환불·장애 보상 기준을 규정합니다.',
    category: 'terms',
    version: 'v1.0',
    status: 'active',
    updatedAt: '2026-02-17',
    href: '/policies/billing',
    importance: 78,
  },
];

const CHANGELOG: Array<{ title: string; date: string; body: string; href: string }> = [];

function parseCategory(value: string | null): PolicyCategory {
  if (value === 'terms' || value === 'privacy' || value === 'operations' || value === 'voting') {
    return value;
  }
  return 'all';
}

function parseSort(value: string | null): SortOption {
  if (value === 'importance') {
    return 'importance';
  }
  return 'latest';
}

function formatDate(value: string) {
  const normalized = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (normalized) {
    return `${normalized[1]}.${normalized[2]}.${normalized[3]}.`;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}.${month}.${day}.`;
}

function statusLabel(status: PolicyStatus) {
  return status === 'active' ? '현행' : '개정 예정';
}

function PolicyRow({ doc }: { readonly doc: PolicyDoc }) {
  return (
    <article
      id={`doc-${doc.id}`}
      className="grid gap-4 border-t border-white/10 px-0 py-5 sm:grid-cols-[minmax(0,1fr)_9rem_8rem_6rem] sm:items-start"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-base font-semibold text-slate-50">{doc.title}</h2>
          <span className="font-mono text-[11px] text-slate-500">{doc.version}</span>
        </div>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">{doc.summary}</p>
      </div>

      <dl className="grid grid-cols-2 gap-3 text-xs sm:block sm:space-y-3">
        <div>
          <dt className="text-slate-500">분류</dt>
          <dd className="mt-1 text-slate-200">{CATEGORY_LABELS[doc.category]}</dd>
        </div>
        <div>
          <dt className="text-slate-500">상태</dt>
          <dd className="mt-1 text-slate-200">{statusLabel(doc.status)}</dd>
        </div>
      </dl>

      <dl className="grid grid-cols-2 gap-3 text-xs sm:block sm:space-y-3">
        <div>
          <dt className="text-slate-500">시행일</dt>
          <dd className="mt-1 font-mono text-slate-200">{formatDate(doc.effectiveAt ?? doc.updatedAt)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">개정일</dt>
          <dd className="mt-1 font-mono text-slate-200">{formatDate(doc.updatedAt)}</dd>
        </div>
      </dl>

      <div className="sm:text-right">
        {doc.href ? (
          <Link
            href={doc.href}
            className="inline-flex items-center gap-1 border-b border-slate-500 pb-0.5 text-sm font-medium text-slate-100 transition hover:border-emerald-300 hover:text-emerald-300"
          >
            전문 보기
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        ) : (
          <span className="text-xs text-slate-500">준비 중</span>
        )}
      </div>
    </article>
  );
}

interface PolicyCenterProps {
  readonly initialCategory: PolicyCategory;
  readonly initialKeyword: string;
  readonly initialSort: SortOption;
}

export function PolicyCenter({
  initialCategory = 'all',
  initialKeyword = '',
  initialSort = 'latest',
}: Partial<PolicyCenterProps>) {
  const [category, setCategory] = useState<PolicyCategory>(initialCategory);
  const [keyword, setKeyword] = useState(initialKeyword);
  const [sort, setSort] = useState<SortOption>(initialSort);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      setCategory(parseCategory(params.get('category')));
      setKeyword(params.get('q') ?? '');
      setSort(parseSort(params.get('sort')));
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (category === 'all') {
      params.delete('category');
    } else {
      params.set('category', category);
    }
    if (keyword.trim()) {
      params.set('q', keyword.trim());
    } else {
      params.delete('q');
    }
    if (sort === 'latest') {
      params.delete('sort');
    } else {
      params.set('sort', sort);
    }

    const nextQuery = params.toString();
    const nextUrl = nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname;
    if (nextUrl !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, '', nextUrl);
    }
  }, [category, keyword, sort]);

  const filteredDocs = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();
    const list = DOCS.filter((doc) => {
      if (category !== 'all' && doc.category !== category) {
        return false;
      }
      if (!normalized) {
        return true;
      }
      return `${doc.title} ${doc.summary}`.toLowerCase().includes(normalized);
    });

    return [...list].sort((a, b) => {
      if (sort === 'importance') {
        return b.importance - a.importance;
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [category, keyword, sort]);

  const activeDocs = filteredDocs.filter((doc) => doc.status === 'active');
  const upcomingDocs = filteredDocs.filter((doc) => doc.status === 'upcoming');

  return (
    <div className="mx-auto max-w-6xl">
      <header className="border-b border-white/10 pb-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-400">MineWiki 정책 문서</p>
            <h1 className="mt-2 text-3xl font-semibold text-slate-50 md:text-4xl">운영 정책 센터</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
              서비스 이용약관, 개인정보처리방침, 운영 기준 및 투표 정책을 문서 단위로 제공합니다.
              각 문서는 표시된 시행일을 기준으로 효력이 적용됩니다.
            </p>
          </div>

          <dl className="grid grid-cols-3 gap-px overflow-hidden border border-white/10 bg-white/10 text-center text-xs">
            <div className="bg-[#121212] px-4 py-3">
              <dt className="text-slate-500">문서</dt>
              <dd className="mt-1 font-mono text-base text-slate-100">{DOCS.length}</dd>
            </div>
            <div className="bg-[#121212] px-4 py-3">
              <dt className="text-slate-500">현행</dt>
              <dd className="mt-1 font-mono text-base text-slate-100">
                {DOCS.filter((doc) => doc.status === 'active').length}
              </dd>
            </div>
            <div className="bg-[#121212] px-4 py-3">
              <dt className="text-slate-500">기준일</dt>
              <dd className="mt-1 font-mono text-base text-slate-100">2026.02.17.</dd>
            </div>
          </dl>
        </div>
      </header>

      <div className="grid gap-8 py-8 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-28 lg:h-fit">
          <nav aria-label="정책 분류" className="border-y border-white/10 py-3">
            {(Object.keys(CATEGORY_LABELS) as PolicyCategory[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setCategory(key)}
                className={`flex w-full items-center justify-between border-l-2 px-3 py-2 text-left text-sm transition ${
                  key === category
                    ? 'border-emerald-300 bg-white/[0.04] text-slate-50'
                    : 'border-transparent text-slate-400 hover:bg-white/[0.03] hover:text-slate-100'
                }`}
              >
                <span>{CATEGORY_LABELS[key]}</span>
                <span className="font-mono text-[11px] text-slate-500">
                  {key === 'all' ? DOCS.length : DOCS.filter((doc) => doc.category === key).length}
                </span>
              </button>
            ))}
          </nav>

          <div className="mt-6 border border-white/10 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <LifeBuoy className="h-4 w-4 text-slate-400" />
              정책 문의
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-400">
              해석, 이의 제기, 결제 및 개인정보 문의는 고객센터에서 접수합니다.
            </p>
            <Link
              href="/support"
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-slate-100 underline decoration-slate-500 underline-offset-4 hover:text-emerald-300"
            >
              고객센터
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </aside>

        <main>
          <section className="border border-white/10">
            <div className="grid gap-3 border-b border-white/10 p-4 md:grid-cols-[minmax(0,1fr)_11rem]">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  type="text"
                  placeholder="정책명 또는 조항 키워드 검색"
                  className="h-10 w-full border border-white/10 bg-[#0f0f0f] py-2 pl-9 pr-3 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-slate-500"
                />
              </label>

              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as SortOption)}
                className="h-10 border border-white/10 bg-[#0f0f0f] px-3 text-sm text-slate-100 outline-none focus:border-slate-500"
              >
                <option value="latest">최신 개정순</option>
                <option value="importance">중요도순</option>
              </select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3 text-xs text-slate-400">
              <span>
                검색 결과 <span className="font-mono text-slate-100">{filteredDocs.length}</span>건
              </span>
              <span>문서 전문은 별도 페이지에서 확인할 수 있습니다.</span>
            </div>

            <div className="px-4">
              {filteredDocs.length === 0 ? (
                <div className="py-14 text-center">
                  <FileText className="mx-auto h-8 w-8 text-slate-600" />
                  <h2 className="mt-4 text-base font-semibold text-slate-100">
                    조건에 맞는 정책 문서가 없습니다
                  </h2>
                  <p className="mt-2 text-sm text-slate-400">검색어 또는 분류를 변경해 주세요.</p>
                </div>
              ) : null}

              {activeDocs.length > 0 ? (
                <section aria-labelledby="active-policy-heading">
                  <h2
                    id="active-policy-heading"
                    className="py-4 text-xs font-semibold text-slate-400"
                  >
                    현행 정책
                  </h2>
                  {activeDocs.map((doc) => (
                    <PolicyRow key={doc.id} doc={doc} />
                  ))}
                </section>
              ) : null}

              {upcomingDocs.length > 0 ? (
                <section aria-labelledby="upcoming-policy-heading" className="mt-6">
                  <h2
                    id="upcoming-policy-heading"
                    className="py-4 text-xs font-semibold text-slate-400"
                  >
                    개정 예정
                  </h2>
                  {upcomingDocs.map((doc) => (
                    <PolicyRow key={doc.id} doc={doc} />
                  ))}
                </section>
              ) : null}
            </div>
          </section>

          <section className="mt-8 border border-white/10 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-sm font-semibold text-slate-100">최근 변경 이력</h2>
                <p className="mt-1 text-xs text-slate-400">정책 변경 이력이 있는 경우 이 영역에 표시됩니다.</p>
              </div>
              <span className="font-mono text-xs text-slate-500">{CHANGELOG.length}건</span>
            </div>

            {CHANGELOG.length > 0 ? (
              <div className="mt-4 divide-y divide-white/10 border-t border-white/10">
                {CHANGELOG.map((item) => (
                  <article key={item.title} className="grid gap-2 py-4 text-sm sm:grid-cols-[8rem_1fr_5rem]">
                    <time className="font-mono text-xs text-slate-500">{formatDate(item.date)}</time>
                    <div>
                      <h3 className="font-semibold text-slate-100">{item.title}</h3>
                      <p className="mt-1 text-slate-400">{item.body}</p>
                    </div>
                    <Link className="text-xs text-slate-100 underline underline-offset-4" href={item.href}>
                      상세보기
                    </Link>
                  </article>
                ))}
              </div>
            ) : (
              <p className="mt-4 border-t border-white/10 pt-4 text-sm text-slate-400">
                이전 정책 변경 이력은 제공하지 않습니다.
              </p>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

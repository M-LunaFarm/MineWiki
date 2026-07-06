import Link from 'next/link';
import { Search } from 'lucide-react';
import { searchWiki } from '../../lib/wiki-api';

interface SearchPageProps {
  readonly searchParams: Promise<{
    q?: string;
    namespace?: string;
  }>;
}

export const metadata = {
  title: '위키 검색',
  description: 'MineWiki 문서 제목과 본문을 검색합니다.',
};

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const query = params.q?.trim() ?? '';
  const namespace = params.namespace?.trim() ?? '';
  const results = query ? await searchWiki({ q: query, namespace: namespace || undefined, limit: 30 }) : [];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <header className="border-b border-white/10 pb-6">
        <h1 className="text-3xl font-bold text-white">위키 검색</h1>
      </header>

      <form action="/search" className="grid gap-3 sm:grid-cols-[1fr_12rem_auto]">
        <label className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            name="q"
            type="search"
            defaultValue={query}
            placeholder="문서 제목, 경로, 본문 검색"
            className="h-11 w-full rounded-md border border-white/10 bg-white/[0.03] pl-10 pr-3 text-sm text-white placeholder:text-slate-500 focus:border-emerald-300/50 focus:outline-none"
          />
        </label>
        <select
          name="namespace"
          defaultValue={namespace}
          className="h-11 rounded-md border border-white/10 bg-[#15171b] px-3 text-sm text-white focus:border-emerald-300/50 focus:outline-none"
        >
          <option value="">전체</option>
          <option value="main">일반</option>
          <option value="server">서버</option>
          <option value="mod">모드</option>
          <option value="modpack">모드팩</option>
          <option value="dev">개발</option>
          <option value="help">도움말</option>
          <option value="project">프로젝트</option>
          <option value="template">틀</option>
          <option value="file">파일</option>
        </select>
        <button type="submit" className="btn-primary h-11">
          검색
        </button>
      </form>

      <section className="space-y-3">
        {query ? (
          <p className="text-sm text-slate-400">{results.length}개 결과</p>
        ) : (
          <p className="text-sm text-slate-400">검색어를 입력하세요.</p>
        )}
        <div className="divide-y divide-white/10 border-y border-white/10">
          {results.map((result) => (
            <Link
              key={result.pageId}
              href={result.routePath}
              className="block px-1 py-5 transition hover:bg-white/[0.03]"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="chip chip-muted">{result.namespace}</span>
                <span>{result.routePath}</span>
                <span>{new Date(result.updatedAt).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}</span>
              </div>
              <h2 className="mt-2 text-lg font-semibold text-white">{result.displayTitle}</h2>
              <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-300">{result.snippet}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { FilePlus2, FileQuestion, History, Search } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { buildCategoryWikiToolPath, buildServerWikiToolPath, buildStandardWikiToolPath } from '../../lib/wiki-routes.mjs';
import { useAuth } from '../providers/auth-context';

const STANDARD_WIKI_PATH = /^\/(?:wiki|mod|modpack|dev|guide|data|help|project|template|file)\/.+/u;

export function WikiMissingPage() {
  const pathname = usePathname();
  const { account, loading } = useAuth();
  const editPath = missingWikiEditPath(pathname);
  const title = missingWikiTitle(pathname);

  if (!editPath) {
    return (
      <main className="mx-auto flex min-h-[55vh] w-full max-w-3xl items-center px-4 py-16">
        <section className="surface-flat w-full p-6 sm:p-8">
          <FileQuestion className="size-9 text-slate-400" aria-hidden="true" />
          <h1 className="mt-4 text-2xl font-bold text-white">페이지를 찾을 수 없습니다</h1>
          <p className="mt-3 text-sm leading-6 text-slate-400">주소가 바뀌었거나 공개되지 않은 페이지입니다.</p>
          <Link href="/" className="btn-primary mt-6 min-h-11">MineWiki 홈으로</Link>
        </section>
      </main>
    );
  }

  const searchHref = `/search?q=${encodeURIComponent(title)}`;
  const createHref = account ? editPath : `/login?returnTo=${encodeURIComponent(editPath)}`;
  return (
    <main className="mx-auto flex min-h-[55vh] w-full max-w-3xl items-center px-4 py-12 sm:py-16">
      <section className="surface-flat w-full p-6 sm:p-8">
        <div className="flex size-11 items-center justify-center rounded-xl border border-amber-300/20 bg-amber-300/10 text-amber-200">
          <FileQuestion className="size-6" aria-hidden="true" />
        </div>
        <p className="mt-5 text-xs font-semibold uppercase tracking-[0.16em] text-amber-200">문서 없음</p>
        <h1 className="mt-2 break-words text-2xl font-bold text-white sm:text-3xl">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          아직 작성되지 않았거나 삭제된 문서입니다. 같은 주제의 문서를 먼저 검색하거나 새 문서를 작성할 수 있습니다.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Link href={searchHref} className="btn-secondary min-h-11 gap-2">
            <Search className="size-4" aria-hidden="true" /> 비슷한 문서 검색
          </Link>
          {!loading ? (
            <Link href={createHref} className="btn-primary min-h-11 gap-2">
              <FilePlus2 className="size-4" aria-hidden="true" />
              {account ? '새 문서 작성' : '로그인하고 작성'}
            </Link>
          ) : null}
          <Link href="/wiki/deleted" className="btn-secondary min-h-11 gap-2">
            <History className="size-4" aria-hidden="true" /> 삭제 문서 확인
          </Link>
        </div>
      </section>
    </main>
  );
}

export function missingWikiEditPath(pathname: string): string | null {
  if (pathname.includes('/_tools/')) return null;
  try {
    if (pathname.startsWith('/wiki/category/')) return buildCategoryWikiToolPath(pathname, 'edit');
    if (pathname.startsWith('/server/') || pathname.startsWith('/serverWiki/')) return buildServerWikiToolPath(pathname, 'edit');
    if (STANDARD_WIKI_PATH.test(pathname)) return buildStandardWikiToolPath(pathname, 'edit');
  } catch {
    return null;
  }
  return null;
}

export function missingWikiTitle(pathname: string): string {
  const segment = pathname.split('/').filter(Boolean).at(-1) ?? '문서';
  try {
    return decodeURIComponent(segment).replaceAll('_', ' ');
  } catch {
    return segment.replaceAll('_', ' ');
  }
}

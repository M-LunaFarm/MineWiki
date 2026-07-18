import { WikiRecentDiscussionsClient } from '../../../components/wiki/wiki-recent-discussions-client';
import Link from 'next/link';
import { normalizeWikiRecentDiscussionFilters } from '../../../lib/wiki-discussion-status.mjs';

interface PageProps { readonly searchParams: Promise<{ readonly status?: string; readonly sort?: string }>; }

export default async function WikiRecentDiscussionsPage({ searchParams }: PageProps) {
  const filters = normalizeWikiRecentDiscussionFilters(await searchParams) as {
    status: 'all' | 'active' | 'open' | 'paused' | 'closed';
    sort: 'newest' | 'oldest';
  };
  return <section className="mx-auto w-full max-w-5xl space-y-7 px-4 py-8 sm:px-6 lg:px-8">
    <header className="border-b border-white/10 pb-6">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">Discussions</p>
      <h1 className="mt-3 text-3xl font-bold text-white">최근 토론</h1>
      <p className="mt-3 text-sm leading-6 text-slate-400">접근 권한이 있는 문서의 토론을 상태와 활동 순서로 찾아봅니다.</p>
      <nav className="mt-5 flex flex-wrap gap-2"><Link href="/wiki/discussions" className="chip chip-accent">최근 토론</Link><Link href="/wiki/edit-requests" className="chip chip-muted">편집 요청</Link></nav>
    </header>
    <WikiRecentDiscussionsClient status={filters.status} sort={filters.sort} />
  </section>;
}

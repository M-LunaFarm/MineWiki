import Link from 'next/link';
import { fetchWikiRecent } from '../../lib/wiki-server-api';

export const dynamic = 'force-dynamic';
export const revalidate = 30;

export default async function RecentChangesPage() {
  const changes = await fetchWikiRecent();

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="border-b border-white/10 pb-6">
        <h1 className="text-3xl font-bold text-white">최근 변경</h1>
        <p className="mt-3 text-sm text-slate-400">공개 문서의 최신 편집 기록입니다.</p>
      </header>
      <section className="divide-y divide-white/10 border border-white/10 bg-[#111821]">
        {changes.map((change) => (
          <article key={change.id} className="grid gap-3 px-4 py-4 md:grid-cols-[1fr_auto] md:items-center">
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap gap-2">
                <span className="chip chip-accent">{change.namespaceCode}</span>
                <span className="chip chip-muted">{change.changeType}</span>
                {change.isMinor ? <span className="chip chip-muted">minor</span> : null}
              </div>
              <h2 className="truncate text-base font-semibold text-white">{change.title}</h2>
              <p className="mt-1 text-sm text-slate-400">{change.summary ?? '요약 없음'}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-400 md:justify-end">
              <span>{formatDate(change.createdAt)}</span>
              {change.revisionId ? (
                <Link href={`/wiki/revision/${change.revisionId}`} className="chip chip-muted">
                  rev
                </Link>
              ) : null}
            </div>
          </article>
        ))}
        {changes.length === 0 ? (
          <p className="px-4 py-8 text-sm text-slate-400">표시할 최근 변경이 없습니다.</p>
        ) : null}
      </section>
    </main>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul'
  }).format(new Date(value));
}

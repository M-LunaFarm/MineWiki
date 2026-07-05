import Link from 'next/link';
import { fetchWikiRevision } from '../../../../lib/wiki-api';

interface PageProps {
  readonly params: Promise<{ revisionId: string }>;
}

export default async function WikiRevisionPage({ params }: PageProps) {
  const { revisionId } = await params;
  const revision = await fetchWikiRevision(revisionId);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <Link href="/recent" className="hover:text-emerald-200">
          최근 변경
        </Link>
        <span>/</span>
        <span className="text-slate-200">rev {revision.revisionNo}</span>
      </nav>
      <header className="border-b border-white/10 pb-6">
        <div className="mb-4 flex flex-wrap gap-2">
          <span className="chip chip-accent">revision</span>
          {revision.isMinor ? <span className="chip chip-muted">minor</span> : null}
          <span className="chip chip-muted">{revision.visibility}</span>
        </div>
        <h1 className="text-3xl font-bold text-white">Wiki revision {revision.revisionNo}</h1>
        <p className="mt-3 text-sm text-slate-400">
          page {revision.pageId} · {formatDate(revision.createdAt)} · {revision.editSummary ?? '요약 없음'}
        </p>
      </header>
      <section className="border border-white/10 bg-[#111821] p-4">
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap text-sm leading-6 text-slate-200">
          {revision.contentRaw}
        </pre>
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

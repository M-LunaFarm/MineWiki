import Link from 'next/link';
import { fetchWikiRevisionDiff } from '../../../../../lib/wiki-server-api';

interface PageProps {
  readonly params: Promise<{ leftId: string; rightId: string }>;
}

export default async function WikiDiffPage({ params }: PageProps) {
  const { leftId, rightId } = await params;
  const diff = await fetchWikiRevisionDiff(leftId, rightId);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <Link href={`/wiki/revision/${diff.left.id}`} className="hover:text-emerald-200">
          rev {diff.left.revisionNo}
        </Link>
        <span>-&gt;</span>
        <Link href={`/wiki/revision/${diff.right.id}`} className="hover:text-emerald-200">
          rev {diff.right.revisionNo}
        </Link>
      </nav>
      <header className="border-b border-white/10 pb-6">
        <h1 className="text-3xl font-bold text-white">Diff</h1>
        <p className="mt-3 text-sm text-slate-400">
          page {diff.right.pageId} · {formatDate(diff.right.createdAt)}
        </p>
      </header>
      <section className="overflow-x-auto border border-white/10 bg-[#111821]">
        <table className="min-w-full text-left font-mono text-sm">
          <tbody>
            {diff.hunks.map((hunk, index) => (
              <tr key={`${index}-${hunk.type}`} className={rowTone(hunk.type)}>
                <td className="w-20 px-3 py-1 text-right text-slate-500">{hunk.leftLine ?? ''}</td>
                <td className="w-20 px-3 py-1 text-right text-slate-500">{hunk.rightLine ?? ''}</td>
                <td className="w-8 px-3 py-1 text-center text-slate-400">{mark(hunk.type)}</td>
                <td className="px-3 py-1 whitespace-pre-wrap">{hunk.line}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function mark(type: 'added' | 'context' | 'removed'): string {
  if (type === 'added') return '+';
  if (type === 'removed') return '-';
  return ' ';
}

function rowTone(type: 'added' | 'context' | 'removed'): string {
  if (type === 'added') return 'bg-emerald-500/10 text-emerald-100';
  if (type === 'removed') return 'bg-red-500/10 text-red-100';
  return 'text-slate-300';
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul'
  }).format(new Date(value));
}

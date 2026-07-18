import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchServerWikiReleaseCandidateDiff } from '../../../../../../../lib/wiki-server-api';

export const metadata: Metadata = { title: '릴리스 후보 본문 비교', robots: { index: false, follow: false } };

export default async function ServerWikiReleaseCandidateDiffPage({
  params,
}: {
  readonly params: Promise<{ candidateId: string; pageId: string }>;
}) {
  const { candidateId, pageId } = await params;
  if (!/^[1-9][0-9]{0,19}$/u.test(candidateId) || !/^[1-9][0-9]{0,19}$/u.test(pageId)) notFound();
  const diff = await fetchServerWikiReleaseCandidateDiff(candidateId, pageId);
  const returnTo = `/wiki/release-reviews/${candidateId}`;
  return <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
    <nav className="text-sm text-slate-400"><Link href={returnTo} className="hover:text-emerald-200">릴리스 후보 #{candidateId}로 돌아가기</Link></nav>
    <header className="border-b border-white/10 pb-6"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">Immutable candidate diff</p><h1 className="mt-3 text-3xl font-bold text-white">저장 후보 본문 비교</h1><p className="mt-3 text-sm text-slate-400">문서 {pageId} · 제출된 기준 판과 후보 판만 비교합니다.</p></header>
    <section className="overflow-x-auto border border-white/10 bg-[#111821]">
      <table className="min-w-full text-left font-mono text-sm"><tbody>{diff.hunks.map((hunk, index) => <tr key={`${index}-${hunk.type}`} className={rowTone(hunk.type)}><td className="w-20 px-3 py-1 text-right text-slate-500">{hunk.leftLine ?? ''}</td><td className="w-20 px-3 py-1 text-right text-slate-500">{hunk.rightLine ?? ''}</td><td className="w-8 px-3 py-1 text-center text-slate-400">{mark(hunk.type)}</td><td className="whitespace-pre-wrap px-3 py-1">{hunk.line}</td></tr>)}</tbody></table>
    </section>
  </main>;
}

function mark(type: 'added' | 'context' | 'removed') { return type === 'added' ? '+' : type === 'removed' ? '-' : ' '; }
function rowTone(type: 'added' | 'context' | 'removed') { return type === 'added' ? 'bg-emerald-500/10 text-emerald-100' : type === 'removed' ? 'bg-red-500/10 text-red-100' : 'text-slate-300'; }

import type { Metadata } from 'next';
import Link from 'next/link';
import { ServerWikiReleaseReviewQueueClient } from '../../../components/wiki/server-wiki-release-review-client';

export const metadata: Metadata = { title: '서버 위키 릴리스 검토', robots: { index: false, follow: false } };

export default function ServerWikiReleaseReviewQueuePage() {
  return <section className="mx-auto w-full max-w-5xl space-y-7"><header className="border-b border-white/10 pb-6"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">Release reviews</p><h1 className="mt-3 text-3xl font-bold text-white">서버 위키 릴리스 검토</h1><p className="mt-3 text-sm leading-6 text-slate-400">reviewer로 지정된 서버의 불변 릴리스 후보를 서버 ID 없이 한곳에서 확인합니다.</p><nav className="mt-5 flex flex-wrap gap-2"><Link href="/wiki/edit-requests?status=open&scope=reviewable" className="chip chip-muted">편집 요청 검토</Link><Link href="/wiki/release-reviews" className="chip chip-accent">릴리스 검토</Link></nav></header><ServerWikiReleaseReviewQueueClient /></section>;
}

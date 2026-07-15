import type { Metadata } from 'next';
import Link from 'next/link';
import { WikiEditRequestQueueClient } from '../../../components/wiki/wiki-edit-request-queue-client';

export const metadata: Metadata = { title: '편집 요청 검토', robots: { index: false, follow: false } };

interface PageProps {
  readonly searchParams: Promise<{ status?: string; scope?: string; namespace?: string }>;
}

const STATUSES = new Set(['open', 'all', 'pending', 'reviewing', 'stale', 'accepted', 'rejected', 'closed']);
const NAMESPACES = ['', 'main', 'server', 'mod', 'modpack', 'dev', 'guide', 'data', 'help', 'project', 'template', 'user', 'category', 'file'];

export default async function WikiEditRequestQueuePage({ searchParams }: PageProps) {
  const query = await searchParams;
  const status = STATUSES.has(query.status ?? '') ? query.status! : 'open';
  const scope = query.scope === 'mine' ? 'mine' : 'all';
  const namespace = NAMESPACES.includes(query.namespace ?? '') ? query.namespace ?? '' : '';
  return <section className="mx-auto w-full max-w-5xl space-y-7">
    <header className="border-b border-white/10 pb-6">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">Review queue</p>
      <h1 className="mt-3 text-3xl font-bold text-white">편집 요청 검토</h1>
      <p className="mt-3 text-sm leading-6 text-slate-400">접근할 수 있는 모든 문서의 검토 대기·만료 요청을 한곳에서 확인합니다.</p>
      <nav className="mt-5 flex flex-wrap gap-2"><Link href="/wiki/discussions" className="chip chip-muted">최근 토론</Link><Link href="/wiki/edit-requests" className="chip chip-accent">편집 요청</Link></nav>
    </header>
    <form method="get" className="surface-flat grid gap-3 p-4 sm:grid-cols-3 sm:p-5">
      <label className="grid gap-2 text-xs font-semibold text-slate-400">상태<select name="status" defaultValue={status} className="input min-h-11"><option value="open">열린 요청</option><option value="pending">검토 대기</option><option value="stale">기준 판 만료</option><option value="accepted">승인됨</option><option value="rejected">반려됨</option><option value="closed">닫힘</option><option value="all">전체</option></select></label>
      <label className="grid gap-2 text-xs font-semibold text-slate-400">범위<select name="scope" defaultValue={scope} className="input min-h-11"><option value="all">볼 수 있는 모든 요청</option><option value="mine">내 요청</option></select></label>
      <label className="grid gap-2 text-xs font-semibold text-slate-400">이름공간<select name="namespace" defaultValue={namespace} className="input min-h-11"><option value="">전체</option>{NAMESPACES.filter(Boolean).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <button className="btn-primary min-h-11 sm:col-span-3 sm:w-fit">필터 적용</button>
    </form>
    <WikiEditRequestQueueClient status={status} scope={scope} namespace={namespace} />
  </section>;
}

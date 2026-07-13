import { WikiRecentDiscussionsClient } from '../../../components/wiki/wiki-recent-discussions-client';

export default function WikiRecentDiscussionsPage() {
  return <section className="mx-auto w-full max-w-5xl space-y-7">
    <header className="border-b border-white/10 pb-6">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">Discussions</p>
      <h1 className="mt-3 text-3xl font-bold text-white">최근 토론</h1>
      <p className="mt-3 text-sm leading-6 text-slate-400">접근 권한이 있는 문서에서 최근 활동한 토론을 시간순으로 확인합니다.</p>
    </header>
    <WikiRecentDiscussionsClient />
  </section>;
}

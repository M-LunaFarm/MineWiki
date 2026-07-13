import { WikiWatchlistClient } from '../../../components/wiki/wiki-watchlist-client';

export default function WikiWatchlistPage() {
  return (
    <section className="mx-auto w-full max-w-5xl space-y-7">
      <header className="border-b border-white/10 pb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">Watchlist</p>
        <h1 className="mt-3 text-3xl font-bold text-white">관심 문서</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">지켜보는 문서의 최신 변경과 읽지 않은 업데이트를 한곳에서 확인합니다.</p>
      </header>
      <WikiWatchlistClient />
    </section>
  );
}

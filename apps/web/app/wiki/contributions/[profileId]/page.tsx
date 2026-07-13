import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchWikiContributions } from '../../../../lib/wiki-server-api';

interface PageProps {
  readonly params: Promise<{ profileId: string }>;
  readonly searchParams: Promise<{ cursor?: string }>;
}

export default async function WikiContributionsPage({ params, searchParams }: PageProps) {
  const [{ profileId }, query] = await Promise.all([params, searchParams]);
  const result = await fetchWikiContributions(profileId, query.cursor).catch(() => null);
  if (!result) notFound();
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <Link href="/recent" className="hover:text-emerald-200">최근 변경</Link><span>/</span><span className="text-slate-200">기여 내역</span>
      </nav>
      <header className="border-b border-white/10 pb-6">
        <h1 className="text-3xl font-bold text-white">{result.profile.displayName}의 기여</h1>
        <p className="mt-3 text-sm text-slate-400">@{result.profile.username} · 읽을 권한이 있는 문서의 공개 변경만 표시됩니다.</p>
      </header>
      <section className="divide-y divide-white/10 border border-white/10 bg-[#111821]">
        {result.items.map((item) => (
          <article key={item.id} className="p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="chip chip-muted">{item.changeType}</span>
              {item.isMinor ? <span className="chip chip-muted">minor</span> : null}
              <Link href={item.routePath} className="font-semibold text-emerald-200 hover:underline">{item.title}</Link>
            </div>
            <p className="mt-3 text-sm text-slate-300">{item.summary ?? '요약 없음'}</p>
            <p className="mt-2 text-xs text-slate-500">{formatDate(item.createdAt)} · {item.namespace}</p>
          </article>
        ))}
        {result.items.length === 0 ? <p className="p-6 text-sm text-slate-400">표시할 공개 기여가 없습니다.</p> : null}
      </section>
      {result.nextCursor ? <Link href={`/wiki/contributions/${profileId}?cursor=${result.nextCursor}`} className="btn-secondary self-start">다음 변경</Link> : null}
    </main>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value));
}

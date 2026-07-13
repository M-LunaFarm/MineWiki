import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchWikiPageByPath, fetchWikiRevisions } from '../../lib/wiki-server-api';
import { buildWikiRoutePath } from '../../lib/wiki-routes.mjs';
import { WikiRevertButton } from './wiki-revert-button';

interface WikiHistoryRoutePageProps {
  readonly prefix: 'wiki' | 'mod' | 'modpack' | 'server' | 'dev' | 'help' | 'project' | 'file';
  readonly segments?: string[];
}

export async function WikiHistoryRoutePage({ prefix, segments = [] }: WikiHistoryRoutePageProps) {
  const routePath = buildWikiRoutePath(prefix, segments);
  const page = await fetchWikiPageByPath(routePath);
  if (!page) {
    notFound();
  }
  const revisions = await fetchWikiRevisions(page.id);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <Link href={routePath} className="hover:text-emerald-200">
          {page.displayTitle}
        </Link>
        <span>/</span>
        <span className="text-slate-200">역사</span>
      </nav>
      <header className="border-b border-white/10 pb-6">
        <h1 className="text-3xl font-bold text-white">{page.displayTitle} 역사</h1>
        <p className="mt-3 text-sm text-slate-400">{routePath}</p>
      </header>
      <section className="space-y-3 sm:hidden">
        {revisions.map((revision, index) => {
          const previous = revisions[index + 1];
          return (
            <article key={revision.id} className="border border-white/10 bg-[#111821] p-4">
              <div className="flex items-center justify-between gap-3">
                <strong className="text-white">rev {revision.revisionNo}</strong>
                <time className="text-xs text-slate-500">{formatDate(revision.createdAt)}</time>
              </div>
              <p className="mt-3 break-words text-sm text-slate-300">{revision.editSummary ?? '요약 없음'}</p>
              <p className="mt-2 text-xs text-slate-500">편집자 {revision.createdBy ?? 'unknown'}{revision.isMinor ? ' · minor' : ''}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link href={`/wiki/revision/${revision.id}`} className="chip chip-accent">보기</Link>
                {previous ? <Link href={`/wiki/diff/${previous.id}/${revision.id}`} className="chip chip-muted">diff</Link> : null}
                {revision.id !== page.revision.id ? (
                  <WikiRevertButton
                    pageId={page.id}
                    revisionId={revision.id}
                    revisionNo={revision.revisionNo}
                    currentRevisionId={page.revision.id}
                    routePath={routePath}
                  />
                ) : null}
              </div>
            </article>
          );
        })}
      </section>
      <section className="hidden overflow-x-auto border border-white/10 bg-[#111821] sm:block">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-white/10 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">판</th>
              <th className="px-4 py-3">요약</th>
              <th className="px-4 py-3">편집자</th>
              <th className="px-4 py-3">시간</th>
              <th className="px-4 py-3">작업</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10 text-slate-300">
            {revisions.map((revision, index) => {
              const previous = revisions[index + 1];
              return (
                <tr key={revision.id}>
                  <td className="px-4 py-3 font-semibold text-white">rev {revision.revisionNo}</td>
                  <td className="px-4 py-3">
                    {revision.isMinor ? <span className="chip chip-muted mr-2">minor</span> : null}
                    {revision.editSummary ?? '요약 없음'}
                  </td>
                  <td className="px-4 py-3">{revision.createdBy ?? 'unknown'}</td>
                  <td className="px-4 py-3">{formatDate(revision.createdAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      <Link href={`/wiki/revision/${revision.id}`} className="chip chip-accent">
                        보기
                      </Link>
                      {previous ? (
                        <Link href={`/wiki/diff/${previous.id}/${revision.id}`} className="chip chip-muted">
                          diff
                        </Link>
                      ) : null}
                      {revision.id !== page.revision.id ? (
                        <WikiRevertButton
                          pageId={page.id}
                          revisionId={revision.id}
                          revisionNo={revision.revisionNo}
                          currentRevisionId={page.revision.id}
                          routePath={routePath}
                        />
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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

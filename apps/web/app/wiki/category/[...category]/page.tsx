import Link from 'next/link';
import { ArrowRight, FolderTree } from 'lucide-react';
import { fetchWikiCategory } from '../../../../lib/wiki-server-api';

interface PageProps {
  readonly params: Promise<{ category: string[] }>;
  readonly searchParams: Promise<{ namespace?: string; cursor?: string }>;
}

const NAMESPACES = ['', 'main', 'server', 'mod', 'modpack', 'dev', 'help', 'project', 'file'];

export const dynamic = 'force-dynamic';

export default async function WikiCategoryPage({ params, searchParams }: PageProps) {
  const route = await params;
  const query = await searchParams;
  const category = route.category.map(decodeURIComponent).join('/').replace(/_/g, ' ');
  const namespace = NAMESPACES.includes(query.namespace ?? '') ? query.namespace ?? '' : '';
  const result = await fetchWikiCategory({ category, namespace: namespace || undefined, cursor: query.cursor, limit: 30 });

  return (
    <main className="mx-auto w-full max-w-5xl space-y-7 px-4 py-8 sm:px-6 lg:px-8">
      <header className="border-b border-white/10 pb-6">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.18em] text-emerald-300"><FolderTree className="size-4" /> Category</p>
        <h1 className="mt-3 break-words text-3xl font-bold text-white">분류:{result.category}</h1>
        <p className="mt-3 text-sm text-slate-400">현재 공개 판에 이 분류가 지정된 문서입니다. 읽기 권한이 있는 문서만 표시됩니다.</p>
      </header>

      <form action={`/wiki/category/${encodeURIComponent(result.category)}`} className="flex flex-wrap items-end gap-3 border border-white/10 bg-[#111821] p-4">
        <label className="min-w-48 flex-1 text-xs font-semibold text-slate-400">이름공간
          <select name="namespace" defaultValue={namespace} className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-white">
            <option value="">전체</option>
            {NAMESPACES.filter(Boolean).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <button type="submit" className="btn-secondary h-11">적용</button>
      </form>

      <section className="divide-y divide-white/10 border border-white/10 bg-[#111821]" aria-label={`${result.category} 분류 문서`}>
        {result.items.map((item) => (
          <Link key={item.id} href={item.routePath} className="flex min-h-16 items-center justify-between gap-4 p-4 transition hover:bg-white/[0.035] sm:p-5">
            <div className="min-w-0">
              <p className="truncate font-semibold text-white">{item.displayTitle}</p>
              <p className="mt-1 truncate text-xs text-slate-500">{item.namespace}:{item.title}</p>
            </div>
            <ArrowRight className="size-4 shrink-0 text-slate-500" />
          </Link>
        ))}
        {result.items.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">이 분류에 표시할 수 있는 문서가 없습니다.</p> : null}
      </section>

      {result.nextCursor ? (
        <Link href={nextHref(result.category, namespace, result.nextCursor)} className="btn-secondary mx-auto flex h-11 w-fit">다음 문서</Link>
      ) : null}
    </main>
  );
}

function nextHref(category: string, namespace: string, cursor: string) {
  const params = new URLSearchParams({ cursor });
  if (namespace) params.set('namespace', namespace);
  return `/wiki/category/${encodeURIComponent(category)}?${params.toString()}`;
}

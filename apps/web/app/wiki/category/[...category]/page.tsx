import Link from 'next/link';
import { AlertTriangle, ArrowRight, FilePlus2, FolderTree, Network } from 'lucide-react';
import { notFound } from 'next/navigation';
import { WikiArticleView } from '../../../../components/wiki/wiki-article-view';
import { WikiEditRoutePage } from '../../../../components/wiki/wiki-edit-route-page';
import { WikiHistoryRoutePage } from '../../../../components/wiki/wiki-history-route-page';
import { fetchWikiCategory, fetchWikiPageByPath } from '../../../../lib/wiki-server-api';
import { buildWikiRoutePath, decodeWikiRouteSegment } from '../../../../lib/wiki-routes.mjs';
import type { WikiCategoryResponse } from '../../../../lib/wiki-api';

interface PageProps {
  readonly params: Promise<{ category: string[] }>;
  readonly searchParams: Promise<{ namespace?: string; cursor?: string }>;
}

const NAMESPACES = ['', 'main', 'server', 'mod', 'modpack', 'guide', 'data', 'dev', 'help', 'project', 'template', 'file'];

export const dynamic = 'force-dynamic';

export default async function WikiCategoryPage({ params, searchParams }: PageProps) {
  const route = await params;
  const query = await searchParams;
  if (route.category[0] === '_tools') {
    const documentSegments = route.category.slice(2);
    if (documentSegments.length === 0) notFound();
    if (route.category[1] === 'edit') return <WikiEditRoutePage prefix="category" segments={documentSegments} />;
    if (route.category[1] === 'history') return <WikiHistoryRoutePage prefix="category" segments={documentSegments} />;
    notFound();
  }

  const category = route.category.map(decodeWikiRouteSegment).join('/').replace(/_/g, ' ');
  const namespace = NAMESPACES.includes(query.namespace ?? '') ? query.namespace ?? '' : '';
  const routePath = buildWikiRoutePath('category', route.category);
  const [result, page] = await Promise.all([
    fetchWikiCategory({ category, namespace: namespace || undefined, cursor: query.cursor, limit: 30 }),
    fetchWikiPageByPath(routePath)
  ]);
  const directory = <CategoryDirectory result={result} namespace={namespace} />;

  if (page) return <WikiArticleView page={page} routePath={routePath} afterContent={directory} />;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-7 px-4 py-8 sm:px-6 lg:px-8">
      <header className="border-b border-white/10 pb-6">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.18em] text-emerald-300"><FolderTree className="size-4" /> Category</p>
        <h1 className="mt-3 break-words text-3xl font-bold text-white">분류:{result.category}</h1>
        <p className="mt-3 text-sm text-slate-400">이 분류를 사용하는 공개 문서는 있지만 분류 설명 문서는 아직 없습니다.</p>
        <Link href={`/wiki/category/_tools/edit/${categoryPath(result.category)}`} className="btn-primary mt-5 inline-flex min-h-11 items-center gap-2">
          <FilePlus2 className="size-4" /> 분류 문서 만들기
        </Link>
      </header>
      {directory}
    </main>
  );
}

function CategoryDirectory({ result, namespace }: { readonly result: WikiCategoryResponse; readonly namespace: string }) {
  return (
    <section className="space-y-5 border-t border-white/10 pt-6" aria-label={`${result.category} 분류 탐색`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.18em] text-emerald-300"><Network className="size-4" /> Category graph</p>
          <h2 className="mt-2 text-2xl font-bold text-white">분류 계층과 문서</h2>
        </div>
        {!result.isRoot ? <Link href="/wiki/category/%EB%B6%84%EB%A5%98" className="chip chip-muted">루트 분류</Link> : null}
      </div>

      {result.isOrphan ? (
        <div className="flex gap-3 border border-amber-300/25 bg-amber-300/[0.06] p-4 text-sm text-amber-100">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>루트 분류에서 도달할 수 있는 상위 분류가 없습니다. 문서를 편집해 상위 분류를 지정해 주세요.</p>
        </div>
      ) : null}

      {result.parents.length > 0 ? (
        <div className="surface-flat p-4">
          <h3 className="text-sm font-semibold text-white">상위 분류</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {result.parents.map((parent) => <Link key={parent.routePath} href={parent.routePath} className="chip chip-muted hover:border-emerald-300/40 hover:text-emerald-100">{parent.category}</Link>)}
          </div>
        </div>
      ) : null}

      {result.subcategories.length > 0 ? (
        <div className="surface-flat p-4">
          <h3 className="text-sm font-semibold text-white">하위 분류 <span className="ml-1 text-slate-500">{result.subcategories.length}</span></h3>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {result.subcategories.map((child) => (
              <Link key={child.pageId} href={child.routePath} className="flex min-h-12 items-center justify-between gap-3 border border-white/10 px-3 py-2 text-sm text-slate-200 transition hover:border-emerald-300/35 hover:bg-emerald-300/[0.04]">
                <span className="truncate">{child.displayTitle}</span><ArrowRight className="size-4 shrink-0 text-slate-500" />
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <form action={`/wiki/category/${categoryPath(result.category)}`} className="flex flex-wrap items-end gap-3 border border-white/10 bg-[#111821] p-4">
        <label className="min-w-48 flex-1 text-xs font-semibold text-slate-400">이름공간
          <select name="namespace" defaultValue={namespace} className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-white">
            <option value="">전체</option>
            {NAMESPACES.filter(Boolean).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <button type="submit" className="btn-secondary h-11">적용</button>
      </form>

      <div className="divide-y divide-white/10 border border-white/10 bg-[#111821]" aria-label={`${result.category} 분류 문서`}>
        {result.items.map((item) => (
          <Link key={item.id} href={item.routePath} className="flex min-h-16 items-center justify-between gap-4 p-4 transition hover:bg-white/[0.035] sm:p-5">
            <div className="min-w-0"><p className="truncate font-semibold text-white">{item.displayTitle}</p><p className="mt-1 truncate text-xs text-slate-500">{item.namespace}:{item.title}</p></div>
            <ArrowRight className="size-4 shrink-0 text-slate-500" />
          </Link>
        ))}
        {result.items.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">이 분류에 표시할 수 있는 일반 문서가 없습니다.</p> : null}
      </div>

      {result.nextCursor ? <Link href={nextHref(result.category, namespace, result.nextCursor)} className="btn-secondary mx-auto flex h-11 w-fit">다음 문서</Link> : null}
    </section>
  );
}

function categoryPath(category: string) {
  return category.split('/').map((part) => encodeURIComponent(part.trim().replace(/ /g, '_'))).join('/');
}

function nextHref(category: string, namespace: string, cursor: string) {
  const params = new URLSearchParams({ cursor });
  if (namespace) params.set('namespace', namespace);
  return `/wiki/category/${categoryPath(category)}?${params.toString()}`;
}

import Link from 'next/link';
import { ArrowUpRight, Compass, Shuffle } from 'lucide-react';
import { fetchWikiSpecial } from '../../../lib/wiki-server-api';
import type { WikiSpecialDocumentType } from '../../../lib/wiki-api';

interface PageProps { readonly searchParams: Promise<{ type?: string; namespace?: string }>; }

const TYPES: ReadonlyArray<{ key: WikiSpecialDocumentType; label: string; description: string }> = [
  { key: 'orphaned', label: '고립된 문서', description: '다른 공개 문서에서 연결되지 않은 문서' },
  { key: 'orphaned_categories', label: '고립된 분류', description: '루트 분류에서 도달할 수 없는 분류 문서' },
  { key: 'wanted', label: '필요한 문서', description: '링크는 있지만 아직 생성되지 않은 문서' },
  { key: 'categories', label: '분류 목록', description: '현재 공개 문서에서 사용하는 분류와 문서 수' },
  { key: 'uncategorized', label: '분류 없는 문서', description: '문서 분류가 지정되지 않은 문서' },
  { key: 'old', label: '오래된 문서', description: '가장 오랫동안 갱신되지 않은 문서부터 정렬' },
  { key: 'long', label: '긴 문서', description: '원문 크기가 큰 문서부터 정렬' },
  { key: 'short', label: '짧은 문서', description: '원문 크기가 작은 문서부터 정렬' },
  { key: 'random', label: '임의 문서', description: '읽을 수 있는 문서 중 하나를 무작위 선택' }
];
const NAMESPACES = ['', 'main', 'server', 'mod', 'modpack', 'guide', 'data', 'dev', 'help', 'project', 'template', 'category', 'file'];

export const dynamic = 'force-dynamic';

export default async function WikiSpecialPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const type = TYPES.some((item) => item.key === query.type) ? query.type as WikiSpecialDocumentType : 'orphaned';
  const namespace = NAMESPACES.includes(query.namespace ?? '') ? query.namespace ?? '' : '';
  const result = await fetchWikiSpecial({ type, namespace: namespace || undefined, limit: 100 });
  const current = TYPES.find((item) => item.key === type)!;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-7">
      <header className="border-b border-white/10 pb-6">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.18em] text-emerald-300"><Compass className="size-4" /> Special pages</p>
        <h1 className="mt-3 text-3xl font-bold text-white">특수 문서</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">문서 구조를 정비하고 비어 있는 지식을 발견하기 위한 운영 목록입니다.</p>
      </header>

      <nav className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="특수 문서 유형">
        {TYPES.map((item) => <Link key={item.key} href={href(item.key, namespace)} className={`rounded-xl border p-4 transition ${item.key === type ? 'border-emerald-400/40 bg-emerald-400/10' : 'border-white/10 bg-white/[0.025] hover:border-white/20'}`}><strong className={item.key === type ? 'text-emerald-200' : 'text-white'}>{item.label}</strong><span className="mt-1 block text-xs leading-5 text-slate-500">{item.description}</span></Link>)}
      </nav>

      <form action="/wiki/special" className="flex flex-wrap items-end gap-3 border border-white/10 bg-[#111821] p-4">
        <input type="hidden" name="type" value={type} />
        <label className="min-w-48 flex-1 text-xs font-semibold text-slate-400">이름공간<select name="namespace" defaultValue={namespace} className="mt-2 h-10 w-full rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-white"><option value="">전체</option>{NAMESPACES.filter(Boolean).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <button type="submit" className="btn-secondary h-10">적용</button>
        {type === 'random' ? <Link href={href('random', namespace, Date.now().toString())} className="btn-primary h-10"><Shuffle className="size-4" /> 다시 뽑기</Link> : null}
      </form>

      <section>
        <div className="mb-3 flex items-end justify-between gap-3"><div><h2 className="text-xl font-bold text-white">{current.label}</h2><p className="mt-1 text-sm text-slate-500">{current.description}</p></div><span className="chip chip-muted">{result.items.length}개</span></div>
        <div className="divide-y divide-white/10 border border-white/10 bg-[#111821]">
          {result.items.map((item) => <Link key={item.id} href={item.routePath} className="flex items-center justify-between gap-4 p-4 transition hover:bg-white/[0.03] sm:p-5"><div className="min-w-0"><p className="truncate font-semibold text-white">{item.displayTitle}</p><p className="mt-1 truncate text-xs text-slate-500">{item.namespace}:{item.title}</p></div><div className="flex shrink-0 items-center gap-3 text-xs text-slate-500">{type === 'old' && item.updatedAt ? <time dateTime={item.updatedAt}>{formatDate(item.updatedAt)}</time> : item.value !== null ? <span>{type === 'wanted' ? `링크 ${item.value}` : type === 'categories' ? `문서 ${item.value}` : `${item.value.toLocaleString('ko-KR')} bytes`}</span> : null}<ArrowUpRight className="size-4" /></div></Link>)}
          {result.items.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">조건에 해당하는 문서가 없습니다.</p> : null}
        </div>
      </section>
    </div>
  );
}

function href(type: WikiSpecialDocumentType, namespace: string, refresh?: string) {
  const params = new URLSearchParams({ type });
  if (namespace) params.set('namespace', namespace);
  if (refresh) params.set('_', refresh);
  return `/wiki/special?${params.toString()}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeZone: 'Asia/Seoul' }).format(new Date(value));
}

import Link from 'next/link';
import { ArrowRight, Clock3, CornerDownLeft, Network, UsersRound } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WikiBacklinkItem, WikiCategoryResponse, WikiRevisionSummary } from '../../lib/wiki-api';
import { buildWikiHistoryPath, buildWikiRevisionPath } from '../../lib/wiki-routes.mjs';

type RelatedItem = WikiCategoryResponse['items'][number];

export function WikiDocumentContext({
  currentPageId,
  routePath,
  backlinks,
  related,
  revisions,
}: {
  readonly currentPageId: string;
  readonly routePath: string;
  readonly backlinks: readonly WikiBacklinkItem[];
  readonly related: readonly RelatedItem[];
  readonly revisions: readonly WikiRevisionSummary[];
}) {
  const uniqueRelated = dedupeRelated(related, currentPageId).slice(0, 6);
  const visibleBacklinks = backlinks.slice(0, 6);
  const visibleRevisions = revisions.slice(0, 5);
  if (uniqueRelated.length === 0 && visibleBacklinks.length === 0 && visibleRevisions.length === 0) return null;

  return (
    <section className="space-y-5 border-t border-white/10 pt-8" aria-label="문서 활동과 연결된 문서">
      {visibleRevisions.length > 0 ? <RevisionActivity routePath={routePath} revisions={visibleRevisions} /> : null}
      {uniqueRelated.length > 0 || visibleBacklinks.length > 0 ? <div className="grid gap-5 lg:grid-cols-2"><DocumentList
        icon={<Network className="size-4" aria-hidden="true" />}
        eyebrow="Explore next"
        title="같이 읽으면 좋은 문서"
        description="같은 분류에 속한 공개 문서입니다."
        items={uniqueRelated}
      />
      <DocumentList
        icon={<CornerDownLeft className="size-4" aria-hidden="true" />}
        eyebrow="Referenced by"
        title="이 문서를 참고한 문서"
        description="현재 이 문서로 연결되는 공개 문서입니다."
        items={visibleBacklinks}
      /></div> : null}
    </section>
  );
}

function RevisionActivity({ routePath, revisions }: { readonly routePath: string; readonly revisions: readonly WikiRevisionSummary[] }) {
  const contributors = new Set(revisions.map(revisionAuthor).filter(Boolean));
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5" aria-labelledby="document-activity-title">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-emerald-400/10 text-emerald-300"><Clock3 className="size-4" aria-hidden="true" /></span><div><p className="text-[11px] font-bold uppercase tracking-[0.15em] text-emerald-300">Document activity</p><h2 id="document-activity-title" className="mt-1 text-lg font-bold text-white">최근 문서 활동</h2><p className="mt-1 text-sm leading-6 text-slate-500">공개된 최근 판과 편집 흐름을 한눈에 확인하세요.</p></div></div><div className="flex flex-wrap gap-2 text-xs"><span className="chip chip-muted">최근 {revisions.length}개 판</span><span className="chip chip-muted inline-flex items-center gap-1.5"><UsersRound className="size-3.5" aria-hidden="true" />기여자 {contributors.size}명</span></div></div>
      <ol className="mt-5 divide-y divide-white/[0.07]">{revisions.map((revision) => { const author = revisionAuthor(revision) || '알 수 없는 사용자'; const summary = revision.editSummary?.trim() || '편집 요약 없음'; return <li key={revision.id} className="flex min-h-16 flex-col gap-1 py-3 sm:flex-row sm:items-center sm:gap-4"><Link href={buildWikiRevisionPath(revision.id, routePath)} className="min-w-0 flex-1 group"><span className="block truncate text-sm font-semibold text-slate-300 group-hover:text-white">rev {revision.revisionNo} · {summary}</span><span className="mt-1 block text-xs text-slate-500">{author} · {formatActivityTime(revision.createdAt)}</span></Link>{revision.sizeDelta !== null ? <span className={`shrink-0 font-mono text-xs ${revision.sizeDelta > 0 ? 'text-emerald-300' : revision.sizeDelta < 0 ? 'text-red-300' : 'text-slate-500'}`}>{formatSizeDelta(revision.sizeDelta)}</span> : null}</li>; })}</ol>
      <Link href={buildWikiHistoryPath(routePath)} className="mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-emerald-300 hover:text-emerald-200">전체 역사 보기<ArrowRight className="size-4" aria-hidden="true" /></Link>
    </section>
  );
}

function revisionAuthor(revision: WikiRevisionSummary): string {
  return revision.createdByName?.trim() || revision.createdByUsername?.trim() || '';
}

function formatActivityTime(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value));
}

function formatSizeDelta(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toLocaleString('ko-KR')} B`;
}

function DocumentList({
  icon,
  eyebrow,
  title,
  description,
  items,
}: {
  readonly icon: ReactNode;
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly items: ReadonlyArray<{ readonly pageId?: string; readonly sourcePageId?: string; readonly routePath: string; readonly displayTitle: string; readonly namespace: string }>;
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-emerald-400/10 text-emerald-300">{icon}</span>
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-emerald-300">{eyebrow}</p>
          <h2 className="mt-1 text-lg font-bold text-white">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p>
        </div>
      </div>
      {items.length > 0 ? (
        <ul className="mt-4 divide-y divide-white/[0.07]">
          {items.map((item) => (
            <li key={`${item.namespace}:${item.pageId ?? item.sourcePageId ?? item.routePath}`}>
              <Link href={item.routePath} className="group flex min-h-14 items-center gap-3 py-3">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-300 group-hover:text-white">{item.displayTitle}</span>
                <span className="shrink-0 text-[11px] uppercase tracking-wide text-slate-600">{item.namespace}</span>
                <ArrowRight className="size-3.5 shrink-0 text-slate-700 group-hover:text-emerald-300" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 rounded-lg border border-dashed border-white/10 px-4 py-5 text-sm leading-6 text-slate-500">아직 연결된 공개 문서가 없습니다.</p>
      )}
    </section>
  );
}

function dedupeRelated(items: readonly RelatedItem[], currentPageId: string): RelatedItem[] {
  const seen = new Set<string>([currentPageId]);
  const result: RelatedItem[] = [];
  for (const item of items) {
    if (seen.has(item.pageId)) continue;
    seen.add(item.pageId);
    result.push(item);
  }
  return result;
}

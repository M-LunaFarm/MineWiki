import Link from 'next/link';
import { ArrowRight, CornerDownLeft, Network } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WikiBacklinkItem, WikiCategoryResponse } from '../../lib/wiki-api';

type RelatedItem = WikiCategoryResponse['items'][number];

export function WikiDocumentContext({
  currentPageId,
  backlinks,
  related,
}: {
  readonly currentPageId: string;
  readonly backlinks: readonly WikiBacklinkItem[];
  readonly related: readonly RelatedItem[];
}) {
  const uniqueRelated = dedupeRelated(related, currentPageId).slice(0, 6);
  const visibleBacklinks = backlinks.slice(0, 6);
  if (uniqueRelated.length === 0 && visibleBacklinks.length === 0) return null;

  return (
    <section className="grid gap-5 border-t border-white/10 pt-8 lg:grid-cols-2" aria-label="연결된 문서">
      <DocumentList
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
      />
    </section>
  );
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

'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, FileText, FolderOpen } from 'lucide-react';
import {
  parseCollapsedServerWikiNavigation,
  serverWikiAncestorIds,
  visibleServerWikiNavigation,
} from '../../lib/server-wiki-navigation.mjs';

interface NavigationItem {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly current: boolean;
  readonly depth: number;
  readonly hasChildren: boolean;
}

export function ServerWikiNavigation({
  items,
  storageKey,
}: {
  readonly items: readonly NavigationItem[];
  readonly storageKey: string;
}) {
  const currentRef = useRef<HTMLAnchorElement | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const stored = window.localStorage.getItem(storageKey);
    const next = parseCollapsedServerWikiNavigation(stored, items);
    const currentId = items.find((item) => item.current)?.id;
    if (currentId) {
      for (const ancestorId of serverWikiAncestorIds(items, currentId)) next.delete(ancestorId);
    }
    setCollapsedIds(next);
  }, [items, storageKey]);

  const visibleItems = useMemo(
    () => visibleServerWikiNavigation(items, collapsedIds),
    [collapsedIds, items],
  );

  useEffect(() => {
    currentRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
  }, [visibleItems]);

  function toggle(item: NavigationItem) {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      window.localStorage.setItem(storageKey, JSON.stringify([...next]));
      return next;
    });
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 lg:mt-3 lg:block lg:space-y-1 lg:overflow-x-visible lg:pb-0">
      {visibleItems.map((item) => {
        const collapsed = collapsedIds.has(item.id);
        return (
          <div
            key={item.id}
            className={`group flex shrink-0 scroll-mx-4 items-center rounded-lg transition lg:w-full ${
              item.current
                ? 'bg-emerald-400/10 font-semibold text-emerald-300'
                : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-100'
            }`}
            style={{ paddingLeft: `calc(0.25rem + ${Math.min(item.depth, 4)} * 1rem)` }}
          >
            {item.hasChildren ? (
              <button
                type="button"
                onClick={() => toggle(item)}
                className="hidden size-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-white/[0.06] hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 lg:flex"
                aria-expanded={!collapsed}
                aria-label={`${item.title} 하위 문서 ${collapsed ? '펼치기' : '접기'}`}
              >
                <ChevronRight className={`size-3.5 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
              </button>
            ) : item.depth > 0 ? (
              <span className="hidden size-8 shrink-0 lg:block" aria-hidden="true" />
            ) : null}
            <Link
              ref={item.current ? currentRef : undefined}
              href={item.path}
              aria-current={item.current ? 'page' : undefined}
              title={item.title}
              className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 lg:px-1"
            >
              {item.hasChildren ? <FolderOpen className="size-4 shrink-0" /> : <FileText className="size-4 shrink-0" />}
              <span className="truncate">{item.title}</span>
            </Link>
          </div>
        );
      })}
    </div>
  );
}

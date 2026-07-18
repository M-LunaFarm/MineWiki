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
  readonly kind: 'group' | 'page';
  readonly id: string;
  readonly title: string;
  readonly path: string | null;
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
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(storageKey);
    } catch {
      // Storage can be unavailable in hardened/private browser contexts.
    }
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
      try {
        window.localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        // Keep the in-memory navigation usable when persistence is unavailable.
      }
      return next;
    });
  }

  return (
    <div className="mt-3 block space-y-0.5">
      {visibleItems.map((item) => {
        const collapsed = collapsedIds.has(item.id);
        const isGroup = item.kind === 'group';
        return (
          <div
            key={item.id}
            className={`group flex w-full items-center rounded-lg transition ${
              item.current
                ? 'bg-[#edf3ff] font-medium text-[#2458bd]'
                : isGroup
                  ? 'mt-2 font-semibold text-[#3f3f3f]'
                : 'text-[#626262] hover:bg-[#f0f0f0] hover:text-[#202020]'
            }`}
            style={{ paddingLeft: `calc(0.25rem + ${Math.min(item.depth, 4)} * 1rem)` }}
          >
            {item.hasChildren && isGroup ? (
              <span className="flex size-8 shrink-0 items-center justify-center text-[#8a8a8a]" aria-hidden="true">
                <ChevronRight className={`size-3.5 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
              </span>
            ) : item.hasChildren ? (
              <button
                type="button"
                onClick={() => toggle(item)}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-[#8a8a8a] hover:bg-[#e8e8e8] hover:text-[#333] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#346ddb]/30"
                aria-expanded={!collapsed}
                aria-label={`${item.title} 하위 문서 ${collapsed ? '펼치기' : '접기'}`}
              >
                <ChevronRight className={`size-3.5 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
              </button>
            ) : item.depth > 0 ? (
              <span className="block size-8 shrink-0" aria-hidden="true" />
            ) : null}
            {isGroup ? (
              <button
                type="button"
                onClick={() => toggle(item)}
                className="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-1 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-[#346ddb]/30"
                aria-expanded={!collapsed}
              >
                <FolderOpen className="size-4 shrink-0" />
                <span className="truncate">{item.title}</span>
              </button>
            ) : item.path ? (
              <Link
                ref={item.current ? currentRef : undefined}
                href={item.path}
                aria-current={item.current ? 'page' : undefined}
                title={item.title}
                className="flex min-w-0 flex-1 items-center gap-2 px-1 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[#346ddb]/30"
              >
                {item.hasChildren ? <FolderOpen className="size-4 shrink-0" /> : <FileText className="size-4 shrink-0" />}
                <span className="truncate">{item.title}</span>
              </Link>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

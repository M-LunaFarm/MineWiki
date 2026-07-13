'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { ChevronRight, FileText, FolderOpen } from 'lucide-react';

interface NavigationItem {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly current: boolean;
  readonly depth: number;
  readonly hasChildren: boolean;
}

export function ServerWikiNavigation({ items }: { readonly items: readonly NavigationItem[] }) {
  const currentRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    currentRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
  }, [items]);

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 lg:mt-3 lg:block lg:space-y-1 lg:overflow-x-visible lg:pb-0">
      {items.map((item) => (
        <Link
          key={item.id}
          ref={item.current ? currentRef : undefined}
          href={item.path}
          aria-current={item.current ? 'page' : undefined}
          title={item.title}
          className={`group flex shrink-0 scroll-mx-4 items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition lg:w-full ${
            item.current
              ? 'bg-emerald-400/10 font-semibold text-emerald-300'
              : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-100'
          }`}
          style={{ paddingLeft: `calc(0.75rem + ${Math.min(item.depth, 4)} * 1rem)` }}
        >
          {item.depth > 0 ? <ChevronRight className="hidden size-3 shrink-0 text-slate-600 lg:block" /> : null}
          {item.hasChildren ? <FolderOpen className="size-4 shrink-0" /> : <FileText className="size-4 shrink-0" />}
          <span className="truncate">{item.title}</span>
        </Link>
      ))}
    </div>
  );
}

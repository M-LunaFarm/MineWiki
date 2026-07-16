'use client';

import { ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { fetchWikiEditRequestReviewableSummary } from '../../lib/wiki-api';
import { useAuth } from '../providers/auth-context';

export function WikiReviewQueueBadge({ paper = false }: { readonly paper?: boolean }) {
  const { account } = useAuth();
  const pathname = usePathname();
  const [count, setCount] = useState(0);
  const [capped, setCapped] = useState(false);

  useEffect(() => {
    let active = true;
    if (!account) {
      setCount(0);
      setCapped(false);
      return () => { active = false; };
    }
    const load = () => {
      void fetchWikiEditRequestReviewableSummary()
        .then((result) => {
          if (!active) return;
          setCount(result.count);
          setCapped(result.capped);
        })
        .catch(() => {});
    };
    load();
    const interval = window.setInterval(load, 60_000);
    window.addEventListener('wiki:edit-request-changed', load);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('wiki:edit-request-changed', load);
    };
  }, [account, pathname]);

  if (!account || count === 0) return null;
  const displayCount = capped || count > 99 ? '99+' : count.toString();
  return (
    <Link
      href="/wiki/edit-requests?status=open&scope=reviewable"
      aria-label={`검토할 편집 요청 ${capped ? `${count}개 이상` : `${count}개`}`}
      className={`relative inline-flex size-10 items-center justify-center rounded-xl border transition ${paper ? 'border-[#aaa79e] bg-white/30 text-[#4d544d] hover:text-[#1f5f46]' : 'border-white/[0.08] bg-white/[0.03] text-slate-400 hover:border-white/20 hover:text-white'}`}
    >
      <ClipboardCheck className="size-[18px]" />
      <span className="absolute -right-1 -top-1 flex min-w-5 items-center justify-center rounded-full bg-amber-300 px-1 text-[10px] font-extrabold leading-5 text-[#2d2100]">
        {displayCount}
      </span>
    </Link>
  );
}

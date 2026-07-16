'use client';

import { Bell } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { fetchWikiNotifications } from '../../lib/wiki-api';
import { useAuth } from '../providers/auth-context';

export function WikiNotificationBell({ paper = false }: { readonly paper?: boolean }) {
  const { account } = useAuth();
  const pathname = usePathname();
  const [count, setCount] = useState(0);

  useEffect(() => {
    let active = true;
    if (!account) { setCount(0); return () => { active = false; }; }
    const load = () => { void fetchWikiNotifications().then((result) => { if (active) setCount(result.unreadCount); }).catch(() => {}); };
    load();
    const interval = window.setInterval(load, 60_000);
    window.addEventListener('wiki-notifications-changed', load);
    return () => { active = false; window.clearInterval(interval); window.removeEventListener('wiki-notifications-changed', load); };
  }, [account, pathname]);

  if (!account) return null;
  return <Link href="/wiki/notifications" aria-label={`위키 알림${count > 0 ? ` ${count}개 읽지 않음` : ''}`} className={`relative inline-flex size-10 items-center justify-center rounded-xl border transition ${paper ? 'border-[#aaa79e] bg-white/30 text-[#4d544d] hover:text-[#1f5f46]' : 'border-white/[0.08] bg-white/[0.03] text-slate-400 hover:border-white/20 hover:text-white'}`}>
    <Bell className="size-[18px]" />
    {count > 0 ? <span className="absolute -right-1 -top-1 flex min-w-5 items-center justify-center rounded-full bg-emerald-400 px-1 text-[10px] font-extrabold leading-5 text-[#062419]">{count > 99 ? '99+' : count}</span> : null}
  </Link>;
}

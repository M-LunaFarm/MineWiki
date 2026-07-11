'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, Search, X } from 'lucide-react';
import { AccountDropdown } from '../account/account-dropdown';
import { useAuth } from '../providers/auth-context';

type NavigationLink = {
  readonly href: string;
  readonly label: string;
  readonly key: 'wiki' | 'servers' | 'recent' | 'search' | 'guilds' | 'support' | 'account' | 'admin';
  readonly requiresAccount?: boolean;
  readonly requiresAdmin?: boolean;
};

const NAV_LINKS: readonly NavigationLink[] = [
  { href: '/wiki', label: '위키', key: 'wiki' },
  { href: '/servers', label: '서버 목록', key: 'servers' },
  { href: '/recent', label: '최근 변경', key: 'recent' },
  { href: '/search', label: '검색', key: 'search' },
  { href: '/guilds', label: '길드', key: 'guilds' },
  { href: '/support', label: '지원', key: 'support' },
  { href: '/me', label: '계정', key: 'account', requiresAccount: true },
  { href: '/admin/support', label: '관리자', key: 'admin', requiresAdmin: true },
];

export function SiteHeader() {
  const pathname = usePathname();
  const { account, loading } = useAuth();
  const [currentSearch, setCurrentSearch] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const syncSearchFromLocation = () => {
      if (typeof window === 'undefined' || window.location.pathname !== '/search') {
        setCurrentSearch('');
        return;
      }
      const params = new URLSearchParams(window.location.search);
      setCurrentSearch(params.get('q') ?? '');
    };

    syncSearchFromLocation();

    if (typeof window === 'undefined') {
      return;
    }

    const dispatchLocationChange = () => window.dispatchEvent(new Event('locationchange'));
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;

    window.history.pushState = function pushState(...args) {
      const result = originalPushState.apply(this, args);
      dispatchLocationChange();
      return result;
    };
    window.history.replaceState = function replaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      dispatchLocationChange();
      return result;
    };

    window.addEventListener('popstate', syncSearchFromLocation);
    window.addEventListener('locationchange', syncSearchFromLocation);

    return () => {
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
      window.removeEventListener('popstate', syncSearchFromLocation);
      window.removeEventListener('locationchange', syncSearchFromLocation);
    };
  }, [pathname]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const hasAdminAccess = Boolean(
    account?.access?.isElevated ||
      account?.access?.roles.some((role) => role === 'admin' || role === 'owner') ||
      account?.access?.permissions.some((permission) => permission.startsWith('admin.')),
  );

  const visibleLinks = NAV_LINKS.filter((link) => {
    if (link.requiresAccount && !account) {
      return false;
    }
    if (link.requiresAdmin && !hasAdminAccess) {
      return false;
    }
    return true;
  });

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.06] bg-[#07090c]/80 backdrop-blur-xl">
      <div className="mx-auto w-full max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-7">
            <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="MineWiki 홈">
              <span
                aria-hidden="true"
                className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-[#14c794]/30 bg-gradient-to-br from-[#0f1a16] to-[#0b0f15] shadow-[0_0_18px_-6px_rgba(20,199,148,0.5)]"
              >
                <span className="absolute left-[10px] top-[10px] h-3.5 w-3.5 rounded-full bg-[#14c794]" />
                <span className="absolute left-[15px] top-[15px] h-3.5 w-3.5 rounded-full bg-[#0b0f15]" />
                <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-white/85" />
              </span>
              <span className="text-[19px] font-extrabold tracking-tight text-white">
                MineWiki<span className="text-[#14c794]">.kr</span>
              </span>
            </Link>
            <nav className="hidden items-center gap-0.5 text-sm font-medium lg:flex">
              {visibleLinks.map((link) => {
                const active = isActive(pathname, link.key);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`relative rounded-lg px-3 py-2 transition-colors ${
                      active
                        ? 'text-white'
                        : 'text-slate-400 hover:bg-white/[0.04] hover:text-white'
                    }`}
                  >
                    {link.label}
                    {active ? (
                      <span className="absolute inset-x-3 -bottom-[1px] h-[2px] rounded-full bg-gradient-to-r from-[#14c794] to-[#1ac5d9]" />
                    ) : null}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden border-l border-white/[0.08] pl-4 text-xs text-slate-500 2xl:block">
              {loading
                ? '세션 확인 중'
                : account
                  ? `${account.displayName ?? account.email ?? '내 계정'} · ${formatProviderLabel(account.provider)}`
                  : '비로그인'}
            </div>

            <form action="/search" className="relative hidden xl:block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                name="q"
                type="search"
                aria-label="위키 검색"
                value={currentSearch}
                onChange={(event) => setCurrentSearch(event.target.value)}
                placeholder="위키 문서 검색"
                className="h-10 w-64 rounded-xl border border-white/[0.08] bg-white/[0.03] pl-10 pr-3 text-sm text-white placeholder:text-slate-500 transition-colors focus:border-[#14c794]/60 focus:bg-white/[0.05] focus:outline-none focus:ring-2 focus:ring-[#14c794]/15"
              />
            </form>

            <AccountDropdown />
            <button
              type="button"
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-slate-300 transition hover:border-white/20 hover:text-white lg:hidden"
              aria-label={mobileOpen ? '메뉴 닫기' : '메뉴 열기'}
              onClick={() => setMobileOpen((open) => !open)}
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {mobileOpen ? (
          <div className="border-t border-white/[0.06] py-3 lg:hidden">
            <form action="/search" className="relative mb-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                name="q"
                type="search"
                aria-label="위키 검색"
                value={currentSearch}
                onChange={(event) => setCurrentSearch(event.target.value)}
                placeholder="위키 문서 검색"
                className="h-10 w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 pl-10 text-sm text-white placeholder:text-slate-500 focus:border-[#14c794]/60 focus:outline-none"
              />
            </form>
            <nav className="grid gap-0.5">
              {visibleLinks.map((link) => {
                const active = isActive(pathname, link.key);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`rounded-lg px-3 py-2 text-sm font-medium ${
                      active
                        ? 'bg-white/[0.06] text-white'
                        : 'text-slate-400 hover:bg-white/[0.04] hover:text-white'
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        ) : null}
      </div>
    </header>
  );
}

function isActive(pathname: string | null, key: NavigationLink['key']): boolean {
  if (!pathname) {
    return false;
  }
  if (key === 'wiki') {
    return (
      pathname === '/wiki' ||
      pathname.startsWith('/wiki/') ||
      pathname.startsWith('/server/') ||
      pathname.startsWith('/mod/') ||
      pathname.startsWith('/modpack/') ||
      pathname.startsWith('/project/') ||
      pathname.startsWith('/file/') ||
      pathname.startsWith('/dev/') ||
      pathname.startsWith('/help/')
    );
  }
  if (key === 'servers') {
    return pathname === '/servers' || pathname.startsWith('/servers/');
  }
  if (key === 'recent') {
    return pathname === '/recent';
  }
  if (key === 'search') {
    return pathname === '/search';
  }
  if (key === 'guilds') {
    return pathname === '/guilds' || pathname.startsWith('/guilds/');
  }
  if (key === 'support') {
    return (
      pathname === '/support' ||
      pathname.startsWith('/support/') ||
      pathname === '/dashboard/support'
    );
  }
  if (key === 'account') {
    return pathname === '/me';
  }
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

function formatProviderLabel(provider: 'email' | 'discord' | 'naver'): string {
  if (provider === 'discord') {
    return 'Discord';
  }
  if (provider === 'naver') {
    return 'NAVER';
  }
  return 'Email';
}

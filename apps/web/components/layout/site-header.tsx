'use client';

import Link from 'next/link';
import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { usePathname } from 'next/navigation';
import { BookOpenText, Menu, Search, X } from 'lucide-react';
import { AccountDropdown } from '../account/account-dropdown';
import { useAuth } from '../providers/auth-context';
import { ThemeToggle } from './theme-toggle';
import { WikiNotificationBell } from './wiki-notification-bell';
import { WikiReviewQueueBadge } from './wiki-review-queue-badge';
import { fetchWikiSuggestions, type WikiSearchResult } from '../../lib/wiki-api';

type NavigationLink = {
  readonly href: string;
  readonly label: string;
  readonly key: 'wiki' | 'servers' | 'recent' | 'discussions' | 'search' | 'guilds' | 'support' | 'account' | 'admin';
  readonly requiresAccount?: boolean;
  readonly requiresAdmin?: boolean;
};

const NAV_LINKS: readonly NavigationLink[] = [
  { href: '/wiki/%EB%8C%80%EB%AC%B8', label: '위키', key: 'wiki' },
  { href: '/servers', label: '서버 목록', key: 'servers' },
  { href: '/recent', label: '최근 변경', key: 'recent' },
  { href: '/wiki/discussions', label: '토론', key: 'discussions' },
  { href: '/search', label: '검색', key: 'search' },
  { href: '/guilds', label: 'Discord 연동', key: 'guilds' },
  { href: '/support', label: '지원', key: 'support' },
  { href: '/me', label: '계정', key: 'account', requiresAccount: true },
  { href: '/admin', label: '관리자', key: 'admin', requiresAdmin: true },
];

export function SiteHeader({ variant = 'dark' }: { readonly variant?: 'dark' | 'paper' }) {
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
    account?.access?.roles.some((role) => role === 'admin' || role === 'owner') ||
      account?.access?.permissions.some((permission) => permission.endsWith('.admin')),
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
    <header className={`fixed inset-x-0 top-0 z-50 border-b backdrop-blur-xl ${variant === 'paper' ? 'border-[#b8b4aa]/70 bg-[#f4f2ec]/90 text-[#252925]' : 'border-white/[0.06] bg-[#07090c]/80'}`}>
      <div className="mx-auto w-full max-w-[1440px] px-3 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-7">
            <Link href="/" className="flex shrink-0 items-center gap-2 sm:gap-2.5" aria-label="MineWiki 홈">
              <span
                aria-hidden="true"
                className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#123d31] text-[#8cf0cf]"
              >
                <BookOpenText className="h-[19px] w-[19px]" strokeWidth={2.2} />
              </span>
              <span className={`text-[16px] font-extrabold tracking-tight sm:text-[19px] ${variant === 'paper' ? 'text-[#20241f]' : 'text-white'}`}>
                MineWiki<span className="hidden text-[#14c794] min-[360px]:inline">.kr</span>
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
                        ? variant === 'paper' ? 'text-[#1f5f46]' : 'text-white'
                        : variant === 'paper' ? 'text-[#4d544d] hover:bg-[#dfe6dc]/70 hover:text-[#1c211d]' : 'text-slate-400 hover:bg-white/[0.04] hover:text-white'
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

          <div className="flex items-center gap-1.5 sm:gap-3">
            <div className="hidden border-l border-white/[0.08] pl-4 text-xs text-slate-500 2xl:block">
              {loading
                ? '세션 확인 중'
                : account
                  ? `${account.displayName ?? account.email ?? '내 계정'} · ${formatProviderLabel(account.provider)}`
                  : '비로그인'}
            </div>

            <HeaderSearch value={currentSearch} onChange={setCurrentSearch} variant={variant} className="hidden xl:block" />

            <WikiReviewQueueBadge paper={variant === 'paper'} />
            <WikiNotificationBell paper={variant === 'paper'} />
            <AccountDropdown />
            <ThemeToggle paper={variant === 'paper'} />
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
            <HeaderSearch value={currentSearch} onChange={setCurrentSearch} variant={variant} className="mb-3" mobile />
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

function HeaderSearch({
  value,
  onChange,
  variant,
  className,
  mobile = false
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly variant: 'dark' | 'paper';
  readonly className?: string;
  readonly mobile?: boolean;
}) {
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [items, setItems] = useState<WikiSearchResult[]>([]);
  const [exactMatch, setExactMatch] = useState<WikiSearchResult | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const query = value.trim();
    if (!focused || !query) {
      setItems([]); setExactMatch(null); setActiveIndex(-1); setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void fetchWikiSuggestions(query)
        .then((result) => {
          if (!active) return;
          setItems(result.items); setExactMatch(result.exactMatch); setActiveIndex(-1);
        })
        .catch(() => {
          if (active) { setItems([]); setExactMatch(null); }
        })
        .finally(() => { if (active) setLoading(false); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [focused, value]);

  function submit(event: FormEvent<HTMLFormElement>) {
    const target = activeIndex >= 0 ? items[activeIndex] : exactMatch;
    if (!target) return;
    event.preventDefault();
    window.location.assign(target.routePath);
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' && items.length > 0) {
      event.preventDefault(); setActiveIndex((current) => current >= items.length - 1 ? 0 : current + 1);
    } else if (event.key === 'ArrowUp' && items.length > 0) {
      event.preventDefault(); setActiveIndex((current) => current <= 0 ? items.length - 1 : current - 1);
    } else if (event.key === 'Escape') {
      setFocused(false); setActiveIndex(-1);
    }
  }

  const open = focused && value.trim().length > 0;
  return <form action="/search" onSubmit={submit} className={`relative ${className ?? ''}`} onFocus={() => setFocused(true)} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
  }}>
    <Search className="pointer-events-none absolute left-3 top-5 h-4 w-4 -translate-y-1/2 text-slate-500" />
    <input
      name="q"
      type="search"
      role="combobox"
      aria-label="MineWiki 통합 검색"
      aria-autocomplete="list"
      aria-expanded={open && items.length > 0}
      aria-controls={listId}
      aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
      autoComplete="off"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={keyDown}
      placeholder="서버와 위키 통합 검색"
      className={`${mobile ? 'w-full' : 'w-64'} h-10 rounded-xl pl-10 pr-3 text-sm transition-colors focus:border-[#14c794]/60 focus:outline-none focus:ring-2 focus:ring-[#14c794]/15 ${variant === 'paper' ? 'border border-[#aaa79e] bg-white/35 text-[#222720] placeholder:text-[#777b73]' : 'border border-white/[0.08] bg-white/[0.03] text-white placeholder:text-slate-500 focus:bg-white/[0.05]'}`}
    />
    {open ? <div id={listId} role="listbox" onMouseDown={(event) => event.preventDefault()} className={`header-search-results absolute inset-x-0 top-12 z-50 overflow-hidden rounded-xl border shadow-2xl ${variant === 'paper' ? 'border-[#aaa79e] bg-[#faf9f4] text-[#202820]' : 'border-white/10 bg-[#10151b] text-slate-100'}`}>
      {items.map((item, index) => <Link
        id={`${listId}-${index}`}
        role="option"
        aria-selected={activeIndex === index}
        key={item.pageId}
        href={item.routePath}
        className={`header-search-result block border-b px-3 py-2.5 text-left last:border-0 ${variant === 'paper' ? 'border-[#d9d5ca] hover:bg-[#e8eee7]' : 'border-white/[0.07] hover:bg-white/[0.05]'} ${activeIndex === index ? variant === 'paper' ? 'bg-[#e8eee7]' : 'bg-emerald-300/10' : ''}`}
      >
        <span className="block truncate text-sm font-semibold">{item.displayTitle}</span>
        <span className={`header-search-meta mt-0.5 block truncate text-[11px] ${variant === 'paper' ? 'text-[#697168]' : 'text-slate-500'}`}>{item.namespace}:{item.title}</span>
      </Link>)}
      {!loading && items.length === 0 ? <p className="header-search-meta px-3 py-3 text-xs text-slate-500">일치하는 위키 문서가 없습니다. Enter로 통합 검색합니다.</p> : null}
      {loading ? <p className="header-search-meta px-3 py-3 text-xs text-slate-500">문서 찾는 중...</p> : null}
      {exactMatch ? <p className={`header-search-hint border-t px-3 py-2 text-[11px] ${variant === 'paper' ? 'border-[#d9d5ca] text-[#697168]' : 'border-white/[0.07] text-slate-500'}`}>Enter를 누르면 정확히 일치하는 문서로 바로 이동합니다.</p> : null}
    </div> : null}
  </form>;
}

function isActive(pathname: string | null, key: NavigationLink['key']): boolean {
  if (!pathname) {
    return false;
  }
  if (key === 'wiki') {
    if (pathname === '/wiki/discussions') {
      return false;
    }
    return (
      pathname === '/wiki' ||
      pathname.startsWith('/wiki/') ||
      pathname.startsWith('/server/') ||
      pathname.startsWith('/mod/') ||
      pathname.startsWith('/modpack/') ||
      pathname.startsWith('/guide/') ||
      pathname.startsWith('/data/') ||
      pathname.startsWith('/template/') ||
      pathname.startsWith('/project/') ||
      pathname.startsWith('/file/') ||
      pathname.startsWith('/dev/') ||
      pathname.startsWith('/help/')
    );
  }
  if (key === 'servers') {
    return pathname === '/' || pathname === '/servers' || pathname.startsWith('/servers/');
  }
  if (key === 'recent') {
    return pathname === '/recent';
  }
  if (key === 'discussions') {
    return pathname === '/wiki/discussions';
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

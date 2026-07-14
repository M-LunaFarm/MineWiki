'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { SiteHeader } from './site-header';
import { SiteFooter } from './site-footer';

interface AppShellProps {
  readonly children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const isServerPage =
    pathname === '/servers' ||
    (pathname.startsWith('/servers/') && pathname !== '/servers/register');
  const isSupportPage = pathname === '/support' || pathname.startsWith('/support/');
  const isServerWikiPage = pathname === '/server' || pathname.startsWith('/server/');
  const isWikiPage =
    pathname === '/wiki' || pathname.startsWith('/wiki/') ||
    pathname === '/mod' || pathname.startsWith('/mod/') ||
    pathname === '/modpack' || pathname.startsWith('/modpack/') ||
    pathname === '/guide' || pathname.startsWith('/guide/') ||
    pathname === '/data' || pathname.startsWith('/data/') ||
    pathname === '/template' || pathname.startsWith('/template/') ||
    pathname === '/dev' || pathname.startsWith('/dev/') ||
    pathname === '/help' || pathname.startsWith('/help/') ||
    pathname === '/project' || pathname.startsWith('/project/') ||
    pathname === '/file' || pathname.startsWith('/file/');
  const isAuthPage =
    pathname === '/login' ||
    pathname === '/auth' ||
    pathname.startsWith('/login/') ||
    pathname.startsWith('/auth/');

  if (pathname === '/' || pathname === '/servers') {
    return <div className="min-h-screen text-slate-100">{children}</div>;
  }

  if (pathname.startsWith('/auth/callback/') || pathname === '/minecraft/callback') {
    return <div className="min-h-screen text-slate-100">{children}</div>;
  }

  if (isAuthPage) {
    return <div className="min-h-screen bg-[#070a0c] text-slate-100">{children}</div>;
  }

  if (isSupportPage) {
    return (
      <div className="min-h-screen bg-[#121212] text-slate-100">
        <SiteHeader />
        {children}
        <SiteFooter />
      </div>
    );
  }

  if (isServerWikiPage) {
    return (
      <div className="min-h-screen bg-[#0b0e12] text-slate-100">
        <SiteHeader />
        <div className="pt-16">{children}</div>
      </div>
    );
  }

  if (isWikiPage) {
    return (
      <div className="wiki-shell min-h-screen text-slate-100">
        <SiteHeader />
        <main className="mx-auto w-full max-w-7xl px-4 pb-12 pt-28 sm:px-6 lg:px-10">{children}</main>
        <SiteFooter />
      </div>
    );
  }

  if (isServerPage || pathname === '/me' || pathname === '/servers/register') {
    return (
      <div className="min-h-screen bg-[#121212] text-slate-100">
        {children}
        <SiteFooter />
      </div>
    );
  }

  if (pathname === '/claim') {
    return (
      <div className="min-h-screen bg-[#121212] text-slate-100">
        <SiteHeader />
        <main className="mx-auto w-full max-w-7xl px-4 pb-16 pt-24 sm:px-6 lg:px-8">
          {children}
        </main>
        <SiteFooter />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#121212] text-slate-100">
      <SiteHeader />
      <main className="mx-auto w-full max-w-7xl px-4 pb-12 pt-28 sm:px-6 lg:px-10">{children}</main>
      <SiteFooter />
    </div>
  );
}

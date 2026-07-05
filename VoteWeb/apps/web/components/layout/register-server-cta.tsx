'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useAuth } from '../providers/auth-context';

export function RegisterServerCta() {
  const { account, loading } = useAuth();

  const { href, label } = useMemo(() => {
    if (account) {
      return { href: '/servers/register', label: '서버 등록' };
    }
    return {
      href: '/login?returnTo=/servers/register',
      label: '등록 시작',
    };
  }, [account]);

  return (
    <Link
      href={href}
      className={`rounded-lg border border-emerald-300/40 bg-emerald-500/15 px-3.5 py-2 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/25 ${
        loading ? 'pointer-events-none opacity-60' : ''
      }`}
      prefetch={false}
    >
      {label}
    </Link>
  );
}

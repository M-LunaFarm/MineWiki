'use client';

import type { MinecraftIdentity } from '@minewiki/schemas';
import { ChevronDown, LayoutDashboard, LogOut, Server, Settings, ShieldCheck, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../providers/auth-context';
import { getApiBaseUrl } from '../../lib/runtime-config';

const API_BASE_URL = getApiBaseUrl();

function buildMinecraftAvatarCandidates(uuid: string): string[] {
  const compactUuid = uuid.replace(/-/g, '');
  return [
    `https://mc-heads.net/avatar/${compactUuid}/160`,
    `https://crafatar.com/avatars/${compactUuid}?size=160&overlay`,
  ];
}

export function AccountDropdown({
  open: controlledOpen,
  onOpenChange,
}: {
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
} = {}) {
  const { account, loading, logout } = useAuth();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [error, setError] = useState<string | null>(null);
  const [minecraftAvatarCandidates, setMinecraftAvatarCandidates] = useState<string[]>([]);
  const [minecraftAvatarIndex, setMinecraftAvatarIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pathname = usePathname();

  const setDropdownOpen = useCallback((next: boolean) => {
    if (controlledOpen === undefined) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  }, [controlledOpen, onOpenChange]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (!containerRef.current) {
        return;
      }
      if (!containerRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [setDropdownOpen]);

  useEffect(() => {
    let cancelled = false;
    setMinecraftAvatarCandidates([]);
    setMinecraftAvatarIndex(0);

    const loadMinecraftIdentity = async () => {
      if (!account || account.avatarUrl) {
        return;
      }

      try {
        const response = await fetch(`${API_BASE_URL}/v1/minecraft/identity`, {
          credentials: 'include',
        });

        if (cancelled || response.status === 404) {
          return;
        }
        if (!response.ok) {
          return;
        }

        const identity = (await response.json()) as MinecraftIdentity;
        if (!cancelled) {
          setMinecraftAvatarCandidates(buildMinecraftAvatarCandidates(identity.uuid));
        }
      } catch {
        if (!cancelled) {
          setMinecraftAvatarCandidates([]);
        }
      }
    };

    void loadMinecraftIdentity();
    return () => {
      cancelled = true;
    };
  }, [account]);

  const toggle = () => {
    setError(null);
    setDropdownOpen(!open);
  };

  const handleLogout = async () => {
    try {
      await logout();
    } finally {
      setDropdownOpen(false);
    }
  };

  const avatarInitial = (account?.displayName ?? account?.email ?? 'U').charAt(0).toUpperCase();
  const avatarImageSrc = account?.avatarUrl ?? minecraftAvatarCandidates[minecraftAvatarIndex] ?? null;

  const handleAvatarLoadError = () => {
    if (!account || account.avatarUrl) {
      return;
    }

    setMinecraftAvatarIndex((current) =>
      current < minecraftAvatarCandidates.length - 1 ? current + 1 : minecraftAvatarCandidates.length,
    );
  };

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        type="button"
        onClick={toggle}
        className="account-trigger flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[#30363d] bg-[#181a1d] px-2 py-2 text-sm font-medium text-[#e6e6e6] transition hover:border-[#13ec80]/40 hover:text-white sm:gap-2 sm:px-3"
        disabled={loading}
      >
        {account ? (
          <span className="relative flex h-6 w-6 items-center justify-center overflow-hidden rounded-md bg-[#13ec80]/20 text-xs font-bold text-[#13ec80]">
            {avatarImageSrc ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={avatarImageSrc}
                  alt={`${account.displayName ?? account.email ?? '사용자'} 아바타`}
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={handleAvatarLoadError}
                />
              </>
            ) : (
              avatarInitial
            )}
          </span>
        ) : null}
        <span className="max-w-[7rem] truncate max-[420px]:max-w-[4.5rem]">{account ? (account.displayName ?? account.email ?? '내 계정') : '로그인'}</span>
        <ChevronDown aria-hidden="true" className={`hidden h-4 w-4 transition-transform min-[360px]:block ${open ? 'rotate-180' : ''}`} />
      </button>

      {open ? (
        <div className="account-menu fixed inset-x-2 top-[4.5rem] z-40 max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-lg border border-[#30363d] bg-[#181a1d] p-3 text-sm text-[#e6e6e6] shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2.5 sm:w-[min(21rem,calc(100vw-1rem))]">
          {account ? (
            <div className="space-y-3">
              <div className="rounded-md border border-[#30363d] bg-[#111315] p-3 text-xs text-[#9ca3af]">
                <p className="text-[11px] uppercase tracking-[0.18em] text-[#6b7280]">Account</p>
                <div className="mt-2 flex items-start gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-md bg-[#13ec80]/15 text-sm font-bold text-[#13ec80]">
                    {avatarImageSrc ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={avatarImageSrc}
                        alt={`${account.displayName ?? account.email ?? '사용자'} 아바타`}
                        className="h-full w-full rounded-md object-cover"
                        onError={handleAvatarLoadError}
                      />
                    ) : (
                      avatarInitial
                    )}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">
                      {account.displayName ?? '표시 이름 미설정'}
                    </p>
                    <p className="mt-1 break-all text-[#9ca3af]">
                      {account.email ?? '이메일 정보가 없습니다.'}
                    </p>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="rounded border border-[#2a2a2d] px-1.5 py-0.5 text-[10px]">
                    {formatProviderLabel(account.provider)}
                  </span>
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] ${
                      account.emailVerified
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : 'border-amber-400/30 bg-amber-500/10 text-amber-300'
                    }`}
                  >
                    {account.emailVerified ? '이메일 인증 완료' : '이메일 인증 필요'}
                  </span>
                </div>
                <p className="mt-2 text-[11px] text-[#6b7280]">
                  최근 로그인: {formatDateTime(account.lastLoginAt)}
                </p>
                <p className="text-[11px] text-[#6b7280]">
                  연동 계정 수: {account.linkedAccounts.length}
                </p>
              </div>
              <Link
                className="block rounded-md border border-[#13ec80]/30 bg-[#13ec80]/10 px-3 py-2 text-center text-xs font-semibold text-[#13ec80] transition hover:bg-[#13ec80]/20"
                href="/me"
                onClick={() => setDropdownOpen(false)}
              >
                계정 및 보안 열기
              </Link>
              <nav className="flex flex-col gap-1">
                <Link
                  className="inline-flex items-center gap-2 rounded-md px-3 py-2 transition hover:bg-white/5 hover:text-[#13ec80]"
                  href="/servers/register"
                  onClick={() => setDropdownOpen(false)}
                >
                  <Server className="h-4 w-4" />
                  서버 등록
                </Link>
                <Link
                  className="inline-flex items-center gap-2 rounded-md px-3 py-2 transition hover:bg-white/5 hover:text-[#13ec80]"
                  href="/dashboard"
                  onClick={() => setDropdownOpen(false)}
                >
                  <LayoutDashboard className="h-4 w-4" />
                  대시보드
                </Link>
                <Link
                  className="inline-flex items-center gap-2 rounded-md px-3 py-2 transition hover:bg-white/5 hover:text-[#13ec80]"
                  href="/me"
                  onClick={() => setDropdownOpen(false)}
                >
                  <Settings className="h-4 w-4" />
                  계정 관리
                </Link>
                <Link
                  className="inline-flex items-center gap-2 rounded-md px-3 py-2 transition hover:bg-white/5 hover:text-[#13ec80]"
                  href="/claim"
                  onClick={() => setDropdownOpen(false)}
                >
                  <ShieldCheck className="h-4 w-4" />
                  검증 마법사
                </Link>
              </nav>
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-[#30363d] px-3 py-2 text-xs font-semibold text-[#9ca3af] transition hover:border-rose-300/50 hover:text-rose-200"
                disabled={loading}
              >
                <LogOut className="h-4 w-4" />
                로그아웃
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-md border border-[#30363d] bg-[#111315] p-3">
                <p className="flex items-center gap-2 text-sm font-semibold text-white">
                  <UserRound className="h-4 w-4 text-[#13ec80]" />
                  로그인이 필요합니다.
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Discord, NAVER 또는 이메일 계정으로 로그인하실 수 있습니다.
                </p>
              </div>
              <Link
                href={`/login?returnTo=${encodeURIComponent(pathname || '/')}`}
                className="theme-on-brand w-full rounded-md border border-white/10 bg-[#4752c4] px-3 py-2 text-sm font-semibold text-white transition hover:bg-[#3c45a5] disabled:opacity-50"
                onClick={() => setDropdownOpen(false)}
              >
                Discord 로그인
              </Link>
              <Link
                href={`/login?returnTo=${encodeURIComponent(pathname || '/')}`}
                className="theme-on-brand w-full rounded-md border border-white/10 bg-[#087a42] px-3 py-2 text-sm font-semibold text-white transition hover:bg-[#066534] disabled:opacity-50"
                onClick={() => setDropdownOpen(false)}
              >
                NAVER 로그인
              </Link>
              <Link
                href="/login"
                className="block rounded-md border border-white/10 px-3 py-2 text-center text-xs font-semibold text-slate-300 transition hover:bg-white/5"
                onClick={() => setDropdownOpen(false)}
              >
                이메일 로그인/회원가입
              </Link>
              {error ? <p className="text-xs text-amber-300">{error}</p> : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
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

function formatDateTime(value?: string | null): string {
  if (!value) {
    return '기록 없음';
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return '기록 없음';
  }
  return new Date(parsed).toLocaleString('ko-KR');
}

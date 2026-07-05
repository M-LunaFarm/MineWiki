'use client';

import type { MinecraftIdentity } from '@creepervote/schemas';
import { ChevronDown, LayoutDashboard, LogOut, Server, Settings, ShieldCheck, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
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

export function AccountDropdown() {
  const { account, loading, loginOAuth, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minecraftAvatarCandidates, setMinecraftAvatarCandidates] = useState<string[]>([]);
  const [minecraftAvatarIndex, setMinecraftAvatarIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (!containerRef.current) {
        return;
      }
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

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
    setOpen((value) => !value);
  };

  const handleOAuth = async (provider: 'discord' | 'naver') => {
    setError(null);
    try {
      const search = typeof window !== 'undefined' ? window.location.search : '';
      const returnTo = `${pathname ?? ''}${search}`;
      await loginOAuth(provider, { returnTo });
    } catch (oauthIssue) {
      const message =
        oauthIssue instanceof Error ? oauthIssue.message : '로그인을 시작하지 못했습니다.';
      setError(message);
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
    } finally {
      setOpen(false);
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
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        className="flex min-h-10 items-center gap-2 rounded-md border border-[#30363d] bg-[#181a1d] px-3 py-2 text-sm font-medium text-[#e6e6e6] transition hover:border-[#13ec80]/40 hover:text-white"
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
        <span>{account ? (account.displayName ?? account.email ?? '내 계정') : '로그인'}</span>
        <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open ? (
        <div className="absolute right-0 z-40 mt-2.5 w-[21rem] overflow-hidden rounded-lg border border-[#30363d] bg-[#181a1d] p-3 text-sm text-[#e6e6e6] shadow-xl">
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
                onClick={() => setOpen(false)}
              >
                계정 및 보안 열기
              </Link>
              <nav className="flex flex-col gap-1">
                <Link
                  className="inline-flex items-center gap-2 rounded-md px-3 py-2 transition hover:bg-white/5 hover:text-[#13ec80]"
                  href="/servers/register"
                  onClick={() => setOpen(false)}
                >
                  <Server className="h-4 w-4" />
                  서버 등록
                </Link>
                <Link
                  className="inline-flex items-center gap-2 rounded-md px-3 py-2 transition hover:bg-white/5 hover:text-[#13ec80]"
                  href="/dashboard"
                  onClick={() => setOpen(false)}
                >
                  <LayoutDashboard className="h-4 w-4" />
                  대시보드
                </Link>
                <Link
                  className="inline-flex items-center gap-2 rounded-md px-3 py-2 transition hover:bg-white/5 hover:text-[#13ec80]"
                  href="/me"
                  onClick={() => setOpen(false)}
                >
                  <Settings className="h-4 w-4" />
                  계정 관리
                </Link>
                <Link
                  className="inline-flex items-center gap-2 rounded-md px-3 py-2 transition hover:bg-white/5 hover:text-[#13ec80]"
                  href="/claim"
                  onClick={() => setOpen(false)}
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
              <button
                type="button"
                onClick={() => void handleOAuth('discord')}
                className="w-full rounded-md border border-white/10 bg-[#5865F2]/85 px-3 py-2 text-sm font-semibold text-white transition hover:bg-[#4752c4] disabled:opacity-50"
                disabled={loading}
              >
                Discord 로그인
              </button>
              <button
                type="button"
                onClick={() => void handleOAuth('naver')}
                className="w-full rounded-md border border-white/10 bg-[#03C75A]/85 px-3 py-2 text-sm font-semibold text-white transition hover:bg-[#029b48] disabled:opacity-50"
                disabled={loading}
              >
                NAVER 로그인
              </button>
              <Link
                href="/login"
                className="block rounded-md border border-white/10 px-3 py-2 text-center text-xs font-semibold text-slate-300 transition hover:bg-white/5"
                onClick={() => setOpen(false)}
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

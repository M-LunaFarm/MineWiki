'use client';

import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  Camera,
  CheckCircle2,
  Copy,
  KeyRound,
  Link2,
  Loader2,
  Mail,
  ShieldCheck,
  Trash2,
  UserRound,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MinecraftIdentity, OAuthProvider } from '@minewiki/schemas';
import { SessionList } from '../../components/account/session-list';
import { MinecraftOwnershipPanel } from '../../components/minecraft/ownership-panel';
import { useAuth } from '../../components/providers/auth-context';
import { SiteHeader } from '../../components/layout/site-header';
import {
  changePassword,
  clearProfileAvatar,
  createAccountMergeRequest,
  fetchAccountLinkConflicts,
  resendVerification,
  setupEmailLogin,
  startOAuthLink,
  updateDisplayName,
  updateProfileAvatar,
  type AccountLinkConflict,
} from '../../lib/auth-client';
import { getApiBaseUrl } from '../../lib/runtime-config';

const API_BASE_URL = getApiBaseUrl();

const LINKABLE_PROVIDERS: OAuthProvider[] = ['discord', 'naver'];

type FeedbackState = {
  readonly type: 'success' | 'error';
  readonly text: string;
};

type ServiceConnection = {
  readonly provider: OAuthProvider;
  readonly connected: boolean;
  readonly primary: boolean;
  readonly detail?: string;
};

const PROVIDER_LABEL: Record<OAuthProvider | 'email', string> = {
  discord: 'Discord',
  naver: 'NAVER',
  email: '이메일/비밀번호',
};

const PROVIDER_BADGE_STYLE: Record<OAuthProvider | 'email', string> = {
  discord: 'border-[#5865f2]/40 bg-[#5865f2]/20 text-[#d9dcff]',
  naver: 'border-[#03c75a]/35 bg-[#03c75a]/15 text-[#b8f3d2]',
  email: 'border-[#13ec80]/35 bg-[#13ec80]/15 text-[#b9f8d9]',
};

function buildMinecraftAvatarCandidates(uuid: string): string[] {
  const compactUuid = uuid.replace(/-/g, '');
  return [
    `https://mc-heads.net/avatar/${compactUuid}/160`,
    `https://crafatar.com/avatars/${compactUuid}?size=160&overlay`,
  ];
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('이미지 파일을 읽을 수 없습니다.'));
    reader.readAsDataURL(file);
  });
}

function FeedbackText({ feedback }: { feedback: FeedbackState | null }) {
  if (!feedback) {
    return null;
  }

  return (
    <p
      className={`mt-2 text-xs ${
        feedback.type === 'success' ? 'text-emerald-300' : 'text-red-300'
      }`}
    >
      {feedback.text}
    </p>
  );
}

export function AccountClientPage() {
  const { account, loading, refresh } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !account) {
      router.replace('/login?returnTo=/me');
    }
  }, [account, loading, router]);

  const [displayName, setDisplayName] = useState('');
  const [displayNameFeedback, setDisplayNameFeedback] = useState<FeedbackState | null>(null);
  const [savingDisplayName, setSavingDisplayName] = useState(false);

  const [linkingProvider, setLinkingProvider] = useState<OAuthProvider | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const [resending, setResending] = useState(false);
  const [resendFeedback, setResendFeedback] = useState<FeedbackState | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordFeedback, setPasswordFeedback] = useState<FeedbackState | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);

  const [setupEmail, setSetupEmail] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupConfirmPassword, setSetupConfirmPassword] = useState('');
  const [setupFeedback, setSetupFeedback] = useState<FeedbackState | null>(null);
  const [settingUpEmail, setSettingUpEmail] = useState(false);

  const [copyFeedback, setCopyFeedback] = useState<FeedbackState | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [avatarFeedback, setAvatarFeedback] = useState<FeedbackState | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [removingAvatar, setRemovingAvatar] = useState(false);
  const [minecraftAvatarCandidates, setMinecraftAvatarCandidates] = useState<string[]>([]);
  const [minecraftAvatarIndex, setMinecraftAvatarIndex] = useState(0);
  const [linkConflicts, setLinkConflicts] = useState<AccountLinkConflict[]>([]);
  const [loadingConflicts, setLoadingConflicts] = useState(false);
  const [mergeRequestMessage, setMergeRequestMessage] = useState('');
  const [mergeRequestTicketId, setMergeRequestTicketId] = useState<string | null>(null);
  const [mergeRequestFeedback, setMergeRequestFeedback] = useState<FeedbackState | null>(null);
  const [creatingMergeRequest, setCreatingMergeRequest] = useState(false);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (account) {
      setDisplayName(account.displayName ?? account.email ?? '');
    }
  }, [account]);

  useEffect(() => {
    let cancelled = false;
    setLinkConflicts([]);
    setMergeRequestTicketId(null);

    const loadConflicts = async () => {
      if (!account) {
        return;
      }
      setLoadingConflicts(true);
      setMergeRequestFeedback(null);
      try {
        const response = await fetchAccountLinkConflicts();
        if (!cancelled) {
          setLinkConflicts(response.conflicts);
        }
      } catch (error) {
        if (!cancelled) {
          setMergeRequestFeedback({
            type: 'error',
            text: error instanceof Error ? error.message : '계정 충돌 정보를 불러오지 못했습니다.',
          });
        }
      } finally {
        if (!cancelled) {
          setLoadingConflicts(false);
        }
      }
    };

    void loadConflicts();
    return () => {
      cancelled = true;
    };
  }, [account]);

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

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      if (event.data?.type === 'oauth-link-complete') {
        setLinkingProvider(null);
        setLinkError(null);
        void refresh();
      }
      if (event.data?.type === 'oauth-link-error') {
        setLinkingProvider(null);
        setLinkError(
          typeof event.data.message === 'string'
            ? event.data.message
            : '계정 연동이 완료되지 않았습니다.',
        );
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refresh]);

  const connectedProviders = useMemo(() => {
    const providers = new Set<OAuthProvider>();
    if (!account) {
      return providers;
    }

    if (account.provider === 'discord' || account.provider === 'naver') {
      providers.add(account.provider);
    }

    for (const linked of account.linkedAccounts) {
      if (linked.provider === 'discord' || linked.provider === 'naver') {
        providers.add(linked.provider);
      }
    }

    return providers;
  }, [account]);

  const linkedAccountSummaries = useMemo(
    () =>
      account
        ? account.linkedAccounts
            .filter((linked) => linked.provider === 'discord' || linked.provider === 'naver')
            .map((linked) => ({
              provider: linked.provider,
              displayName: linked.displayName ?? undefined,
              email: linked.email ?? undefined,
            }))
        : [],
    [account],
  );

  const serviceConnections: ServiceConnection[] = useMemo(() => {
    if (!account) {
      return [];
    }

    return LINKABLE_PROVIDERS.map((provider) => {
      const linked =
        account.provider === provider
          ? {
              displayName: account.displayName ?? undefined,
              email: account.email ?? undefined,
            }
          : linkedAccountSummaries.find((item) => item.provider === provider);

      const connected = connectedProviders.has(provider) || account.provider === provider;
      const primary = account.provider === provider;
      const detail = linked?.displayName ?? linked?.email;

      return {
        provider,
        connected,
        primary,
        detail,
      };
    });
  }, [account, connectedProviders, linkedAccountSummaries]);

  const emailAddress = useMemo(() => {
    if (!account) {
      return undefined;
    }

    if (account.email) {
      return account.email;
    }

    if (account.provider === 'email') {
      return account.providerUserId;
    }

    return undefined;
  }, [account]);

  const hasPasswordLogin = Boolean(account?.hasPassword);
  const displayIdentity = account?.displayName ?? emailAddress ?? '사용자';
  const avatarInitial = displayIdentity.charAt(0).toUpperCase();
  const avatarImageSrc =
    account?.avatarUrl ?? minecraftAvatarCandidates[minecraftAvatarIndex] ?? null;
  const isMinecraftAvatarFallback = Boolean(!account?.avatarUrl && avatarImageSrc);

  const createdAt = account ? new Date(account.createdAt).toLocaleDateString('ko-KR') : '-';
  const lastLogin = account?.lastLoginAt
    ? new Date(account.lastLoginAt).toLocaleString('ko-KR')
    : '기록 없음';

  const handleDisplayNameSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = displayName.trim();
    if (!trimmed) {
      setDisplayNameFeedback({ type: 'error', text: '표시 이름을 입력해 주세요.' });
      return;
    }

    setSavingDisplayName(true);
    setDisplayNameFeedback(null);

    try {
      await updateDisplayName(trimmed);
      await refresh();
      setDisplayNameFeedback({ type: 'success', text: '표시 이름이 저장되었습니다.' });
    } catch (error) {
      setDisplayNameFeedback({
        type: 'error',
        text: error instanceof Error ? error.message : '표시 이름을 저장하지 못했습니다.',
      });
    } finally {
      setSavingDisplayName(false);
    }
  };

  const handleCopyAccountId = async () => {
    if (!account) {
      return;
    }

    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
    }

    try {
      await navigator.clipboard.writeText(account.id);
      setCopyFeedback({ type: 'success', text: '계정 ID를 복사했습니다.' });
    } catch (error) {
      setCopyFeedback({
        type: 'error',
        text: error instanceof Error ? error.message : '계정 ID 복사에 실패했습니다.',
      });
    }

    copyTimerRef.current = setTimeout(() => setCopyFeedback(null), 2500);
  };

  const handleAvatarFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      setAvatarFeedback({ type: 'error', text: '이미지 파일만 업로드할 수 있습니다.' });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setAvatarFeedback({ type: 'error', text: '이미지는 2MB 이하로 업로드해 주세요.' });
      return;
    }

    setUploadingAvatar(true);
    setAvatarFeedback(null);
    try {
      const data = await readFileAsDataUrl(file);
      await updateProfileAvatar({ data, filename: file.name });
      await refresh();
      setAvatarFeedback({ type: 'success', text: '프로필 이미지가 변경되었습니다.' });
    } catch (error) {
      setAvatarFeedback({
        type: 'error',
        text: error instanceof Error ? error.message : '프로필 이미지 변경에 실패했습니다.',
      });
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleClearAvatar = async () => {
    setRemovingAvatar(true);
    setAvatarFeedback(null);
    try {
      await clearProfileAvatar();
      await refresh();
      setAvatarFeedback({ type: 'success', text: '기본 프로필 이미지로 되돌렸습니다.' });
    } catch (error) {
      setAvatarFeedback({
        type: 'error',
        text: error instanceof Error ? error.message : '프로필 이미지 초기화에 실패했습니다.',
      });
    } finally {
      setRemovingAvatar(false);
    }
  };

  const handleAvatarLoadError = () => {
    if (account?.avatarUrl) {
      return;
    }

    setMinecraftAvatarIndex((current) =>
      current < minecraftAvatarCandidates.length - 1
        ? current + 1
        : minecraftAvatarCandidates.length,
    );
  };

  const handleLinkProvider = async (provider: OAuthProvider) => {
    if (typeof window === 'undefined') {
      return;
    }

    setLinkError(null);
    setLinkingProvider(provider);

    try {
      const redirectUri = `${window.location.origin}/auth/callback/${provider}`;
      const result = await startOAuthLink(provider, {
        redirectUri,
        returnTo: '/me',
      });

      const popup = window.open(
        result.authorizationUrl,
        `oauth-link-${provider}`,
        'width=520,height=720',
      );

      if (!popup) {
        throw new Error('새 창을 열 수 없습니다. 팝업 차단 설정을 확인해 주세요.');
      }
      popup.focus();
      const closeTimer = window.setInterval(() => {
        if (!popup.closed) {
          return;
        }
        window.clearInterval(closeTimer);
        setLinkingProvider((current) => {
          if (current === provider) {
            setLinkError('계정 연동 창이 닫혔습니다. 연동을 완료하지 못했습니다.');
            return null;
          }
          return current;
        });
      }, 800);
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : '계정 연동을 시작하지 못했습니다.');
      setLinkingProvider(null);
    }
  };

  const handleResendEmail = async () => {
    if (!emailAddress) {
      setResendFeedback({ type: 'error', text: '연결된 이메일이 없습니다.' });
      return;
    }

    setResending(true);
    setResendFeedback(null);
    try {
      await resendVerification(emailAddress);
      setResendFeedback({ type: 'success', text: '인증 메일을 다시 보냈습니다.' });
    } catch (error) {
      setResendFeedback({
        type: 'error',
        text: error instanceof Error ? error.message : '인증 메일 재전송에 실패했습니다.',
      });
    } finally {
      setResending(false);
    }
  };

  const handleSetupEmailLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSetupFeedback(null);

    const email = setupEmail.trim().toLowerCase();
    if (!email) {
      setSetupFeedback({ type: 'error', text: '이메일을 입력해 주세요.' });
      return;
    }
    if (!setupPassword || !setupConfirmPassword) {
      setSetupFeedback({ type: 'error', text: '비밀번호와 확인 값을 모두 입력해 주세요.' });
      return;
    }
    if (setupPassword !== setupConfirmPassword) {
      setSetupFeedback({ type: 'error', text: '비밀번호 확인이 일치하지 않습니다.' });
      return;
    }

    setSettingUpEmail(true);
    try {
      await setupEmailLogin({ email, password: setupPassword });
      await refresh();
      setSetupFeedback({
        type: 'success',
        text: '이메일 로그인을 설정했습니다. 인증 메일을 확인해 주세요.',
      });
      setSetupPassword('');
      setSetupConfirmPassword('');
    } catch (error) {
      setSetupFeedback({
        type: 'error',
        text: error instanceof Error ? error.message : '이메일 로그인 설정에 실패했습니다.',
      });
    } finally {
      setSettingUpEmail(false);
    }
  };

  const handleChangePassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPasswordFeedback(null);

    if (!currentPassword || !newPassword) {
      setPasswordFeedback({ type: 'error', text: '현재 비밀번호와 새 비밀번호를 입력해 주세요.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordFeedback({ type: 'error', text: '새 비밀번호 확인이 일치하지 않습니다.' });
      return;
    }

    setChangingPassword(true);
    try {
      await changePassword({ currentPassword, newPassword });
      await refresh();
      setPasswordFeedback({ type: 'success', text: '비밀번호가 변경되었습니다.' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (error) {
      setPasswordFeedback({
        type: 'error',
        text: error instanceof Error ? error.message : '비밀번호 변경에 실패했습니다.',
      });
    } finally {
      setChangingPassword(false);
    }
  };

  const handleCreateMergeRequest = async () => {
    setCreatingMergeRequest(true);
    setMergeRequestFeedback(null);
    try {
      const response = await createAccountMergeRequest({
        message: mergeRequestMessage.trim() || undefined,
      });
      setMergeRequestTicketId(response.ticketId);
      setMergeRequestFeedback({
        type: 'success',
        text: '지원 요청이 접수되었습니다. 고객센터에서 처리 상태를 확인해 주세요.',
      });
    } catch (error) {
      setMergeRequestFeedback({
        type: 'error',
        text: error instanceof Error ? error.message : '지원 요청을 만들지 못했습니다.',
      });
    } finally {
      setCreatingMergeRequest(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#121212] px-4 text-[#a0a0a0]">
        <div className="flex items-center gap-2 rounded-lg border border-[#30363d] bg-[#181a1d] px-4 py-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin text-[#13ec80]" />
          계정 정보를 불러오는 중입니다.
        </div>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#121212] px-4">
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-[#0d1416] px-4 py-3 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin text-[#35e5b7]" />
          안전한 로그인 화면으로 이동 중입니다.
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#121212] text-white">
      <SiteHeader />

      <main className="min-h-screen pb-16 pt-24">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <section className="mb-6 rounded-lg border border-[#30363d] bg-[#181a1d]">
            <div className="flex flex-col gap-4 border-b border-[#30363d] px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8f98a3]">
                  Account Settings
                </p>
                <h1 className="mt-1 text-2xl font-semibold text-white">계정 및 보안</h1>
                <p className="mt-1 text-sm text-[#b8c0c8]">
                  로그인 수단, 이메일 인증, 비밀번호, 활성 세션을 관리하실 수 있습니다.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <AccountState
                  icon={<ShieldCheck className="h-4 w-4" />}
                  label="이메일"
                  value={account.emailVerified ? '인증 완료' : '인증 필요'}
                  tone={account.emailVerified ? 'good' : 'warn'}
                />
                <AccountState
                  icon={<KeyRound className="h-4 w-4" />}
                  label="비밀번호"
                  value={hasPasswordLogin ? '설정됨' : '미설정'}
                  tone={hasPasswordLogin ? 'good' : 'warn'}
                />
                <AccountState
                  icon={<Link2 className="h-4 w-4" />}
                  label="연동 계정"
                  value={`${account.linkedAccounts.length}개`}
                  tone="neutral"
                />
              </div>
            </div>
          </section>

          <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
            <section className="rounded-lg border border-[#30363d] bg-[#181a1d] p-6 shadow-sm">
              <div className="mb-6 flex items-center gap-4">
                <div className="relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border border-[#3b4248] bg-[#23272b] text-2xl font-bold text-white">
                  {avatarImageSrc ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={avatarImageSrc}
                      alt={`${displayIdentity} 프로필`}
                      className="h-full w-full object-cover"
                      onError={handleAvatarLoadError}
                    />
                  ) : (
                    avatarInitial
                  )}
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">{displayIdentity}</h2>
                  <p className="text-sm text-[#a0a0a0]">
                    {emailAddress ?? '이메일이 등록되지 않았습니다.'}
                  </p>
                </div>
              </div>

              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => void handleAvatarFileChange(event)}
              />
              <div className="mb-6 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#13ec80]/35 bg-[#13ec80]/15 px-3 py-2 text-xs font-semibold text-[#13ec80] transition hover:bg-[#13ec80]/25 disabled:opacity-60"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={uploadingAvatar || removingAvatar}
                  >
                    <Camera className="h-3.5 w-3.5" />
                    {uploadingAvatar ? '업로드 중입니다.' : '프로필 이미지 변경'}
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-transparent px-3 py-2 text-xs font-semibold text-white transition hover:border-white/35 hover:bg-white/5 disabled:opacity-50"
                    onClick={() => void handleClearAvatar()}
                    disabled={!account.avatarUrl || uploadingAvatar || removingAvatar}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {removingAvatar ? '초기화 중입니다.' : '기본 이미지로'}
                  </button>
                </div>
                {isMinecraftAvatarFallback ? (
                  <p className="text-xs text-[#8f9bab]">
                    등록된 이미지가 없어 Minecraft 스킨 머리를 표시하고 있습니다.
                  </p>
                ) : null}
                <FeedbackText feedback={avatarFeedback} />
              </div>

              <form className="space-y-4" onSubmit={handleDisplayNameSubmit}>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#a0a0a0]">표시 이름</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={displayName}
                      onChange={(event) => {
                        setDisplayName(event.target.value);
                        setDisplayNameFeedback(null);
                      }}
                      className="flex-1 rounded-md border border-[#30363d] bg-[#111315] px-3 py-2 text-sm text-white outline-none transition focus:border-[#13ec80]"
                      maxLength={32}
                      required
                    />
                    <button
                      type="submit"
                      className="rounded-md bg-[#13ec80]/15 px-3 py-2 text-sm font-semibold text-[#13ec80] transition hover:bg-[#13ec80]/25 disabled:opacity-60"
                      disabled={savingDisplayName}
                    >
                      {savingDisplayName ? '저장 중' : '저장'}
                    </button>
                  </div>
                  <FeedbackText feedback={displayNameFeedback} />
                </div>
              </form>

              <div className="mt-4">
                <label className="mb-1 block text-xs font-medium text-[#a0a0a0]">계정 ID</label>
                <div className="flex items-center gap-2 rounded-md border border-[#30363d] bg-[#111315] px-3 py-2">
                  <code className="flex-1 truncate font-mono text-xs text-[#c3cbd4]">
                    {account.id}
                  </code>
                  <button
                    type="button"
                    className="text-[#a0a0a0] transition hover:text-white"
                    onClick={() => void handleCopyAccountId()}
                    aria-label="계정 ID 복사"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
                <FeedbackText feedback={copyFeedback} />
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${PROVIDER_BADGE_STYLE[account.provider]}`}
                >
                  {PROVIDER_LABEL[account.provider]}
                </span>
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                    account.emailVerified
                      ? 'border-emerald-500/35 bg-emerald-500/15 text-emerald-300'
                      : 'border-amber-500/35 bg-amber-500/15 text-amber-200'
                  }`}
                >
                  {account.emailVerified ? '이메일 인증 완료' : '이메일 인증 필요'}
                </span>
              </div>
            </section>

            <section className="rounded-lg border border-[#30363d] bg-[#181a1d] p-6 shadow-sm">
              <h3 className="mb-6 flex items-center gap-2 text-lg font-bold text-white">
                <Activity className="h-5 w-5 text-[#13ec80]" />
                계정 요약
              </h3>

              <div className="space-y-5">
                <SummaryRow label="로그인 방식" value={PROVIDER_LABEL[account.provider]} />
                <SummaryRow label="가입일" value={createdAt} />
                <SummaryRow label="마지막 로그인" value={lastLogin} />

                <div className="pt-2">
                  <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[#a0a0a0]">
                    연결 서비스
                  </h4>
                  <div className="space-y-3">
                    {serviceConnections.map((service) => {
                      const badgeClass = PROVIDER_BADGE_STYLE[service.provider];
                      return (
                        <div
                          key={service.provider}
                          className="flex items-center justify-between gap-2"
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span
                                className={`inline-flex rounded border px-2 py-0.5 text-[11px] font-semibold ${badgeClass}`}
                              >
                                {PROVIDER_LABEL[service.provider]}
                              </span>
                              {service.primary ? (
                                <span className="rounded border border-[#13ec80]/35 bg-[#13ec80]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#13ec80]">
                                  기본 로그인
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-1 text-xs text-[#a0a0a0]">
                              {service.connected
                                ? (service.detail ?? '연동 완료')
                                : '아직 연동되지 않았습니다.'}
                            </p>
                          </div>
                          {service.connected ? (
                            <span className="text-xs font-medium text-emerald-300">연동됨</span>
                          ) : (
                            <button
                              type="button"
                              className="text-xs font-medium text-[#13ec80] transition hover:text-[#35f29a] disabled:opacity-60"
                              onClick={() => void handleLinkProvider(service.provider)}
                              disabled={linkingProvider === service.provider}
                            >
                              {linkingProvider === service.provider ? '연동 중입니다.' : '연동하기'}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {linkError ? (
                    <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                      {linkError}
                    </p>
                  ) : null}
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-[#30363d] bg-[#181a1d] p-6 shadow-sm">
              <h3 className="mb-4 flex items-center gap-2 text-lg font-bold text-white">
                <Mail className="h-5 w-5 text-[#13ec80]" />
                이메일 설정
              </h3>
              <p className="mb-6 text-sm leading-relaxed text-[#a0a0a0]">
                계정 보안과 복구를 위해 이메일 인증이 필요합니다.
              </p>

              <div className="mb-6 rounded-md border border-[#30363d] bg-[#111315] p-4">
                <div className="mb-1 flex items-center gap-2">
                  {account.emailVerified ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <UserRound className="h-4 w-4 text-amber-400" />
                  )}
                  <span className="text-sm font-medium text-white">
                    {emailAddress ?? '연결된 이메일이 없습니다.'}
                  </span>
                </div>
                <p className="pl-6 text-xs text-[#a0a0a0]">
                  {account.emailVerified
                    ? '이메일 인증이 완료되었습니다.'
                    : '이메일 인증이 필요합니다.'}
                </p>
              </div>

              {!hasPasswordLogin ? (
                <form className="space-y-3" onSubmit={handleSetupEmailLogin}>
                  <input
                    type="email"
                    placeholder="이메일"
                    value={setupEmail}
                    onChange={(event) => {
                      setSetupEmail(event.target.value);
                      setSetupFeedback(null);
                    }}
                    className="w-full rounded-md border border-[#30363d] bg-[#111315] px-3 py-2 text-sm text-white outline-none transition focus:border-[#13ec80]"
                    required
                    disabled={settingUpEmail}
                  />
                  <input
                    type="password"
                    placeholder="새 비밀번호"
                    value={setupPassword}
                    onChange={(event) => {
                      setSetupPassword(event.target.value);
                      setSetupFeedback(null);
                    }}
                    className="w-full rounded-md border border-[#30363d] bg-[#111315] px-3 py-2 text-sm text-white outline-none transition focus:border-[#13ec80]"
                    required
                    disabled={settingUpEmail}
                  />
                  <input
                    type="password"
                    placeholder="새 비밀번호 확인"
                    value={setupConfirmPassword}
                    onChange={(event) => {
                      setSetupConfirmPassword(event.target.value);
                      setSetupFeedback(null);
                    }}
                    className="w-full rounded-md border border-[#30363d] bg-[#111315] px-3 py-2 text-sm text-white outline-none transition focus:border-[#13ec80]"
                    required
                    disabled={settingUpEmail}
                  />
                  <button
                    type="submit"
                    className="w-full rounded-md border border-[#13ec80]/35 bg-[#13ec80]/15 px-4 py-2.5 text-sm font-semibold text-[#13ec80] transition hover:bg-[#13ec80]/25 disabled:opacity-60"
                    disabled={settingUpEmail}
                  >
                    {settingUpEmail ? '설정 중입니다.' : '이메일 로그인 설정'}
                  </button>
                  <FeedbackText feedback={setupFeedback} />
                </form>
              ) : (
                <div className="mt-auto">
                  <button
                    type="button"
                    onClick={() => void handleResendEmail()}
                    disabled={account.emailVerified || !emailAddress || resending}
                    className="flex w-full items-center justify-center gap-2 rounded-md border border-white/15 bg-transparent px-4 py-2.5 text-sm font-medium text-white transition hover:border-[#13ec80] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {resending ? '전송 중입니다.' : '인증 메일 재전송'}
                  </button>
                  <p className="mt-2 text-center text-xs text-[#a0a0a0]">
                    {account.emailVerified
                      ? '이미 인증된 계정입니다.'
                      : '이메일 인증이 필요합니다.'}
                  </p>
                  <FeedbackText feedback={resendFeedback} />
                </div>
              )}
            </section>
          </div>

          <AccountConflictPanel
            conflicts={linkConflicts}
            loading={loadingConflicts}
            message={mergeRequestMessage}
            feedback={mergeRequestFeedback}
            ticketId={mergeRequestTicketId}
            submitting={creatingMergeRequest}
            onMessageChange={setMergeRequestMessage}
            onCreateRequest={() => void handleCreateMergeRequest()}
          />

          <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section className="rounded-lg border border-[#30363d] bg-[#181a1d] p-6 shadow-sm">
              <h3 className="mb-6 flex items-center gap-2 text-lg font-bold text-white">
                <KeyRound className="h-5 w-5 text-[#13ec80]" />
                비밀번호 변경
              </h3>

              {hasPasswordLogin ? (
                <form className="space-y-4" onSubmit={handleChangePassword}>
                  <FieldLabel label="현재 비밀번호">
                    <input
                      type="password"
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                      className="w-full rounded-md border border-[#30363d] bg-[#111315] px-3 py-2.5 text-sm text-white outline-none transition focus:border-[#13ec80]"
                      placeholder="현재 비밀번호"
                      required
                      disabled={changingPassword}
                    />
                  </FieldLabel>

                  <FieldLabel label="새 비밀번호">
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      className="w-full rounded-md border border-[#30363d] bg-[#111315] px-3 py-2.5 text-sm text-white outline-none transition focus:border-[#13ec80]"
                      placeholder="새 비밀번호"
                      required
                      disabled={changingPassword}
                    />
                  </FieldLabel>

                  <FieldLabel label="새 비밀번호 확인">
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      className="w-full rounded-md border border-[#30363d] bg-[#111315] px-3 py-2.5 text-sm text-white outline-none transition focus:border-[#13ec80]"
                      placeholder="새 비밀번호 확인"
                      required
                      disabled={changingPassword}
                    />
                  </FieldLabel>

                  <div className="flex justify-end pt-1">
                    <button
                      type="submit"
                      className="rounded-md bg-[#13ec80] px-6 py-2.5 text-sm font-semibold text-black transition hover:bg-[#35f29a] disabled:opacity-60"
                      disabled={changingPassword}
                    >
                      {changingPassword ? '변경 중입니다.' : '비밀번호 변경'}
                    </button>
                  </div>

                  <FeedbackText feedback={passwordFeedback} />
                </form>
              ) : (
                <p className="rounded-md border border-[#30363d] bg-[#111315] px-4 py-3 text-sm text-[#a0a0a0]">
                  현재 계정은 OAuth 전용입니다. 이메일 설정에서 이메일/비밀번호를 먼저 설정해
                  주세요.
                </p>
              )}
            </section>

            <SessionList />
          </div>

          <MinecraftOwnershipPanel />
        </div>
      </main>
    </div>
  );
}

function AccountConflictPanel({
  conflicts,
  loading,
  message,
  feedback,
  ticketId,
  submitting,
  onMessageChange,
  onCreateRequest,
}: {
  readonly conflicts: AccountLinkConflict[];
  readonly loading: boolean;
  readonly message: string;
  readonly feedback: FeedbackState | null;
  readonly ticketId: string | null;
  readonly submitting: boolean;
  readonly onMessageChange: (message: string) => void;
  readonly onCreateRequest: () => void;
}) {
  if (!loading && conflicts.length === 0 && !feedback) {
    return null;
  }

  return (
    <section className="mb-6 rounded-lg border border-[#30363d] bg-[#181a1d] p-6 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl">
          <h3 className="flex items-center gap-2 text-lg font-bold text-white">
            <AlertTriangle className="h-5 w-5 text-amber-300" />
            계정 연동 충돌
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-[#a0a0a0]">
            Discord 또는 Minecraft 계정이 다른 MineWiki 계정과 충돌하면 자동 병합하지 않고
            지원팀 확인을 거칩니다.
          </p>
        </div>
        {ticketId ? (
          <Link
            href={`/support?ticket=${encodeURIComponent(ticketId)}`}
            className="inline-flex items-center justify-center rounded-md border border-[#13ec80]/35 bg-[#13ec80]/15 px-4 py-2 text-sm font-semibold text-[#13ec80] transition hover:bg-[#13ec80]/25"
          >
            티켓 보기
          </Link>
        ) : null}
      </div>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-[#a0a0a0]">
          <Loader2 className="h-4 w-4 animate-spin text-[#13ec80]" />
          계정 충돌을 확인하는 중입니다.
        </div>
      ) : null}

      {conflicts.length > 0 ? (
        <div className="mt-5 space-y-4">
          <div className="space-y-2">
            {conflicts.map((conflict) => (
              <div
                key={conflict.id}
                className="rounded-md border border-amber-400/25 bg-amber-400/[.08] px-4 py-3"
              >
                <p className="text-sm font-semibold text-amber-100">{conflict.message}</p>
                <p className="mt-1 break-all text-xs text-amber-100/75">
                  {conflict.minecraftUuid ? `Minecraft: ${conflict.minecraftUuid}` : null}
                  {conflict.minecraftUuid && conflict.discordUserId ? ' · ' : null}
                  {conflict.discordUserId ? `Discord: ${conflict.discordUserId}` : null}
                </p>
              </div>
            ))}
          </div>

          <textarea
            value={message}
            onChange={(event) => onMessageChange(event.target.value)}
            placeholder="지원팀에 전달할 내용을 입력하세요. 예: 두 계정 모두 본인 소유입니다."
            rows={3}
            maxLength={1000}
            className="w-full rounded-md border border-[#30363d] bg-[#111315] px-3 py-2 text-sm text-white outline-none transition placeholder:text-[#6f7882] focus:border-[#13ec80]"
            disabled={submitting || Boolean(ticketId)}
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-[#8f98a3]">
              요청은 고객센터 티켓으로 생성되며, 상담원이 승인 또는 반려 상태를 기록합니다.
            </p>
            <button
              type="button"
              className="inline-flex items-center justify-center gap-2 rounded-md bg-[#13ec80] px-4 py-2 text-sm font-semibold text-black transition hover:bg-[#35f29a] disabled:cursor-not-allowed disabled:opacity-60"
              onClick={onCreateRequest}
              disabled={submitting || Boolean(ticketId)}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {ticketId ? '요청 접수됨' : submitting ? '접수 중입니다.' : '지원 요청 만들기'}
            </button>
          </div>
        </div>
      ) : null}

      <FeedbackText feedback={feedback} />
    </section>
  );
}

function FieldLabel({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[#a0a0a0]">{label}</span>
      {children}
    </label>
  );
}

function AccountState({
  icon,
  label,
  value,
  tone,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: string;
  readonly tone: 'good' | 'warn' | 'neutral';
}) {
  const toneClass =
    tone === 'good'
      ? 'border-emerald-500/25 text-emerald-300'
      : tone === 'warn'
        ? 'border-amber-400/25 text-amber-200'
        : 'border-[#3b4248] text-[#d8dee5]';

  return (
    <div className={`min-w-[116px] rounded-md border bg-[#111315] px-3 py-2 ${toneClass}`}>
      <div className="flex items-center gap-2 text-[#8f98a3]">
        {icon}
        <span className="text-[11px] font-medium">{label}</span>
      </div>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

function SummaryRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#30363d] pb-3 text-sm">
      <span className="text-[#a0a0a0]">{label}</span>
      <span className="text-right font-medium text-white">{value}</span>
    </div>
  );
}

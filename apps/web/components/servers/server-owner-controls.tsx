'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { ServerDetail, VotifierTarget } from '@minewiki/schemas';
import { AlertCircle, BookOpen, CheckCircle2, Clock3, ExternalLink, Rocket, RotateCcw } from 'lucide-react';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import { useAuth } from '../providers/auth-context';
import { csrfHeaders } from '../../lib/csrf';
import { PrivilegedActionGate } from '../auth/privileged-action-gate';
import { ServerProfileSettings } from './server-profile-settings';
import { ServerWikiReadinessCard, type ServerWikiReadiness } from './server-wiki-readiness-card';

interface ServerOwnerControlsProps {
  readonly serverId: string;
  readonly apiBaseUrl?: string;
  readonly initialPolicy: boolean;
  readonly initialWikiUrl?: string | null;
  readonly initialProfile: Pick<
    ServerDetail,
    | 'name'
    | 'tags'
    | 'shortDescription'
    | 'longDescription'
    | 'websiteUrl'
    | 'discordUrl'
    | 'bannerUrl'
  >;
  readonly className?: string;
}

type EditableTarget = {
  protocol: 'v2' | 'v1';
  host: string;
  port: string;
  token: string;
  tokenConfigured: boolean;
  publicKey: string;
};

type FeedbackState = {
  readonly type: 'success' | 'error';
  readonly message: string;
};

type DispatchAttemptSummary = {
  readonly id: string;
  readonly protocol: 'v1' | 'v2';
  readonly status: string;
  readonly attempts: number;
  readonly error: string | null;
  readonly lastAttemptAt: string | null;
  readonly createdAt: string;
  readonly username: string;
  readonly votedAt: string;
  readonly target: {
    readonly host: string | null;
    readonly port: number | null;
  };
};

type DispatchSummary = {
  readonly recent: DispatchAttemptSummary[];
  readonly failed: DispatchAttemptSummary[];
};

type ServerWikiLinkResponse = {
  readonly wikiSlug: string | null;
  readonly wikiUrl: string | null;
  readonly status: 'linked' | 'unlinked';
};

function createDefaultTargets(): EditableTarget[] {
  return [
    { protocol: 'v2', host: '', port: '8192', token: '', tokenConfigured: false, publicKey: '' },
    { protocol: 'v1', host: '', port: '8193', token: '', tokenConfigured: false, publicKey: '' },
  ];
}

function serverWikiUrl(slug?: string | null): string | null {
  return slug ? `/serverWiki/${encodeURIComponent(slug)}` : null;
}

function mergeTargets(targets: ReadonlyArray<VotifierTarget>): EditableTarget[] {
  const defaults = createDefaultTargets();
  for (const target of targets) {
    const match = defaults.find((entry) => entry.protocol === target.protocol);
    if (match) {
      match.host = target.host;
      match.port = String(target.port);
      match.token = target.token ?? '';
      match.tokenConfigured = target.tokenConfigured ?? false;
      match.publicKey = target.publicKey ?? '';
    }
  }
  return defaults;
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return '-';
  }
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function statusTone(status: string): string {
  if (status === 'success') {
    return 'text-emerald-300';
  }
  if (status === 'failed') {
    return 'text-red-300';
  }
  if (status === 'processing') {
    return 'text-sky-300';
  }
  return 'text-amber-300';
}

function statusLabel(status: string): string {
  if (status === 'success') {
    return '성공';
  }
  if (status === 'failed') {
    return '실패';
  }
  if (status === 'processing') {
    return '전달 중';
  }
  return '대기';
}

export function ServerOwnerControls({
  serverId,
  apiBaseUrl,
  initialPolicy,
  initialWikiUrl,
  initialProfile,
  className,
}: ServerOwnerControlsProps) {
  const { account } = useAuth();
  const router = useRouter();
  const [isOwner, setIsOwner] = useState(false);
  const [requiresOwnership, setRequiresOwnership] = useState(initialPolicy);
  const [wikiUrl, setWikiUrl] = useState<string | null>(initialWikiUrl ?? null);
  const [wikiReadiness, setWikiReadiness] = useState<ServerWikiReadiness | null>(null);
  const [creatingWiki, setCreatingWiki] = useState(false);
  const [wikiFeedback, setWikiFeedback] = useState<FeedbackState | null>(null);
  const [saving, setSaving] = useState(false);
  const [votifierTargets, setVotifierTargets] = useState<EditableTarget[]>(createDefaultTargets());
  const [loadingVotifier, setLoadingVotifier] = useState(false);
  const [savingVotifier, setSavingVotifier] = useState(false);
  const [votifierFeedback, setVotifierFeedback] = useState<FeedbackState | null>(null);
  const [dispatchSummary, setDispatchSummary] = useState<DispatchSummary>({
    recent: [],
    failed: [],
  });
  const [loadingDispatch, setLoadingDispatch] = useState(false);
  const [replayingAttempt, setReplayingAttempt] = useState<string | null>(null);
  const [dispatchFeedback, setDispatchFeedback] = useState<FeedbackState | null>(null);
  const baseUrl = normalizeApiBaseUrl(apiBaseUrl);

  const fetchVotifierTargets = useCallback(async () => {
    setLoadingVotifier(true);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${serverId}/votifier`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(`Votifier 설정을 불러오지 못했습니다. (${response.status})`);
      }
      const payload = (await response.json()) as { targets?: VotifierTarget[] };
      setVotifierTargets(mergeTargets(payload?.targets ?? []));
      setVotifierFeedback(null);
    } catch (error) {
      console.warn('Votifier 설정 로드 실패', error);
      setVotifierFeedback({
        type: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Votifier 설정을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.',
      });
      setVotifierTargets(createDefaultTargets());
    } finally {
      setLoadingVotifier(false);
    }
  }, [baseUrl, serverId]);

  const fetchDispatchAttempts = useCallback(async () => {
    setLoadingDispatch(true);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${serverId}/vote-dispatch-attempts`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(`투표 전달 기록을 불러오지 못했습니다. (${response.status})`);
      }
      const payload = (await response.json()) as DispatchSummary;
      setDispatchSummary({
        recent: payload.recent ?? [],
        failed: payload.failed ?? [],
      });
      setDispatchFeedback(null);
    } catch (error) {
      console.warn('투표 전달 기록 로드 실패', error);
      setDispatchSummary({ recent: [], failed: [] });
      setDispatchFeedback({
        type: 'error',
        message:
          error instanceof Error
            ? error.message
            : '투표 전달 기록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.',
      });
    } finally {
      setLoadingDispatch(false);
    }
  }, [baseUrl, serverId]);

  const fetchWikiReadiness = useCallback(async () => {
    const response = await fetch(`${baseUrl}/v1/servers/${serverId}/wiki-readiness`, {
      credentials: 'include',
    });
    if (!response.ok) {
      throw new Error(`서버 위키 준비 상태를 불러오지 못했습니다. (${response.status})`);
    }
    const payload = (await response.json()) as ServerWikiReadiness;
    setWikiReadiness(payload);
    if (payload.wikiUrl) setWikiUrl(payload.wikiUrl);
  }, [baseUrl, serverId]);

  const hydrateProtectedControls = useCallback(async () => {
    const results = await Promise.allSettled([
      fetchVotifierTargets(),
      fetchDispatchAttempts(),
      fetchWikiReadiness(),
    ]);
    if (results[2]?.status === 'rejected') {
      console.warn('서버 위키 준비 상태 로드 실패', results[2].reason);
      setWikiReadiness(null);
    }
  }, [fetchDispatchAttempts, fetchVotifierTargets, fetchWikiReadiness]);

  useEffect(() => {
    setRequiresOwnership(initialPolicy);
  }, [initialPolicy]);

  useEffect(() => {
    setWikiUrl(initialWikiUrl ?? null);
    setWikiFeedback(null);
  }, [initialWikiUrl]);

  useEffect(() => {
    if (!account) {
      setIsOwner(false);
      setVotifierTargets(createDefaultTargets());
      setVotifierFeedback(null);
      setDispatchSummary({ recent: [], failed: [] });
      setDispatchFeedback(null);
      setWikiReadiness(null);
      return;
    }
    const check = async () => {
      try {
        const response = await fetch(`${baseUrl}/v1/servers/${serverId}/ownership`, {
          credentials: 'include',
        });
        if (!response.ok) {
          setIsOwner(false);
          return;
        }
        const payload = (await response.json()) as { isOwner: boolean };
        const owner = Boolean(payload?.isOwner);
        setIsOwner(owner);
        if (!owner) {
          setVotifierTargets(createDefaultTargets());
          setVotifierFeedback(null);
          setDispatchSummary({ recent: [], failed: [] });
          setDispatchFeedback(null);
          setWikiReadiness(null);
        }
      } catch (error) {
        console.warn('소유자 확인 실패', error);
        setIsOwner(false);
        setVotifierTargets(createDefaultTargets());
        setVotifierFeedback(null);
        setDispatchSummary({ recent: [], failed: [] });
        setDispatchFeedback(null);
        setWikiReadiness(null);
      }
    };
    void check();
  }, [account, baseUrl, serverId]);

  const handleCreateWiki = useCallback(async () => {
    if (!isOwner || creatingWiki) {
      return;
    }
    setCreatingWiki(true);
    setWikiFeedback(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${serverId}/wiki`, {
        method: 'POST',
        credentials: 'include',
        headers: await csrfHeaders(),
      });
      if (!response.ok) {
        throw new Error(`서버 위키를 만들지 못했습니다. (${response.status})`);
      }
      const payload = (await response.json()) as ServerWikiLinkResponse;
      const nextUrl = payload.wikiUrl ?? serverWikiUrl(payload.wikiSlug);
      if (!nextUrl || payload.status !== 'linked') {
        throw new Error('서버 위키 링크가 생성되지 않았습니다.');
      }
      setWikiUrl(nextUrl);
      void fetchWikiReadiness().catch((error) => {
        console.warn('서버 위키 준비 상태 새로고침 실패', error);
      });
      setWikiFeedback({
        type: 'success',
        message: '서버 위키가 생성되었습니다.',
      });
      router.push(nextUrl);
    } catch (error) {
      console.warn('서버 위키 생성 실패', error);
      setWikiFeedback({
        type: 'error',
        message:
          error instanceof Error
            ? error.message
            : '서버 위키를 만들지 못했습니다. 잠시 후 다시 시도해주세요.',
      });
    } finally {
      setCreatingWiki(false);
    }
  }, [baseUrl, creatingWiki, fetchWikiReadiness, isOwner, router, serverId]);

  const handleToggle = async () => {
    if (!isOwner || saving) {
      return;
    }
    const next = !requiresOwnership;
    setRequiresOwnership(next);
    setSaving(true);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${serverId}/vote-policy`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        credentials: 'include',
        body: JSON.stringify({ requiresOwnership: next }),
      });
      if (!response.ok) {
        throw new Error(`API responded with ${response.status}`);
      }
    } catch (error) {
      console.warn('투표 정책 업데이트 실패', error);
      setRequiresOwnership((current) => !current);
    } finally {
      setSaving(false);
    }
  };

  const handleVotifierFieldChange = useCallback(
    (
      protocol: EditableTarget['protocol'],
      field: 'host' | 'port' | 'token' | 'publicKey',
      value: string,
    ) => {
      setVotifierTargets((current) =>
        current.map((target) => {
          if (target.protocol !== protocol) {
            return target;
          }
          if (field === 'host') {
            return { ...target, host: value };
          }
          if (field === 'port') {
            const digits = value.replace(/[^0-9]/g, '').slice(0, 5);
            return { ...target, port: digits };
          }
          if (field === 'token') {
            return { ...target, token: value, tokenConfigured: target.tokenConfigured };
          }
          return { ...target, publicKey: value };
        }),
      );
      setVotifierFeedback(null);
    },
    [],
  );

  const handleVotifierSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!isOwner || savingVotifier) {
        return;
      }
      const normalized: VotifierTarget[] = [];
      for (const target of votifierTargets) {
        const host = target.host.trim();
        if (!host) {
          continue;
        }
        const portValue = Number(target.port.trim());
        if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
          setVotifierFeedback({
            type: 'error',
            message: '포트 번호는 1에서 65535 사이의 숫자로 입력해 주세요.',
          });
          return;
        }
        if (target.protocol === 'v2') {
          const token = target.token.trim();
          if (!token && !target.tokenConfigured) {
            setVotifierFeedback({
              type: 'error',
              message: 'Votifier v2 토큰을 입력해 주세요.',
            });
            return;
          }
          normalized.push({
            protocol: 'v2',
            host,
            port: portValue,
            token: token || undefined,
            tokenConfigured: target.tokenConfigured,
          });
        } else {
          const publicKey = target.publicKey.trim();
          if (!publicKey) {
            setVotifierFeedback({
              type: 'error',
              message: 'Votifier v1 공개키를 입력해 주세요.',
            });
            return;
          }
          normalized.push({
            protocol: 'v1',
            host,
            port: portValue,
            publicKey,
          });
        }
      }
      if (normalized.length === 0) {
        setVotifierFeedback({
          type: 'error',
          message: '최소 하나 이상의 Votifier 엔드포인트를 입력해야 합니다.',
        });
        return;
      }
      setSavingVotifier(true);
      setVotifierFeedback(null);
      try {
        const response = await fetch(`${baseUrl}/v1/servers/${serverId}/votifier`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
          credentials: 'include',
          body: JSON.stringify({ targets: normalized }),
        });
        if (!response.ok) {
          throw new Error(`Votifier 설정 저장에 실패했습니다. (${response.status})`);
        }
        await fetchVotifierTargets();
        setVotifierFeedback({
          type: 'success',
          message: 'Votifier 설정이 저장되었습니다.',
        });
      } catch (error) {
        console.warn('Votifier 설정 저장 실패', error);
        setVotifierFeedback({
          type: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Votifier 설정을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.',
        });
      } finally {
        setSavingVotifier(false);
      }
    },
    [baseUrl, fetchVotifierTargets, isOwner, savingVotifier, serverId, votifierTargets],
  );

  const handleReplayDispatch = useCallback(
    async (attemptId: string) => {
      if (replayingAttempt) {
        return;
      }
      setReplayingAttempt(attemptId);
      setDispatchFeedback(null);
      try {
        const response = await fetch(
          `${baseUrl}/v1/servers/${serverId}/vote-dispatch-attempts/${attemptId}/replay`,
          {
            method: 'POST',
            headers: await csrfHeaders(),
            credentials: 'include',
          },
        );
        if (!response.ok) {
          throw new Error(`투표 전달 재시도에 실패했습니다. (${response.status})`);
        }
        await fetchDispatchAttempts();
        setDispatchFeedback({
          type: 'success',
          message: '투표 전달을 다시 대기열에 등록했습니다.',
        });
      } catch (error) {
        console.warn('투표 전달 재시도 실패', error);
        setDispatchFeedback({
          type: 'error',
          message:
            error instanceof Error
              ? error.message
              : '투표 전달을 재시도하지 못했습니다. 잠시 후 다시 시도해주세요.',
        });
      } finally {
        setReplayingAttempt(null);
      }
    },
    [baseUrl, fetchDispatchAttempts, replayingAttempt, serverId],
  );

  if (!isOwner) {
    return null;
  }

  return (
    <PrivilegedActionGate
      purpose="server_admin"
      title="서버 관리 잠금 해제"
      description="서버 위키, 투표 정책, Votifier 자격 증명과 전달 재시도는 서버 소유자 확인 후 다중 인증으로 보호됩니다."
      className={className}
      onUnlocked={hydrateProtectedControls}
    >
      <section
        className={`rounded-lg border border-[#2a2a2d] bg-[#141416] p-5 shadow-lg md:p-6 ${className ?? ''}`}
      >
      <div className="flex flex-col gap-4 border-b border-[#2a2a2d] pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
            운영자 도구
          </p>
          <h3 className="mt-1 text-lg font-semibold text-white">서버 관리</h3>
          <p className="mt-1 text-sm text-slate-300">
            프리미엄 노출과 투표 정책은 서버 소유자에게만 표시됩니다.
          </p>
        </div>
        <Link
          href="/policies/billing"
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-4 py-2.5 text-sm font-semibold text-indigo-200 transition hover:bg-indigo-500/20"
        >
          <Rocket className="h-4 w-4" />
          프리미엄 등록하기
        </Link>
      </div>

      <div id="server-profile-settings">
        <ServerProfileSettings
          serverId={serverId}
          baseUrl={baseUrl}
          initial={initialProfile}
        />
      </div>

      <div id="server-wiki-management" className="mt-5 rounded-lg border border-[#2a2a2d] bg-[#1c1c1f] p-4 text-sm text-slate-200">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-[#13ec80]" />
              <h4 className="text-base font-semibold text-white">서버 위키</h4>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-400">
              서버 소개, 규칙, 명령어, 변경 이력을 운영자가 직접 관리할 수 있습니다.
            </p>
          </div>
          {wikiUrl ? (
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/servers/${encodeURIComponent(serverId)}/wiki-layouts`}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-violet-300/30 bg-violet-400/10 px-4 py-2 text-xs font-semibold text-violet-200 transition hover:bg-violet-400/20"
              >
                레이아웃
                <Rocket className="h-3.5 w-3.5" />
              </Link>
              <Link
                href={wikiUrl}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-[#13ec80]/30 bg-[#13ec80]/10 px-4 py-2 text-xs font-semibold text-[#13ec80] transition hover:bg-[#13ec80]/20"
              >
                위키 보기
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </div>
          ) : (
            <button
              type="button"
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-[#13ec80] px-4 py-2 text-xs font-semibold text-slate-100 transition hover:bg-[#0fb865] disabled:opacity-60"
              onClick={() => void handleCreateWiki()}
              disabled={creatingWiki}
            >
              <BookOpen className="h-3.5 w-3.5" />
              {creatingWiki ? '생성 중…' : '서버 위키 만들기'}
            </button>
          )}
        </div>
        {wikiFeedback ? (
          <p
            className={`mt-3 text-xs ${
              wikiFeedback.type === 'success' ? 'text-emerald-300' : 'text-red-400'
            }`}
          >
            {wikiFeedback.message}
          </p>
        ) : null}
        {wikiReadiness ? <ServerWikiReadinessCard readiness={wikiReadiness} /> : null}
      </div>

      <div className="mt-5">
        <h4 className="text-base font-semibold text-white">투표 정책</h4>
        <p className="mt-2 text-sm text-slate-300">
          유저 인증을 완료한 플레이어만 투표하도록 설정하면, 계정 도용이나 봇 투표를 크게 줄일 수
          있습니다.
        </p>
      </div>
      <div className="mt-4 flex items-center justify-between rounded-lg border border-[#2a2a2d] bg-[#1c1c1f] p-4 text-sm text-slate-200">
        <div>
          <p className="font-semibold text-[#13ec80]">유저 인증 계정만 투표 허용</p>
          <p className="text-xs text-slate-400">
            토글을 활성화하면 로그인 후 계정을 인증한 플레이어만 투표할 수 있습니다.
          </p>
        </div>
        <button
          type="button"
          className={`rounded-full px-4 py-2 text-xs font-semibold transition ${
            requiresOwnership
              ? 'bg-[#13ec80] text-slate-100'
              : 'border border-[#2a2a2d] bg-transparent text-slate-200'
          }`}
          onClick={() => void handleToggle()}
          disabled={saving}
        >
          {requiresOwnership ? '활성화됨' : '비활성화'}
        </button>
      </div>

      <div className="mt-6 rounded-lg border border-[#2a2a2d] bg-[#1c1c1f] p-5 text-sm text-slate-200">
        <h4 className="text-base font-semibold text-white">Votifier 엔드포인트</h4>
        <p className="mt-2 text-xs text-slate-400">
          MineWiki가 투표 결과를 귀하의 서버로 전달할 수 있도록 Votifier v1 또는 v2 엔드포인트를
          설정하세요. 입력 후 저장하면 즉시 적용됩니다.
        </p>
        {loadingVotifier ? (
          <p className="mt-4 text-xs text-slate-400">설정을 불러오는 중입니다…</p>
        ) : (
          <form className="mt-4 space-y-4" onSubmit={(event) => void handleVotifierSubmit(event)}>
            {votifierTargets.map((target) => (
              <div
                key={target.protocol}
                className="space-y-3 rounded-2xl border border-[#2a2a2d] bg-[#141416] p-4"
              >
                <h5 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                  {target.protocol === 'v2' ? 'Votifier v2 (Token)' : 'Votifier v1 (Public Key)'}
                </h5>
                <div className="grid grid-cols-1 gap-3">
                  <label className="flex min-w-0 flex-col gap-2 text-xs font-semibold text-slate-300">
                    엔드포인트 주소
                    <input
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                      type="text"
                      value={target.host}
                      onChange={(event) =>
                        handleVotifierFieldChange(target.protocol, 'host', event.target.value)
                      }
                      placeholder="example.com"
                      disabled={savingVotifier || loadingVotifier}
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-2 text-xs font-semibold text-slate-300">
                    포트
                    <input
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={target.port}
                      onChange={(event) =>
                        handleVotifierFieldChange(target.protocol, 'port', event.target.value)
                      }
                      placeholder="8192"
                      disabled={savingVotifier || loadingVotifier}
                    />
                  </label>
                </div>
                {target.protocol === 'v2' ? (
                  <label className="flex min-w-0 flex-col gap-2 text-xs font-semibold text-slate-300">
                    인증 토큰
                    <input
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                      type="text"
                      value={target.token}
                      onChange={(event) =>
                        handleVotifierFieldChange(target.protocol, 'token', event.target.value)
                      }
                      placeholder="서버의 Votifier v2 토큰"
                      autoComplete="new-password"
                      disabled={savingVotifier || loadingVotifier}
                    />
                    {target.tokenConfigured && !target.token ? (
                      <span className="text-[11px] font-normal text-emerald-300">
                        저장된 토큰이 있습니다. 변경할 때만 새 토큰을 입력하세요.
                      </span>
                    ) : null}
                  </label>
                ) : (
                  <label className="flex min-w-0 flex-col gap-2 text-xs font-semibold text-slate-300">
                    공개키
                    <textarea
                      className="h-28 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100"
                      value={target.publicKey}
                      onChange={(event) =>
                        handleVotifierFieldChange(target.protocol, 'publicKey', event.target.value)
                      }
                      placeholder="-----BEGIN PUBLIC KEY-----"
                      disabled={savingVotifier || loadingVotifier}
                    />
                  </label>
                )}
              </div>
            ))}
            {votifierFeedback ? (
              <p
                className={`text-xs ${
                  votifierFeedback.type === 'success' ? 'text-emerald-300' : 'text-red-400'
                }`}
              >
                {votifierFeedback.message}
              </p>
            ) : null}
            <div className="flex justify-end">
              <button
                type="submit"
                className="rounded-full bg-[#13ec80] px-4 py-2 text-xs font-semibold text-slate-100 transition hover:bg-[#0fb865] disabled:opacity-60"
                disabled={savingVotifier || loadingVotifier}
              >
                {savingVotifier ? '저장 중…' : '엔드포인트 저장'}
              </button>
            </div>
          </form>
        )}
      </div>

      <div className="mt-6 rounded-lg border border-[#2a2a2d] bg-[#1c1c1f] p-5 text-sm text-slate-200">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h4 className="text-base font-semibold text-white">투표 전달 상태</h4>
            <p className="mt-2 text-xs text-slate-400">
              최근 Votifier 전달 결과와 실패한 보상 전달을 확인할 수 있습니다.
            </p>
          </div>
          <button
            type="button"
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-[#2a2a2d] px-4 py-2 text-xs font-semibold text-slate-200 transition hover:bg-[#25252a] disabled:opacity-60"
            onClick={() => void fetchDispatchAttempts()}
            disabled={loadingDispatch}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            새로고침
          </button>
        </div>

        {dispatchFeedback ? (
          <p
            className={`mt-3 text-xs ${
              dispatchFeedback.type === 'success' ? 'text-emerald-300' : 'text-red-400'
            }`}
          >
            {dispatchFeedback.message}
          </p>
        ) : null}

        <div className="mt-4 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="min-w-0 rounded-lg border border-[#2a2a2d] bg-[#141416]">
            <div className="flex items-center gap-2 border-b border-[#2a2a2d] px-4 py-3">
              <Clock3 className="h-4 w-4 text-sky-300" />
              <h5 className="text-sm font-semibold text-white">최근 전달</h5>
            </div>
            <div className="divide-y divide-[#2a2a2d]">
              {loadingDispatch ? (
                <p className="px-4 py-4 text-xs text-slate-400">전달 기록을 불러오는 중입니다…</p>
              ) : dispatchSummary.recent.length === 0 ? (
                <p className="px-4 py-4 text-xs text-slate-400">아직 전달 기록이 없습니다.</p>
              ) : (
                dispatchSummary.recent.slice(0, 8).map((attempt) => (
                  <div key={attempt.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[1fr_auto]">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-white">{attempt.username}</p>
                      <p className="mt-1 truncate text-xs text-slate-400">
                        {attempt.protocol.toUpperCase()} · {attempt.target.host ?? '삭제된 대상'}:
                        {attempt.target.port ?? '-'} · 투표 {formatDateTime(attempt.votedAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 sm:justify-end">
                      {attempt.status === 'success' ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                      ) : attempt.status === 'failed' ? (
                        <AlertCircle className="h-4 w-4 text-red-300" />
                      ) : (
                        <Clock3 className="h-4 w-4 text-amber-300" />
                      )}
                      <span className={`text-xs font-semibold ${statusTone(attempt.status)}`}>
                        {statusLabel(attempt.status)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="min-w-0 rounded-lg border border-[#2a2a2d] bg-[#141416]">
            <div className="flex items-center gap-2 border-b border-[#2a2a2d] px-4 py-3">
              <AlertCircle className="h-4 w-4 text-red-300" />
              <h5 className="text-sm font-semibold text-white">실패한 전달</h5>
            </div>
            <div className="divide-y divide-[#2a2a2d]">
              {loadingDispatch ? (
                <p className="px-4 py-4 text-xs text-slate-400">실패 기록을 불러오는 중입니다…</p>
              ) : dispatchSummary.failed.length === 0 ? (
                <p className="px-4 py-4 text-xs text-slate-400">재시도할 실패 기록이 없습니다.</p>
              ) : (
                dispatchSummary.failed.slice(0, 6).map((attempt) => (
                  <div key={attempt.id} className="space-y-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-white">{attempt.username}</p>
                      <p className="mt-1 truncate text-xs text-slate-400">
                        {attempt.protocol.toUpperCase()} · {attempt.target.host ?? '삭제된 대상'}:
                        {attempt.target.port ?? '-'} · 시도 {attempt.attempts}회
                      </p>
                      {attempt.error ? (
                        <p className="mt-1 line-clamp-2 text-xs text-red-300">{attempt.error}</p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#13ec80] px-4 py-2 text-xs font-semibold text-slate-100 transition hover:bg-[#0fb865] disabled:opacity-60"
                      onClick={() => void handleReplayDispatch(attempt.id)}
                      disabled={Boolean(replayingAttempt)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      {replayingAttempt === attempt.id ? '재시도 등록 중…' : '다시 전달'}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
      </section>
    </PrivilegedActionGate>
  );
}

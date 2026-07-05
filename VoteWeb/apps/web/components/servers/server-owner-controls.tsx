'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { VotifierTarget } from '@creepervote/schemas';
import { Rocket } from 'lucide-react';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import { useAuth } from '../providers/auth-context';

interface ServerOwnerControlsProps {
  readonly serverId: string;
  readonly apiBaseUrl?: string;
  readonly initialPolicy: boolean;
  readonly className?: string;
}

type EditableTarget = {
  protocol: 'v2' | 'v1';
  host: string;
  port: string;
  token: string;
  publicKey: string;
};

type FeedbackState = {
  readonly type: 'success' | 'error';
  readonly message: string;
};

function createDefaultTargets(): EditableTarget[] {
  return [
    { protocol: 'v2', host: '', port: '8192', token: '', publicKey: '' },
    { protocol: 'v1', host: '', port: '8193', token: '', publicKey: '' },
  ];
}

function mergeTargets(targets: ReadonlyArray<VotifierTarget>): EditableTarget[] {
  const defaults = createDefaultTargets();
  for (const target of targets) {
    const match = defaults.find((entry) => entry.protocol === target.protocol);
    if (match) {
      match.host = target.host;
      match.port = String(target.port);
      match.token = target.token ?? '';
      match.publicKey = target.publicKey ?? '';
    }
  }
  return defaults;
}

export function ServerOwnerControls({
  serverId,
  apiBaseUrl,
  initialPolicy,
  className,
}: ServerOwnerControlsProps) {
  const { account } = useAuth();
  const [isOwner, setIsOwner] = useState(false);
  const [requiresOwnership, setRequiresOwnership] = useState(initialPolicy);
  const [saving, setSaving] = useState(false);
  const [votifierTargets, setVotifierTargets] = useState<EditableTarget[]>(createDefaultTargets());
  const [loadingVotifier, setLoadingVotifier] = useState(false);
  const [savingVotifier, setSavingVotifier] = useState(false);
  const [votifierFeedback, setVotifierFeedback] = useState<FeedbackState | null>(null);
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

  useEffect(() => {
    setRequiresOwnership(initialPolicy);
  }, [initialPolicy]);

  useEffect(() => {
    if (!account) {
      setIsOwner(false);
      setVotifierTargets(createDefaultTargets());
      setVotifierFeedback(null);
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
        if (owner) {
          await fetchVotifierTargets();
        } else {
          setVotifierTargets(createDefaultTargets());
          setVotifierFeedback(null);
        }
      } catch (error) {
        console.warn('소유자 확인 실패', error);
        setIsOwner(false);
        setVotifierTargets(createDefaultTargets());
        setVotifierFeedback(null);
      }
    };
    void check();
  }, [account, baseUrl, serverId, fetchVotifierTargets]);

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
        headers: { 'Content-Type': 'application/json' },
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
            return { ...target, token: value };
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
          if (!token) {
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
            token,
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
          headers: { 'Content-Type': 'application/json' },
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

  if (!isOwner) {
    return null;
  }

  return (
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
          Lunaf가 투표 결과를 귀하의 서버로 전달할 수 있도록 Votifier v1 또는 v2 엔드포인트를
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
                      disabled={savingVotifier || loadingVotifier}
                    />
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
    </section>
  );
}

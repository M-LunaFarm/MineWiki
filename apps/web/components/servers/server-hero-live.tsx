/* eslint-disable @next/next/no-img-element */
'use client';

import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import type { ServerDetail, ServerStats } from '@minewiki/schemas';
import { BadgeCheck, ExternalLink, Gauge, Server, UsersRound } from 'lucide-react';
import { VoteModal } from '../voting/vote-modal';
import { CopyAddressButton } from './copy-address-button';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import {
  getServerPreviewFallbackClass,
  getServerPreviewInitial,
  getServerPreviewSeed,
} from '../../lib/server-preview';

interface ServerHeroLiveProps {
  readonly detail: ServerDetail;
  readonly serverId: string;
  readonly serverPath: string;
  readonly apiBaseUrl?: string;
  readonly initialStats?: ServerStats | null;
  readonly initialVoteOpen?: boolean;
}

export function ServerHeroLive({
  detail,
  serverId,
  serverPath,
  apiBaseUrl,
  initialStats,
  initialVoteOpen = false,
}: ServerHeroLiveProps) {
  const [stats, setStats] = useState<ServerStats | null>(initialStats ?? null);
  const refreshingRef = useRef(false);
  const [origin, setOrigin] = useState('');

  const editionLabel = detail.edition === 'java' ? 'Java Edition' : 'Bedrock Edition';
  const versionLabel = detail.supportedVersions.join(', ');

  const refreshStats = useCallback(async () => {
    if (refreshingRef.current) {
      return;
    }
    refreshingRef.current = true;
    try {
      const baseUrl = normalizeApiBaseUrl(apiBaseUrl);
      const response = await fetch(`${baseUrl}/v1/servers/${serverId}/stats`);
      if (response.ok) {
        const newStats = await response.json();
        setStats(newStats);
      }
    } catch (error) {
      console.error('Failed to refresh stats:', error);
    } finally {
      refreshingRef.current = false;
    }
  }, [apiBaseUrl, serverId]);

  useEffect(() => {
    const interval = setInterval(() => {
      refreshStats();
    }, 30000);

    return () => clearInterval(interval);
  }, [refreshStats]);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const pingSamples = stats?.pingSamples ?? [];
  const latestPingSample = pingSamples.length > 0 ? pingSamples[pingSamples.length - 1] : null;

  const playersOnline =
    latestPingSample?.players ??
    (typeof detail.playersOnline === 'number'
      ? detail.playersOnline
      : (stats?.players.online ?? 0));
  const playersMax =
    latestPingSample?.maxPlayers ??
    (typeof detail.playersMax === 'number' ? detail.playersMax : (stats?.players.max ?? 0));

  const playersUpdatedIso =
    latestPingSample?.timestamp ??
    detail.playersLastUpdatedAt ??
    stats?.players.lastUpdatedAt ??
    null;
  const playersUpdated =
    playersUpdatedIso && !Number.isNaN(Date.parse(playersUpdatedIso))
      ? new Date(playersUpdatedIso)
      : null;

  const latencyValue =
    latestPingSample && latestPingSample.latency !== null
      ? latestPingSample.latency
      : (stats?.latencyMs ?? null);
  const latencyLabel =
    latestPingSample && !latestPingSample.online
      ? '오프라인'
      : latencyValue !== null
        ? `${latencyValue.toLocaleString('ko-KR')}ms`
        : '측정 중';

  const isOnline =
    latestPingSample?.online ??
    detail.isOnline ??
    (playersUpdated ? Date.now() - playersUpdated.getTime() <= 1000 * 60 * 10 : undefined);

  const statusTone = isOnline === undefined ? 'unknown' : isOnline ? 'online' : 'offline';
  const statusLabel =
    statusTone === 'online' ? '온라인' : statusTone === 'offline' ? '오프라인' : '확인 중';
  const statusClass =
    statusTone === 'online'
      ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
      : statusTone === 'offline'
        ? 'bg-rose-500/10 text-rose-300 border-rose-500/20'
        : 'bg-slate-500/10 text-slate-300 border-slate-500/20';

  const joinPort = detail.joinPort ?? 25565;
  const joinAddress = joinPort === 25565 ? detail.joinHost : `${detail.joinHost}:${joinPort}`;
  const sharePath = serverPath.startsWith('/') ? serverPath : `/${serverPath}`;
  const shareUrl = origin ? `${origin}${sharePath}` : sharePath;
  const playerRatio =
    playersMax > 0 ? Math.min(100, Math.round((playersOnline / playersMax) * 100)) : 0;
  const playerSummary =
    statusTone === 'online'
      ? playersMax > 0
        ? `${playersOnline.toLocaleString('ko-KR')} / ${playersMax.toLocaleString('ko-KR')}`
        : `${playersOnline.toLocaleString('ko-KR')}명`
      : statusTone === 'offline'
        ? '오프라인'
        : '확인 중';
  const serverInitial = detail.name.charAt(0).toUpperCase();
  const showVerification = detail.verificationGrade === 'Verified';

  return (
    <section className="space-y-6">
      <div className="dark-fixed-surface relative overflow-hidden rounded-2xl border border-white/[0.07] bg-[#0d1219] shadow-2xl shadow-black/40">
        <div className="group absolute inset-0 h-full w-full">
          {detail.bannerUrl ? (
            <img
              src={detail.bannerUrl}
              alt={`${detail.name} banner`}
              className="h-full w-full object-cover opacity-40 transition-transform duration-700 group-hover:scale-[1.02]"
            />
          ) : (
            <div
              className={`flex h-full w-full items-center justify-center text-7xl font-black text-white/25 ${getServerPreviewFallbackClass(
                getServerPreviewSeed(detail),
              )}`}
            >
              {getServerPreviewInitial(detail.name)}
            </div>
          )}
          <div className="absolute inset-0 bg-[linear-gradient(90deg,#0d1219_0%,rgba(13,18,25,0.94)_42%,rgba(13,18,25,0.68)_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(0deg,#0d1219_0%,rgba(13,18,25,0)_55%,rgba(13,18,25,0.55)_100%)]" />
        </div>

        <div className="relative grid gap-7 px-5 py-6 lg:grid-cols-[96px_minmax(0,1fr)_300px] lg:items-center lg:px-8 lg:py-8">
          <div className="relative z-10 flex-shrink-0">
            <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-[#1a2230] to-[#0d1219] text-4xl font-black text-white shadow-xl shadow-black/40">
              {serverInitial}
            </div>
          </div>

          <div className="relative z-10 min-w-0">
            <p className="mb-3 inline-flex rounded-md border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-xs font-semibold text-slate-300 backdrop-blur">
              {editionLabel}
            </p>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-extrabold tracking-tight text-white md:text-5xl">
                {detail.name}
              </h1>
              <span
                className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${statusClass}`}
              >
                <span
                  className={`mr-2 h-2 w-2 rounded-full ${statusTone === 'online' ? 'bg-emerald-300' : statusTone === 'offline' ? 'bg-rose-300' : 'bg-slate-300'}`}
                />
                {statusLabel}
              </span>
              {showVerification ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1 text-xs font-semibold text-cyan-200">
                  <BadgeCheck className="h-3 w-3" />
                  검증 완료
                </span>
              ) : null}
            </div>
            <p className="max-w-2xl text-base leading-7 text-slate-300 md:text-lg">
              {detail.shortDescription}
            </p>

            <div className="mt-5 grid max-w-3xl gap-2 sm:grid-cols-3">
              <HeroInfo icon={UsersRound} label="접속자" value={playerSummary} />
              <HeroInfo icon={Gauge} label="지연시간" value={latencyLabel} />
              <HeroInfo icon={Server} label="버전" value={versionLabel || '미설정'} />
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-4">
              <VoteModal
                serverId={serverId}
                apiBaseUrl={apiBaseUrl}
                requiresOwnership={detail.voteRequiresOwnership ?? false}
                initialOpen={initialVoteOpen}
                triggerClassName="inline-flex items-center gap-3 rounded-xl bg-[#14c794] px-8 py-3.5 text-base font-bold text-[#06140d] shadow-lg shadow-[#14c794]/25 transition hover:bg-[#1ee6a4] active:scale-[0.99]"
              />
              <div className="group flex min-w-0 items-center gap-4 rounded-xl border border-white/[0.08] bg-white/[0.04] p-1.5 pl-4 pr-2 backdrop-blur">
                <span className="min-w-0">
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    주소
                  </span>
                  <span className="block truncate font-mono text-sm font-semibold tracking-wide text-white md:text-base">
                    {joinAddress}
                  </span>
                </span>
                <CopyAddressButton
                  address={joinAddress}
                  className="shrink-0 whitespace-nowrap rounded-lg bg-white/[0.06] p-2.5 text-slate-300 transition hover:bg-white hover:text-black"
                  idleLabel=""
                  copiedLabel="OK"
                >
                  복사
                </CopyAddressButton>
              </div>
              {detail.shortCode ? (
                <div className="group flex min-w-0 items-center gap-4 rounded-xl border border-white/[0.08] bg-white/[0.04] p-1.5 pl-4 pr-2 backdrop-blur">
                  <span className="min-w-0">
                    <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      짧은 URL
                    </span>
                    <span className="block truncate font-mono text-sm font-semibold tracking-wide text-white md:text-base">
                      {shareUrl}
                    </span>
                  </span>
                  <CopyAddressButton
                    address={shareUrl}
                    className="shrink-0 whitespace-nowrap rounded-lg bg-white/[0.06] p-2.5 text-slate-300 transition hover:bg-white hover:text-black"
                    idleLabel=""
                    copiedLabel="OK"
                  >
                    복사
                  </CopyAddressButton>
                </div>
              ) : null}
              {detail.websiteUrl ? (
                <a
                  className="inline-flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.04] px-5 py-3.5 font-semibold text-white backdrop-blur-sm transition hover:border-white/20"
                  href={detail.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="h-4 w-4" />
                  공식 사이트
                </a>
              ) : null}
            </div>
          </div>

          <div className="relative z-10 hidden gap-3 rounded-2xl border border-white/[0.07] bg-[#0d1219]/85 p-4 backdrop-blur lg:grid">
            <div className="flex items-center gap-2 text-sm font-bold text-white">
              <BadgeCheck className="h-4 w-4 text-cyan-200" />
              검증 현황
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <TrustPill
                label="검증"
                value={showVerification ? '완료' : '미검증'}
                active={showVerification}
              />
              <TrustPill label="상태" value={statusLabel} active={statusTone === 'online'} />
            </div>
            <div className="group relative mx-auto h-28 w-28 cursor-default">
              <svg
                className="h-full w-full -rotate-90 text-[#14c794]"
                viewBox="0 0 36 36"
                aria-hidden
              >
                <path
                  className="stroke-white/[0.06]"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  strokeWidth="2.5"
                />
                <path
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={`${playerRatio}, 100`}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className="mb-0.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  접속자
                </span>
                <span className="text-xl font-bold text-white transition-colors group-hover:text-[#14c794]">
                  {statusTone === 'online' ? playersOnline.toLocaleString('ko-KR') : statusLabel}
                </span>
                {statusTone === 'online' && playersMax > 0 ? (
                  <span className="text-[10px] text-slate-500">
                    / {playersMax.toLocaleString('ko-KR')}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function HeroInfo({
  icon: Icon,
  label,
  value,
}: {
  readonly icon: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 py-2.5 backdrop-blur">
      <Icon className="h-4 w-4 shrink-0 text-cyan-200" />
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          {label}
        </p>
        <p className="truncate text-sm font-semibold text-white">{value}</p>
      </div>
    </div>
  );
}

function TrustPill({
  label,
  value,
  active,
}: {
  readonly label: string;
  readonly value: string;
  readonly active: boolean;
}) {
  return (
    <div
      className={`rounded-xl border px-3 py-2 ${active ? 'border-[#14c794]/30 bg-[#14c794]/10' : 'border-white/[0.08] bg-white/[0.03]'}`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {label}
      </p>
      <p
        className={active ? 'mt-1 font-semibold text-[#14c794]' : 'mt-1 font-semibold text-white'}
      >
        {value}
      </p>
    </div>
  );
}

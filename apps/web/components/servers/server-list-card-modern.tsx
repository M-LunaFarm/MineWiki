import Link from 'next/link';
import type { ServerSummary } from '@minewiki/schemas';
import { Activity, ChevronRight, Globe, Shield, Star, TrendingUp, Users } from 'lucide-react';
import type { ComponentType } from 'react';
import { buildServerPath } from '../../lib/server-routes';

interface ServerListCardProps {
  readonly server: ServerSummary;
  readonly index?: number;
}

function formatEdition(edition: ServerSummary['edition']): string {
  return edition === 'java' ? 'Java' : 'Bedrock';
}

export function ServerListCardModern({ server, index }: ServerListCardProps) {
  const versionLabel = server.supportedVersions.join(', ');
  const isKnownOffline = server.isOnline === false;
  const playersOnline =
    !isKnownOffline && typeof server.playersOnline === 'number' ? server.playersOnline : null;
  const playersMax =
    !isKnownOffline && typeof server.playersMax === 'number' ? server.playersMax : null;
  const snapshotTimestamp = server.playersLastUpdatedAt
    ? Date.parse(server.playersLastUpdatedAt)
    : NaN;
  const hasSnapshot = Number.isFinite(snapshotTimestamp);
  const snapshotDate = hasSnapshot ? new Date(snapshotTimestamp) : null;
  const presumedOnline =
    typeof server.isOnline === 'boolean'
      ? server.isOnline
      : hasSnapshot
        ? Date.now() - snapshotTimestamp <= 1000 * 60 * 10
        : undefined;
  const statusTone =
    typeof presumedOnline === 'boolean' ? (presumedOnline ? 'online' : 'offline') : 'unknown';

  return (
    <Link
      href={buildServerPath(server)}
      className="group rounded-2xl border border-white/10 bg-slate-950/70 p-5 shadow-lg transition hover:border-white/20"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500">
            {index !== undefined ? `Rank #${index + 1}` : 'Listed server'}
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-50">{server.name}</h3>
          <p className="mt-1 text-xs text-slate-400">
            {server.joinHost}:{server.joinPort}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {server.voteRequiresOwnership ? (
            <span className="rounded-full border border-amber-300/35 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-100">
              <Shield className="inline h-3.5 w-3.5" /> 인증투표
            </span>
          ) : null}
          <span
            className={`rounded-full border px-2 py-1 text-[10px] font-semibold ${
              statusTone === 'online'
                ? 'border-emerald-300/35 bg-emerald-500/10 text-emerald-100'
                : statusTone === 'offline'
                  ? 'border-rose-300/35 bg-rose-500/10 text-rose-100'
                  : 'border-slate-600 bg-slate-800 text-slate-300'
            }`}
          >
            {statusTone === 'online' ? 'ONLINE' : statusTone === 'offline' ? 'OFFLINE' : 'UNKNOWN'}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded-lg border border-white/10 bg-slate-900/70 px-2.5 py-1 text-[11px] text-slate-300">
          {formatEdition(server.edition)}
        </span>
        <span className="rounded-lg border border-white/10 bg-slate-900/70 px-2.5 py-1 text-[11px] text-slate-300">
          {versionLabel}
        </span>
        {server.tags.slice(0, 3).map((tag) => (
          <span
            key={`${server.id}-${tag}`}
            className="rounded-lg border border-white/10 bg-slate-900/70 px-2.5 py-1 text-[11px] text-slate-300"
          >
            #{tag}
          </span>
        ))}
      </div>

      {server.shortDescription ? (
        <p className="mt-3 line-clamp-2 text-sm text-slate-300">{server.shortDescription}</p>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric icon={TrendingUp} label="24h" value={server.votes24h.toLocaleString('ko-KR')} />
        <Metric
          icon={Activity}
          label="이번달"
          value={(server.votesMonthly ?? 0).toLocaleString('ko-KR')}
        />
        <Metric icon={Star} label="리뷰" value={server.reviewsCount.toLocaleString('ko-KR')} />
        <Metric
          icon={Users}
          label="접속자"
          value={
            isKnownOffline
              ? '오프라인'
              : playersOnline !== null && playersMax !== null
                ? `${playersOnline}/${playersMax}`
                : '-'
          }
        />
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3 text-xs text-slate-400">
        <div>
          {snapshotDate
            ? `업데이트: ${snapshotDate.toLocaleString('ko-KR')}`
            : '업데이트 기록 없음'}
        </div>
        <div className="flex items-center gap-2">
          {server.websiteUrl ? (
            <span
              className="inline-flex rounded-md border border-white/10 p-1.5 text-slate-300"
              aria-hidden="true"
            >
              <Globe className="h-3.5 w-3.5" />
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1 text-emerald-100">
            상세보기
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
        </div>
      </div>
    </Link>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  readonly icon: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/65 p-3">
      <div className="flex items-center gap-1 text-[11px] text-slate-400">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className="mt-1 text-sm font-semibold text-slate-100">{value}</p>
    </div>
  );
}

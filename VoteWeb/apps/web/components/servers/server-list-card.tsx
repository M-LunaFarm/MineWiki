import Link from 'next/link';
import type { ServerSummary } from '@creepervote/schemas';
import { buildServerPath } from '../../lib/server-routes';

interface ServerListCardProps {
  readonly server: ServerSummary;
}

function formatEdition(edition: ServerSummary['edition']): string {
  return edition === 'java' ? 'Java' : 'Bedrock';
}

export function ServerListCard({ server }: ServerListCardProps) {
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
  const statusLabel =
    statusTone === 'online' ? '온라인' : statusTone === 'offline' ? '오프라인' : '상태 정보 없음';
  const statusClass =
    statusTone === 'online'
      ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-100'
      : statusTone === 'offline'
        ? 'border-rose-400/40 bg-rose-500/15 text-rose-100'
        : 'border-slate-600 bg-slate-800 text-slate-300';
  const playersLastUpdatedText = snapshotDate
    ? snapshotDate.toLocaleString('ko-KR')
    : '최근 접속 정보가 없습니다.';

  return (
    <li className="group relative overflow-hidden rounded-2xl border border-outline-soft bg-surface-200/80 p-6 shadow transition hover:border-brand-400/50">
      <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.3em] text-brand-100/80">
        <span>{formatEdition(server.edition)} 서버</span>
        {server.voteRequiresOwnership ? (
          <span className="rounded-full border border-brand-400/40 bg-brand-500/15 px-2 py-[2px] text-[10px] font-semibold text-brand-100">
            유저 인증 전용
          </span>
        ) : null}
        <span
          className={`rounded-full border px-2 py-[2px] text-[10px] font-semibold ${statusClass}`}
        >
          {statusLabel}
        </span>
      </div>
      <h3 className="mt-2 text-lg font-semibold text-slate-50">{server.name}</h3>
      <p className="mt-2 text-sm text-slate-300">
        {server.joinHost}:{server.joinPort}
      </p>
      <p className="mt-1 text-xs text-slate-400">지원 버전: {versionLabel}</p>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">
        {server.tags.map((tag) => (
          <span
            key={tag}
            className="rounded-full border border-outline-soft bg-surface-300/70 px-3 py-1 text-slate-200"
          >
            #{tag}
          </span>
        ))}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 text-xs text-slate-400 md:grid-cols-4">
        <div>
          <dt>24시간 투표</dt>
          <dd className="mt-1 text-base font-semibold text-brand-100">
            {server.votes24h.toLocaleString('ko-KR')}
          </dd>
        </div>
        <div>
          <dt>이번 달 투표</dt>
          <dd className="mt-1 text-base font-semibold text-brand-100">
            {(server.votesMonthly ?? 0).toLocaleString('ko-KR')}
          </dd>
        </div>
        <div>
          <dt>리뷰 수</dt>
          <dd className="mt-1 text-base font-semibold text-sky-200">
            {server.reviewsCount.toLocaleString('ko-KR')}
          </dd>
        </div>
        <div>
          <dt>접속 인원</dt>
          <dd className="mt-1 text-base font-semibold text-emerald-100">
            {isKnownOffline
              ? '오프라인'
              : playersOnline !== null && playersMax !== null
                ? `${playersOnline.toLocaleString('ko-KR')} / ${playersMax.toLocaleString('ko-KR')}`
                : '정보 없음'}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-slate-500">{`기준 시각: ${playersLastUpdatedText}`}</p>
      <div className="mt-4 flex flex-wrap gap-3 text-sm font-medium">
        <Link
          href={buildServerPath(server)}
          className="text-brand-100 underline-offset-4 transition hover:underline"
        >
          상세 보기
        </Link>
        <a
          href={`https://${server.joinHost}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-slate-300 underline-offset-4 transition hover:text-brand-100 hover:underline"
        >
          공식 사이트 이동
        </a>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 translate-y-12 bg-gradient-to-t from-brand-500/10 to-transparent opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100" />
    </li>
  );
}

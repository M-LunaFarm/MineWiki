'use client';

import type { ReviewGateStatus } from '@minewiki/schemas';

interface ReviewGateHintProps {
  readonly status: ReviewGateStatus;
  readonly onRefresh?: () => void;
}

const REQUIREMENTS: Array<{
  readonly key: 'isLoggedIn' | 'isMinecraftOwned' | 'hasRecentVote';
  readonly title: string;
  readonly description: string;
}> = [
  {
    key: 'isLoggedIn',
    title: '로그인 상태',
    description: 'Discord, Naver 또는 Email 계정으로 로그인한 이용자만 리뷰를 작성할 수 있습니다.'
  },
  {
    key: 'isMinecraftOwned',
    title: 'Minecraft 소유권 인증',
    description: 'Microsoft, Xbox Live 및 XSTS 검증 절차를 통과한 계정만 리뷰 작성이 허용됩니다.'
  },
  {
    key: 'hasRecentVote',
    title: '최근 투표 기록',
    description: '최근 24시간 내 대상 서버에 투표한 기록이 확인되면 리뷰 작성이 활성화됩니다.'
  }
];

function formatKstDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

export function ReviewGateHint({ status, onRefresh }: ReviewGateHintProps) {
  const completed = REQUIREMENTS.reduce(
    (count, requirement) => count + Number(status[requirement.key]),
    0
  );
  const progress = Math.round((completed / REQUIREMENTS.length) * 100);

  return (
    <div className="mt-6 rounded-xl border border-[#30343b] bg-[#101216] p-5 text-sm text-[#d1d5db]">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-blue-100">리뷰 작성 요건</p>
          <TooltipCard />
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-[#30343b] px-3 py-1 text-[11px] text-[#d1d5db]">
            충족률 {progress}%
          </span>
          {onRefresh && (
            <button
              type="button"
              className="rounded-lg border border-[#30343b] px-2 py-1 text-[11px] text-[#9ca3af] transition hover:border-blue-400/40 hover:text-blue-100"
              onClick={onRefresh}
            >
              새로고침
            </button>
          )}
        </div>
      </header>

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        {REQUIREMENTS.map((requirement) => {
          const satisfied = status[requirement.key];
          return (
            <span
              key={requirement.key}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 font-semibold ${
                satisfied
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
                  : 'border-[#30343b] bg-[#151922] text-[#9ca3af]'
              }`}
            >
              <span className="text-[10px] uppercase tracking-[0.2em] text-[#9ca3af]">
                {satisfied ? '충족' : '미충족'}
              </span>
              <span>{requirement.title}</span>
            </span>
          );
        })}
      </div>

      <div className="mt-4 rounded-xl border border-[#30343b] bg-[#151922] p-3 text-[11px] text-[#9ca3af]">
        <p>
          <span className="font-semibold text-white">표시 이름:</span>{' '}
          {status.displayName ?? '로그인 필요'}
        </p>
        <p className="mt-1">
          <span className="font-semibold text-white">최근 투표 시각:</span>{' '}
          {status.lastVoteAt
            ? `${formatKstDateTime(status.lastVoteAt)} (KST)`
            : '최근 투표 기록이 없습니다.'}
        </p>
        <p className="mt-1">
          <span className="font-semibold text-white">다음 투표 가능:</span>{' '}
          {status.nextEligibleVoteAt
            ? `${formatKstDateTime(status.nextEligibleVoteAt)} (KST)`
            : '투표 정보를 불러오는 중이거나 투표 이력이 없습니다.'}
        </p>
      </div>
    </div>
  );
}

function TooltipCard() {
  return (
    <div className="group relative inline-flex items-center">
      <span
        tabIndex={0}
        className="flex h-5 w-5 items-center justify-center rounded-full border border-[#30343b] bg-[#151922] text-[10px] font-semibold text-[#9ca3af] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 group-hover:border-blue-400/40 group-hover:text-blue-100"
        aria-label="리뷰 조건 설명 보기"
      >
        ?
      </span>
      <div className="pointer-events-none absolute right-0 top-full z-30 hidden w-72 translate-y-2 rounded-xl border border-[#30343b] bg-[#151922] p-4 text-xs text-[#d1d5db] shadow-xl group-focus-within:block group-hover:block">
        <p className="text-[11px] font-semibold text-white">리뷰 조건 안내</p>
        <ul className="mt-2 space-y-2 text-[11px] leading-relaxed text-[#9ca3af]">
          {REQUIREMENTS.map((item) => (
            <li key={item.key}>
              <span className="font-semibold text-white">{item.title}</span>
              <br />
              {item.description}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[10px] text-[#6b7280]">조건은 서버 상태와 계정 상태에 따라 자동으로 갱신됩니다.</p>
      </div>
    </div>
  );
}

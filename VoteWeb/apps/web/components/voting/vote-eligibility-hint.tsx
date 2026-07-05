'use client';

export function VoteEligibilityHint() {
  return (
    <div className="rounded-xl border border-[#30343b] bg-[#151922] p-4 text-xs text-[#d1d5db]">
      <span className="font-semibold text-blue-100">투표 조건 안내</span>
      <p className="mt-2 leading-relaxed text-[#9ca3af]">
        동일 이용자는 하루에 한 번만 투표할 수 있으며, 모든 서버를 통틀어 00:00 (KST)에 투표 가능 횟수가 초기화됩니다.
        이미 투표한 경우 다음 날 자정 이후 다시 참여할 수 있습니다.
      </p>
    </div>
  );
}

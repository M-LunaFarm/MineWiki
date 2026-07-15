import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchWikiContributions } from '../../../../lib/wiki-server-api';

interface PageProps {
  readonly params: Promise<{ profileId: string }>;
  readonly searchParams: Promise<{ cursor?: string; activity?: string }>;
}

export default async function WikiContributionsPage({ params, searchParams }: PageProps) {
  const [{ profileId }, query] = await Promise.all([params, searchParams]);
  const activity = contributionActivity(query.activity);
  const result = await fetchWikiContributions(profileId, query.cursor, activity).catch(() => null);
  if (!result) notFound();
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <Link href="/recent" className="hover:text-emerald-200">최근 변경</Link><span>/</span><span className="text-slate-200">기여 내역</span>
      </nav>
      <header className="border-b border-white/10 pb-6">
        <h1 className="text-3xl font-bold text-white">{result.profile.displayName}의 기여</h1>
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-400">@{result.profile.username}{result.profile.status === 'blocked' ? <Link href={`/wiki/block-history?q=${encodeURIComponent(result.profile.username)}`} className="chip border-red-300/30 text-red-200 hover:bg-red-300/10">기여 차단됨 · 기록 보기</Link> : null}<span>· 읽을 권한이 있는 공개 활동만 표시됩니다.</span></p>
      </header>
      <nav aria-label="기여 활동 유형" className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {CONTRIBUTION_TABS.map((tab) => <Link key={tab.value} href={`/wiki/contributions/${profileId}?activity=${tab.value}`} className={`chip min-h-11 justify-center ${activity === tab.value ? 'chip-accent' : 'chip-muted'}`} aria-current={activity === tab.value ? 'page' : undefined}>{tab.label}</Link>)}
      </nav>
      <section className="divide-y divide-white/10 border border-white/10 bg-[#111821]">
        {result.items.map((item) => (
          <article key={item.id} className="p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="chip chip-muted">{activityLabel(item.changeType)}</span>
              {item.status ? <span className="chip chip-muted">{statusLabel(item.status)}</span> : null}
              {item.isMinor ? <span className="chip chip-muted">사소한 편집</span> : null}
              <Link href={item.href} className="font-semibold text-emerald-200 hover:underline">{item.title}</Link>
            </div>
            <p className="mt-3 text-sm text-slate-300">{item.summary ?? '요약 없음'}</p>
            <p className="mt-2 text-xs text-slate-500">{formatDate(item.createdAt)} · {item.namespace}</p>
          </article>
        ))}
        {result.items.length === 0 ? <p className="p-6 text-sm text-slate-400">표시할 공개 기여가 없습니다.</p> : null}
      </section>
      {result.nextCursor ? <Link href={`/wiki/contributions/${profileId}?activity=${activity}&cursor=${result.nextCursor}`} className="btn-secondary min-h-11 self-start">이전 활동 더 보기</Link> : null}
    </main>
  );
}

const CONTRIBUTION_TABS = [
  { value: 'edits', label: '문서 편집' },
  { value: 'discussions', label: '토론' },
  { value: 'edit-requests', label: '편집 요청' },
  { value: 'reviews', label: '요청 검토' }
] as const;

type ContributionActivity = typeof CONTRIBUTION_TABS[number]['value'];

function contributionActivity(value: string | undefined): ContributionActivity {
  return CONTRIBUTION_TABS.some((tab) => tab.value === value) ? value as ContributionActivity : 'edits';
}

function activityLabel(value: string): string {
  return ({ create: '새 문서', edit: '편집', move: '이동', delete: '삭제', restore: '복구', revert: '되돌리기', comment: '토론 댓글', status_change: '상태 변경', topic_change: '주제 변경', page_move: '문서 이동', pin_change: '댓글 고정', discussion_event: '토론 관리', edit_request: '편집 요청', review: '요청 검토' } as Record<string, string>)[value] ?? value;
}

function statusLabel(value: string): string {
  return ({ open: '열림', paused: '일시 중지', closed: '닫힘', pending: '대기', reviewing: '검토 중', accepted: '승인', rejected: '거절', stale: '기준판 변경' } as Record<string, string>)[value] ?? value;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value));
}

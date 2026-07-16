import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchWikiContributions, fetchWikiPublicProfile } from '../../../../lib/wiki-server-api';
import { WikiUserProfileHeader } from '../../../../components/wiki/wiki-user-profile-header';
import { GitMerge } from 'lucide-react';
import { WikiEditSummary } from '../../../../components/wiki/wiki-edit-summary';

interface PageProps {
  readonly params: Promise<{ profileId: string }>;
  readonly searchParams: Promise<{ cursor?: string; activity?: string }>;
}

export default async function WikiContributionsPage({ params, searchParams }: PageProps) {
  const [{ profileId }, query] = await Promise.all([params, searchParams]);
  const activity = contributionActivity(query.activity);
  const result = await fetchWikiContributions(profileId, query.cursor, activity).catch(() => null);
  if (!result) notFound();
  const publicProfile = await fetchWikiPublicProfile(result.profile.username);
  if (!publicProfile) notFound();
  const canonicalProfileId = result.profile.id;
  const mergedView = result.requestedProfileId !== canonicalProfileId || result.mergedProfileIds.length > 1;
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <Link href="/recent" className="hover:text-emerald-200">최근 변경</Link><span>/</span><span className="text-slate-200">기여 내역</span>
      </nav>
      <WikiUserProfileHeader profile={publicProfile} current="contributions" />
      {mergedView ? (
        <p className="flex items-start gap-2 rounded-lg border border-blue-300/20 bg-blue-300/10 px-3 py-2.5 text-sm leading-6 text-blue-100">
          <GitMerge className="mt-1 size-4 shrink-0" aria-hidden />
          연결된 위키 프로필 {result.mergedProfileIds.length}개의 공개 기여를 시간순으로 함께 표시합니다. 과거 편집의 작성자 기록은 원본 그대로 보존됩니다.
        </p>
      ) : null}
      <p className="text-sm text-slate-400">읽을 권한이 있는 공개 활동만 표시됩니다.</p>
      <nav aria-label="기여 활동 유형" className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {CONTRIBUTION_TABS.map((tab) => <Link key={tab.value} href={`/wiki/contributions/${canonicalProfileId}?activity=${tab.value}`} className={`chip min-h-11 justify-center ${activity === tab.value ? 'chip-accent' : 'chip-muted'}`} aria-current={activity === tab.value ? 'page' : undefined}>{tab.label}</Link>)}
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
            <p className="mt-3 text-sm text-slate-300"><WikiEditSummary summary={item.summary} hidden={item.summaryHidden} /></p>
            <p className="mt-2 text-xs text-slate-500">{formatDate(item.createdAt)} · {item.namespace}</p>
          </article>
        ))}
        {result.items.length === 0 ? <p className="p-6 text-sm text-slate-400">표시할 공개 기여가 없습니다.</p> : null}
      </section>
      {result.nextCursor ? <Link href={`/wiki/contributions/${canonicalProfileId}?activity=${activity}&cursor=${result.nextCursor}`} className="btn-secondary min-h-11 self-start">이전 활동 더 보기</Link> : null}
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

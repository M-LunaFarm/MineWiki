import { fetchWikiRecent } from '../../lib/wiki-server-api';
import { WikiRecentChangesClient } from '../../components/wiki/wiki-recent-changes-client';

export const dynamic = 'force-dynamic';
export const revalidate = 30;

interface RecentChangesPageProps {
  readonly searchParams: Promise<{ changeType?: string; namespace?: string; minor?: string }>;
}

export default async function RecentChangesPage({ searchParams }: RecentChangesPageProps) {
  const query = await searchParams;
  const filters = {
    changeType: cleanFilter(query.changeType),
    namespace: cleanFilter(query.namespace),
    minor: query.minor === 'true' || query.minor === 'false' ? query.minor : undefined
  };
  const changes = await fetchWikiRecent(filters);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="border-b border-white/10 pb-6">
        <h1 className="text-3xl font-bold text-white">최근 변경</h1>
        <p className="mt-3 text-sm text-slate-400">읽을 수 있는 문서의 변경 기록을 빠짐없이 탐색합니다.</p>
      </header>
      <form className="grid gap-3 border border-white/10 bg-[#111821] p-4 sm:grid-cols-3 lg:grid-cols-[1fr_1fr_1fr_auto]" action="/recent">
        <label className="grid gap-2 text-sm text-slate-300"><span>이름공간</span><select name="namespace" defaultValue={filters.namespace ?? ''} className="input min-h-11"><option value="">전체</option><option value="main">일반</option><option value="server">서버</option><option value="mod">모드</option><option value="modpack">모드팩</option><option value="project">프로젝트</option><option value="dev">개발</option><option value="help">도움말</option><option value="file">파일</option><option value="template">틀</option><option value="user">사용자</option></select></label>
        <label className="grid gap-2 text-sm text-slate-300"><span>변경 유형</span><select name="changeType" defaultValue={filters.changeType ?? ''} className="input min-h-11"><option value="">전체</option><option value="create">새 문서</option><option value="edit">편집</option><option value="move">이동</option><option value="revert">되돌리기</option><option value="delete">삭제</option><option value="restore">복구</option><option value="protect">보호</option></select></label>
        <label className="grid gap-2 text-sm text-slate-300"><span>편집 크기</span><select name="minor" defaultValue={filters.minor ?? ''} className="input min-h-11"><option value="">전체</option><option value="false">일반 편집</option><option value="true">사소한 편집</option></select></label>
        <button type="submit" className="btn-secondary min-h-11 self-end">필터 적용</button>
      </form>
      <WikiRecentChangesClient initial={changes} filters={filters} />
    </main>
  );
}

function cleanFilter(value: string | undefined): string | undefined {
  return value && /^[a-z0-9_-]{1,32}$/i.test(value) ? value : undefined;
}

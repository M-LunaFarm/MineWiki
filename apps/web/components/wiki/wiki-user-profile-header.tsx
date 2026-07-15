import Link from 'next/link';
import { BookOpenText, History, PencilLine, ShieldAlert } from 'lucide-react';
import type { WikiPublicProfileResponse } from '../../lib/wiki-api';
import { buildStandardWikiToolPath } from '../../lib/wiki-routes.mjs';

export function WikiUserProfileHeader({
  profile,
  current
}: {
  readonly profile: WikiPublicProfileResponse;
  readonly current: 'document' | 'contributions';
}) {
  return (
    <section className="surface-flat overflow-hidden" aria-labelledby="wiki-user-profile-name">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="flex min-w-0 items-center gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-emerald-300/25 bg-emerald-300/10 text-lg font-black text-emerald-200" aria-hidden>
            {profile.displayName.trim().charAt(0).toLocaleUpperCase('ko-KR') || 'M'}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 id="wiki-user-profile-name" className="break-words text-xl font-bold text-white sm:text-2xl">
                {profile.displayName}
              </h1>
              {profile.status === 'blocked' ? (
                <span className="chip border-red-300/30 text-red-200"><ShieldAlert className="size-3.5" /> 기여 차단됨</span>
              ) : null}
              {profile.isOwner ? <span className="chip chip-accent">내 사용자 문서</span> : null}
            </div>
            <p className="mt-1 break-all text-sm text-slate-400">@{profile.username}</p>
          </div>
        </div>
        {profile.canEditDocument ? (
          <Link href={buildStandardWikiToolPath(profile.documentPath, 'edit')} className="btn-primary min-h-11 w-full sm:w-auto">
            <PencilLine className="size-4" /> {profile.documentExists ? '사용자 문서 편집' : '사용자 문서 만들기'}
          </Link>
        ) : null}
      </div>
      <nav aria-label="사용자 문서 메뉴" className="grid grid-cols-2 border-t border-white/10">
        <Link href={profile.documentPath} aria-current={current === 'document' ? 'page' : undefined} className={`flex min-h-12 items-center justify-center gap-2 px-3 text-sm font-semibold transition ${current === 'document' ? 'bg-emerald-300/10 text-emerald-200' : 'text-slate-400 hover:bg-white/[0.035] hover:text-white'}`}>
          <BookOpenText className="size-4" /> 사용자 문서
        </Link>
        <Link href={profile.contributionsPath} aria-current={current === 'contributions' ? 'page' : undefined} className={`flex min-h-12 items-center justify-center gap-2 border-l border-white/10 px-3 text-sm font-semibold transition ${current === 'contributions' ? 'bg-emerald-300/10 text-emerald-200' : 'text-slate-400 hover:bg-white/[0.035] hover:text-white'}`}>
          <History className="size-4" /> 공개 기여
        </Link>
      </nav>
    </section>
  );
}

export function WikiUserProfileHub({
  profile,
  requestedDocumentPath
}: {
  readonly profile: WikiPublicProfileResponse;
  readonly requestedDocumentPath?: string;
}) {
  const editPath = requestedDocumentPath ?? profile.documentPath;
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <Link href="/wiki/%EB%8C%80%EB%AC%B8" className="hover:text-emerald-200">MineWiki</Link>
        <span>/</span><span>사용자</span><span>/</span><span className="break-all text-slate-200">{profile.username}</span>
      </nav>
      <WikiUserProfileHeader profile={profile} current="document" />
      <section className="surface-flat p-6 sm:p-8">
        <h2 className="break-words text-xl font-bold text-white">
          {requestedDocumentPath ? '요청한 하위 문서가 아직 없습니다.' : '아직 작성된 사용자 문서가 없습니다.'}
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
          이 프로필의 공개 기여 내역은 계속 확인할 수 있습니다. 사용자 문서는 본인과 위키 관리자만 만들고 편집할 수 있습니다.
        </p>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          {profile.canEditDocument ? (
            <Link href={buildStandardWikiToolPath(editPath, 'edit')} className="btn-primary min-h-11 justify-center">
              <PencilLine className="size-4" /> {requestedDocumentPath ? '이 하위 문서 작성' : '첫 사용자 문서 작성'}
            </Link>
          ) : null}
          <Link href={profile.contributionsPath} className="btn-secondary min-h-11 justify-center">
            <History className="size-4" /> 공개 기여 보기
          </Link>
        </div>
      </section>
    </main>
  );
}

'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { ArchiveRestore, Code2, Compass, FilePenLine, FolderPen, GitCommitHorizontal, Link2, Loader2, MessagesSquare, MessageSquareText, ShieldCheck, Trash2 } from 'lucide-react';
import { deleteWikiPage, moveWikiPage } from '../../lib/wiki-api';
import { useAuth } from '../providers/auth-context';
import { WikiWatchButton } from './wiki-watch-button';
import { buildServerWikiToolPath, buildWikiPagePath } from '../../lib/wiki-routes.mjs';
import { WikiReportButton } from './wiki-report-button';

interface WikiPageToolsProps {
  readonly pageId: string;
  readonly namespace: string;
  readonly spaceId: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly routePath: string;
}

export function WikiPageTools({ pageId, namespace, spaceId, title, displayTitle, routePath }: WikiPageToolsProps) {
  const { account, loading: authLoading } = useAuth();
  const [nextTitle, setNextTitle] = useState(title);
  const [nextNamespace, setNextNamespace] = useState(namespace);
  const [moveReason, setMoveReason] = useState('');
  const [leaveRedirect, setLeaveRedirect] = useState(true);
  const [deleteReason, setDeleteReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [working, setWorking] = useState<'move' | 'delete' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const isServerWiki = routePath === '/server' || routePath.startsWith('/server/');
  const isUserRoot = /^\/user\/[^/]+$/u.test(routePath);
  const rawHref = isServerWiki ? buildServerWikiToolPath(routePath, 'raw') : `/wiki/raw/${encodeURIComponent(pageId)}?returnTo=${encodeURIComponent(routePath)}`;
  const backlinksHref = isServerWiki ? buildServerWikiToolPath(routePath, 'backlinks') : `/wiki/backlinks/${encodeURIComponent(pageId)}?returnTo=${encodeURIComponent(routePath)}`;
  const discussionHref = isServerWiki ? buildServerWikiToolPath(routePath, 'discuss') : `/wiki/discuss/${encodeURIComponent(pageId)}?returnTo=${encodeURIComponent(routePath)}`;
  const requestsHref = isServerWiki ? buildServerWikiToolPath(routePath, 'requests') : `/wiki/edit-requests/${encodeURIComponent(pageId)}?returnTo=${encodeURIComponent(routePath)}`;
  const blameHref = isServerWiki ? buildServerWikiToolPath(routePath, 'blame') : `/wiki/blame/${encodeURIComponent(pageId)}?returnTo=${encodeURIComponent(routePath)}`;
  const aclHref = isServerWiki ? buildServerWikiToolPath(routePath, 'acl') : `/wiki/acl/${encodeURIComponent(pageId)}?returnTo=${encodeURIComponent(routePath)}`;

  async function move(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking('move');
    setMessage(null);
    try {
      const result = await moveWikiPage({
        pageId,
        namespace: nextNamespace,
        spaceId: nextNamespace === namespace ? spaceId : undefined,
        title: nextTitle,
        reason: moveReason,
        leaveRedirect
      });
      window.location.assign(pageHref(result.namespace, result.slug));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '문서를 이동하지 못했습니다.');
      setWorking(null);
    }
  }

  async function remove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmation !== displayTitle) {
      setMessage(`확인란에 “${displayTitle}”을 정확히 입력해 주세요.`);
      return;
    }
    setWorking('delete');
    setMessage(null);
    try {
      await deleteWikiPage({ pageId, reason: deleteReason });
      window.location.assign('/recent');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '문서를 삭제하지 못했습니다.');
      setWorking(null);
    }
  }

  return (
    <section className="surface-flat p-4">
      <h2 className="text-sm font-semibold text-white">문서 도구</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        <WikiWatchButton pageId={pageId} routePath={routePath} />
        <Link
          href={rawHref}
          className="chip chip-muted inline-flex min-h-11 items-center gap-1.5 px-3"
        >
          <Code2 className="size-3.5" /> 원문
        </Link>
        {account ? <Link href="/wiki/watchlist" className="chip chip-muted inline-flex min-h-11 items-center gap-1.5 px-3"><ArchiveRestore className="size-3.5" /> 관심 목록</Link> : null}
        <Link
          href={backlinksHref}
          className="chip chip-muted inline-flex min-h-11 items-center gap-1.5 px-3"
        >
          <Link2 className="size-3.5" /> 역링크
        </Link>
        <Link
          href={discussionHref}
          className="chip chip-muted inline-flex min-h-11 items-center gap-1.5 px-3"
        >
          <MessageSquareText className="size-3.5" /> 토론
        </Link>
        <Link href={requestsHref} className="chip chip-muted inline-flex min-h-11 items-center gap-1.5 px-3"><FilePenLine className="size-3.5" /> 편집 요청</Link>
        <Link href="/wiki/discussions" className="chip chip-muted inline-flex min-h-11 items-center gap-1.5 px-3"><MessagesSquare className="size-3.5" /> 최근 토론</Link>
        <Link href={blameHref} className="chip chip-muted inline-flex min-h-11 items-center gap-1.5 px-3"><GitCommitHorizontal className="size-3.5" /> 기여 추적</Link>
        <Link href={aclHref} className="chip chip-muted inline-flex min-h-11 items-center gap-1.5 px-3"><ShieldCheck className="size-3.5" /> ACL</Link>
        <Link href="/wiki/special" className="chip chip-muted inline-flex min-h-11 items-center gap-1.5 px-3"><Compass className="size-3.5" /> 특수 문서</Link>
        <WikiReportButton targetType="page" targetId={pageId} returnTo={routePath} />
      </div>
      {!authLoading && !account ? (
        <p className="mt-4 border-t border-white/10 pt-4 text-xs text-slate-500">
          이동·삭제 등 문서 관리 작업은 <Link href={`/login?returnTo=${encodeURIComponent(routePath)}`} className="text-emerald-300 hover:underline">로그인</Link> 후 사용할 수 있습니다.
        </p>
      ) : null}
      {account && !isUserRoot ? <details className="mt-4 border-t border-white/10 pt-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-300 hover:text-white">이동·삭제</summary>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          이동과 삭제는 문서 작성자, 공간 관리자 또는 명시적으로 허용된 ACL 사용자만 실행할 수 있습니다.
        </p>
        <Link href="/wiki/deleted" className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-300 hover:text-emerald-200">
          <ArchiveRestore className="size-3.5" /> 삭제 문서함
        </Link>
        <form onSubmit={move} className="mt-4 space-y-3">
          <label className="block text-xs font-semibold text-slate-400">
            대상 네임스페이스
            <select
              value={nextNamespace}
              onChange={(event) => setNextNamespace(event.target.value)}
              className="mt-1.5 min-h-11 w-full rounded-md border border-white/10 bg-[#0d1219] px-3 text-sm text-white outline-none focus:border-emerald-400/50"
              aria-describedby="wiki-move-namespace-help"
            >
              {moveNamespaceOptions(namespace).map((option) => (
                <option key={option.code} value={option.code}>{option.label}</option>
              ))}
            </select>
            <span id="wiki-move-namespace-help" className="mt-1.5 block text-[11px] font-normal leading-5 text-slate-500">
              사용자·파일 문서는 식별자와 파일 연결을 보호하기 위해 현재 네임스페이스 안에서만 이동할 수 있습니다.
            </span>
          </label>
          <label className="block text-xs font-semibold text-slate-400">
            새 문서 제목
            <input
              value={nextTitle}
              onChange={(event) => setNextTitle(event.target.value)}
              required
              className="mt-1.5 min-h-11 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400/50"
            />
          </label>
          <label className="block text-xs font-semibold text-slate-400">
            이동 사유
            <input
              value={moveReason}
              onChange={(event) => setMoveReason(event.target.value)}
              maxLength={255}
              className="mt-1.5 min-h-11 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400/50"
            />
          </label>
          <label className="flex items-start gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={leaveRedirect} onChange={(event) => setLeaveRedirect(event.target.checked)} />
            이전 제목에 넘겨주기 문서 남기기
          </label>
          <button type="submit" disabled={working !== null} className="chip chip-accent inline-flex min-h-11 items-center gap-1.5 px-4 disabled:opacity-50">
            {working === 'move' ? <Loader2 className="size-3.5 animate-spin" /> : <FolderPen className="size-3.5" />}
            이동
          </button>
        </form>
        <form onSubmit={remove} className="mt-5 space-y-3 border-t border-red-300/15 pt-4">
          <label className="block text-xs font-semibold text-slate-400">
            삭제 사유
            <input
              value={deleteReason}
              onChange={(event) => setDeleteReason(event.target.value)}
              required
              maxLength={255}
              className="mt-1.5 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-red-300/50"
            />
          </label>
          <label className="block text-xs font-semibold text-slate-400">
            확인: {displayTitle}
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder={displayTitle}
              required
              className="mt-1.5 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-red-300/50"
            />
          </label>
          <button type="submit" disabled={working !== null} className="inline-flex items-center gap-1.5 rounded-full border border-red-300/30 px-3 py-1.5 text-xs font-semibold text-red-200 transition hover:bg-red-300/10 disabled:opacity-50">
            {working === 'delete' ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            삭제
          </button>
        </form>
        {message ? <p role="alert" className="mt-3 text-xs leading-5 text-amber-200">{message}</p> : null}
      </details> : null}
      {isUserRoot ? <p className="mt-4 border-t border-white/10 pt-4 text-xs leading-5 text-slate-500">사용자 루트 문서는 계정 식별자를 보호하기 위해 이동하거나 삭제할 수 없습니다.</p> : null}
    </section>
  );
}

function pageHref(namespace: string, slug: string): string {
  return buildWikiPagePath(namespace, slug);
}

const STANDARD_MOVE_NAMESPACES = [
  { code: 'main', label: '일반' },
  { code: 'mod', label: '모드' },
  { code: 'modpack', label: '모드팩' },
  { code: 'guide', label: '가이드' },
  { code: 'dev', label: '개발' },
  { code: 'data', label: '데이터' },
  { code: 'help', label: '도움말' },
  { code: 'project', label: '프로젝트' },
  { code: 'template', label: '틀' },
  { code: 'category', label: '분류' },
] as const;

function moveNamespaceOptions(namespace: string): ReadonlyArray<{ readonly code: string; readonly label: string }> {
  if (namespace === 'user') return [{ code: 'user', label: '사용자' }];
  if (namespace === 'file') return [{ code: 'file', label: '파일' }];
  if (namespace === 'server') return [{ code: 'server', label: '서버 위키' }, ...STANDARD_MOVE_NAMESPACES];
  return STANDARD_MOVE_NAMESPACES.some((option) => option.code === namespace)
    ? STANDARD_MOVE_NAMESPACES
    : [{ code: namespace, label: namespace }];
}

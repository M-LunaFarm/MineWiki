'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AlertTriangle, History, Loader2, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import { useAuth } from '../providers/auth-context';
import {
  fetchWikiAdminPages,
  fetchWikiAdminRecent,
  setWikiAdminPageDeleted,
  updateWikiPageProtection,
  type WikiAdminPageSummary,
  type WikiAdminRecentChange
} from '../../lib/wiki-api';

const PROTECTION_LEVELS = [
  'open',
  'login_required',
  'review_required',
  'autoconfirmed_only',
  'trusted_only',
  'official_only',
  'owner_only',
  'admin_only',
  'locked'
];

export function WikiAdminConsole({ view }: { readonly view: 'overview' | 'pages' }) {
  const { account, loading: authLoading } = useAuth();
  const [pages, setPages] = useState<WikiAdminPageSummary[]>([]);
  const [recent, setRecent] = useState<WikiAdminRecentChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workingPageId, setWorkingPageId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [pageRows, recentRows] = await Promise.all([
        fetchWikiAdminPages(),
        fetchWikiAdminRecent()
      ]);
      setPages(pageRows);
      setRecent(recentRows);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : '위키 관리 데이터를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (authLoading) {
      return;
    }
    if (!account) {
      setLoading(false);
      return;
    }
    void load();
  }, [account, authLoading]);

  async function changeProtection(pageId: string, protectionLevel: string) {
    setWorkingPageId(pageId);
    setError(null);
    try {
      const updated = await updateWikiPageProtection({ pageId, protectionLevel });
      setPages((current) => current.map((page) => (page.id === pageId ? updated : page)));
      const recentRows = await fetchWikiAdminRecent();
      setRecent(recentRows);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : '보호 수준을 변경하지 못했습니다.');
    } finally {
      setWorkingPageId(null);
    }
  }

  async function toggleDeleted(page: WikiAdminPageSummary) {
    setWorkingPageId(page.id);
    setError(null);
    try {
      const updated = await setWikiAdminPageDeleted({
        pageId: page.id,
        deleted: page.status !== 'deleted'
      });
      setPages((current) => current.map((item) => (item.id === page.id ? updated : item)));
      const recentRows = await fetchWikiAdminRecent();
      setRecent(recentRows);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : '문서 상태를 변경하지 못했습니다.');
    } finally {
      setWorkingPageId(null);
    }
  }

  if (authLoading || loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-300" />
      </div>
    );
  }

  if (!account) {
    return (
      <section className="rounded-lg border border-white/10 bg-white/[0.03] p-6">
        <h1 className="text-2xl font-semibold text-white">로그인이 필요합니다</h1>
        <Link href="/login?returnTo=/admin/wiki" className="btn-primary mt-5 h-10">
          로그인
        </Link>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-white/10 bg-white/[0.03] p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-200">
              <ShieldCheck className="h-4 w-4" />
              Wiki Admin
            </div>
            <h1 className="mt-2 text-2xl font-semibold text-white">위키 관리</h1>
            <p className="mt-2 text-sm text-slate-400">최근 변경, 문서 보호, 삭제/복구 상태를 관리합니다.</p>
          </div>
          <nav className="flex flex-wrap gap-2">
            <Link href="/admin/wiki" className={`chip ${view === 'overview' ? 'chip-accent' : 'chip-muted'}`}>
              최근 변경
            </Link>
            <Link href="/admin/wiki/pages" className={`chip ${view === 'pages' ? 'chip-accent' : 'chip-muted'}`}>
              문서
            </Link>
            <Link href="/admin/wiki/acl" className="chip chip-muted">
              ACL
            </Link>
            <Link href="/admin/wiki/users" className="chip chip-muted">
              사용자 차단
            </Link>
            <Link href="/admin/wiki/batch-rollback" className="chip chip-muted">
              일괄 복구
            </Link>
          </nav>
        </div>
      </section>

      {error ? (
        <div className="flex gap-3 rounded-lg border border-red-300/30 bg-red-500/10 p-4 text-sm text-red-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <p>{error}</p>
        </div>
      ) : null}

      {view === 'overview' ? (
        <RecentTable rows={recent} />
      ) : (
        <PagesTable
          rows={pages}
          workingPageId={workingPageId}
          onChangeProtection={changeProtection}
          onToggleDeleted={toggleDeleted}
        />
      )}
    </div>
  );
}

function RecentTable({ rows }: { readonly rows: WikiAdminRecentChange[] }) {
  return (
    <section className="overflow-x-auto rounded-lg border border-white/10 bg-[#111821]">
      <table className="min-w-full text-left text-sm">
        <thead className="border-b border-white/10 text-xs uppercase text-slate-500">
          <tr>
            <th className="px-4 py-3">동작</th>
            <th className="px-4 py-3">문서</th>
            <th className="px-4 py-3">요약</th>
            <th className="px-4 py-3">시간</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10 text-slate-300">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-4 py-3 font-semibold text-white">{row.changeType}</td>
              <td className="px-4 py-3">
                {row.revisionId ? <Link href={`/admin/wiki/revisions/${encodeURIComponent(row.revisionId)}`} className="text-emerald-200 hover:text-emerald-100">{row.namespaceCode}:{row.title}</Link> : `${row.namespaceCode}:${row.title}`}
              </td>
              <td className="px-4 py-3">{row.summary ?? '요약 없음'}</td>
              <td className="px-4 py-3">{formatDate(row.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function PagesTable({
  rows,
  workingPageId,
  onChangeProtection,
  onToggleDeleted
}: {
  readonly rows: WikiAdminPageSummary[];
  readonly workingPageId: string | null;
  readonly onChangeProtection: (pageId: string, protectionLevel: string) => void;
  readonly onToggleDeleted: (page: WikiAdminPageSummary) => void;
}) {
  return (
    <section className="overflow-x-auto rounded-lg border border-white/10 bg-[#111821]">
      <table className="min-w-full text-left text-sm">
        <thead className="border-b border-white/10 text-xs uppercase text-slate-500">
          <tr>
            <th className="px-4 py-3">문서</th>
            <th className="px-4 py-3">상태</th>
            <th className="px-4 py-3">보호</th>
            <th className="px-4 py-3">수정</th>
            <th className="px-4 py-3">작업</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10 text-slate-300">
          {rows.map((page) => (
            <tr key={page.id}>
              <td className="px-4 py-3">
                <div className="font-semibold text-white">{page.displayTitle}</div>
                <div className="text-xs text-slate-500">#{page.id}</div>
              </td>
              <td className="px-4 py-3">{page.status}</td>
              <td className="px-4 py-3">
                <select
                  value={page.protectionLevel}
                  disabled={workingPageId === page.id}
                  onChange={(event) => onChangeProtection(page.id, event.target.value)}
                  className="h-9 rounded-md border border-white/10 bg-[#15171b] px-2 text-xs text-white"
                >
                  {PROTECTION_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-4 py-3">{formatDate(page.updatedAt)}</td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/admin/wiki/pages/${encodeURIComponent(page.id)}/revisions${page.routePath ? `?returnTo=${encodeURIComponent(page.routePath)}` : ''}`}
                    className="inline-flex h-8 items-center gap-2 rounded-md border border-white/10 px-3 text-xs font-semibold text-slate-200 hover:border-emerald-300/40"
                  >
                    <History className="h-3.5 w-3.5" /> 판 관리
                  </Link>
                  <button
                  type="button"
                  onClick={() => onToggleDeleted(page)}
                  disabled={workingPageId === page.id}
                  className="inline-flex h-8 items-center gap-2 rounded-md border border-white/10 px-3 text-xs font-semibold text-slate-200 hover:border-emerald-300/40 disabled:opacity-50"
                  >
                    {page.status === 'deleted' ? <RotateCcw className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                    {page.status === 'deleted' ? '복구' : '삭제'}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul'
  }).format(new Date(value));
}

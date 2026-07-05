'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Eye, Loader2, Save } from 'lucide-react';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { useAuth } from '../providers/auth-context';
import {
  fetchWikiRevision,
  previewWikiMarkup,
  saveWikiPage,
  type WikiPageResponse
} from '../../lib/wiki-api';

interface WikiEditorClientProps {
  readonly page: WikiPageResponse | null;
  readonly namespace: string;
  readonly title: string;
  readonly routePath: string;
}

export function WikiEditorClient({ page, namespace, title, routePath }: WikiEditorClientProps) {
  const router = useRouter();
  const { account, loading } = useAuth();
  const [contentRaw, setContentRaw] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [isMinor, setIsMinor] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [loadingRevision, setLoadingRevision] = useState(Boolean(page));
  const [previewing, startPreviewTransition] = useTransition();
  const [saving, startSaveTransition] = useTransition();

  const baseRevisionId = page?.revision.id;
  const heading = page ? `${page.displayTitle} 편집` : `${title} 새 문서 작성`;
  const loginHref = `/login?returnTo=${encodeURIComponent(`${routePath}/edit`)}`;

  useEffect(() => {
    let cancelled = false;
    async function loadRevision() {
      if (!page) {
        setContentRaw('');
        setLoadingRevision(false);
        return;
      }
      try {
        setLoadingRevision(true);
        const revision = await fetchWikiRevision(page.revision.id);
        if (!cancelled) {
          setContentRaw(revision.contentRaw);
        }
      } catch (error) {
        if (!cancelled) {
          setFeedback(error instanceof Error ? error.message : '리비전을 불러오지 못했습니다.');
        }
      } finally {
        if (!cancelled) {
          setLoadingRevision(false);
        }
      }
    }
    void loadRevision();
    return () => {
      cancelled = true;
    };
  }, [page]);

  const canSubmit = useMemo(() => {
    return Boolean(account && contentRaw.trim() && editSummary.trim() && !loadingRevision);
  }, [account, contentRaw, editSummary, loadingRevision]);

  function renderPreview() {
    setFeedback(null);
    startPreviewTransition(async () => {
      try {
        const preview = await previewWikiMarkup(contentRaw);
        setPreviewHtml(preview.html);
        if (preview.errors.length > 0) {
          setFeedback(preview.errors.join('\n'));
        }
      } catch (error) {
        setFeedback(error instanceof Error ? error.message : '미리보기를 생성하지 못했습니다.');
      }
    });
  }

  function submit() {
    if (!canSubmit) {
      setFeedback('본문과 편집 요약을 입력해야 합니다.');
      return;
    }
    setFeedback(null);
    startSaveTransition(async () => {
      try {
        await saveWikiPage({
          pageId: page?.id,
          namespace,
          title,
          contentRaw,
          editSummary,
          isMinor,
          baseRevisionId
        });
        router.push(routePath);
        router.refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : '저장하지 못했습니다.';
        setFeedback(`${message} 충돌이 발생했다면 최신 리비전을 다시 불러온 뒤 재시도하세요.`);
      }
    });
  }

  if (loading) {
    return (
      <main className="mx-auto flex min-h-[50vh] max-w-4xl items-center justify-center px-4">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-300" />
      </main>
    );
  }

  if (!account) {
    return (
      <main className="mx-auto flex min-h-[50vh] max-w-3xl flex-col justify-center px-4 py-12">
        <div className="surface-flat p-6">
          <h1 className="text-2xl font-bold text-white">로그인이 필요합니다</h1>
          <p className="mt-3 text-sm text-slate-300">문서 편집은 MineWiki 계정으로 로그인한 사용자만 사용할 수 있습니다.</p>
          <Link href={loginHref} className="btn-primary mt-5 h-10">
            로그인
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="border-b border-white/10 pb-5">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-slate-400">
          <Link href={routePath} className="hover:text-emerald-200">
            문서로 돌아가기
          </Link>
          <span>/</span>
          <span>{namespace}</span>
        </div>
        <h1 className="text-3xl font-bold text-white">{heading}</h1>
        <p className="mt-2 text-sm text-slate-400">기존 MineWiki 마크업 문법으로 저장됩니다.</p>
      </header>

      {feedback ? (
        <div className="flex gap-3 rounded-lg border border-amber-300/25 bg-amber-500/10 p-4 text-sm text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <p className="whitespace-pre-wrap">{feedback}</p>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="space-y-4">
          <textarea
            value={contentRaw}
            onChange={(event) => setContentRaw(event.target.value)}
            disabled={loadingRevision || saving}
            className="min-h-[520px] w-full resize-y rounded-lg border border-white/10 bg-[#0d1219] p-4 font-mono text-sm leading-6 text-slate-100 outline-none transition focus:border-emerald-300/50"
            spellCheck={false}
          />
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
            <input
              value={editSummary}
              onChange={(event) => setEditSummary(event.target.value)}
              placeholder="편집 요약"
              className="h-10 rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-emerald-300/50"
            />
            <label className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={isMinor}
                onChange={(event) => setIsMinor(event.target.checked)}
                className="h-4 w-4 accent-emerald-400"
              />
              사소한 편집
            </label>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit || saving}
              className="btn-primary h-10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              저장
            </button>
          </div>
        </section>

        <aside className="space-y-4">
          <section className="surface-flat p-4">
            <h2 className="text-sm font-semibold text-white">저장 기준</h2>
            <dl className="mt-3 space-y-2 text-sm text-slate-300">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">문서</dt>
                <dd className="text-right">{title}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">리비전</dt>
                <dd>{baseRevisionId ? `#${page?.revision.revisionNo}` : '새 문서'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">충돌 처리</dt>
                <dd>placeholder</dd>
              </div>
            </dl>
          </section>

          <section className="surface-flat p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-white">미리보기</h2>
              <button
                type="button"
                onClick={renderPreview}
                disabled={previewing}
                className="inline-flex h-8 items-center gap-2 rounded-md border border-white/10 px-3 text-xs font-semibold text-slate-200 hover:border-emerald-300/40"
              >
                {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
                보기
              </button>
            </div>
            <div
              className="wiki-rendered max-h-[520px] overflow-auto p-4 text-sm"
              dangerouslySetInnerHTML={{ __html: previewHtml || '<p>미리보기를 생성하세요.</p>' }}
            />
          </section>
        </aside>
      </div>
    </main>
  );
}

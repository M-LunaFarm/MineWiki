'use client';

import { ExternalLink, Globe2, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

import { csrfHeaders } from '../../lib/csrf';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';

type PublicationStatus = 'draft' | 'published' | 'unpublished';
type ReadinessBlocker =
  | 'invalid_link'
  | 'invalid_site_slug'
  | 'missing_root_page'
  | 'missing_public_root_revision'
  | 'missing_public_document'
  | 'missing_required_documents'
  | 'incomplete_introduction'
  | 'placeholder_rules'
  | 'missing_official_channel'
  | 'search_index_not_ready';

interface PublicationState {
  readonly status: PublicationStatus;
  readonly version: number;
  readonly publishedAt: string | null;
  readonly unpublishedAt: string | null;
  readonly updatedAt: string | null;
  readonly wikiUrl: string;
  readonly release: {
    readonly id: string;
    readonly version: number;
    readonly publishedAt: string;
    readonly pageCount: number;
  } | null;
  readonly readiness: {
    readonly ready: boolean;
    readonly blockers: readonly ReadinessBlocker[];
  };
}

const STATUS_COPY: Record<PublicationStatus, { readonly label: string; readonly description: string }> = {
  draft: { label: '초안', description: '권한 있는 소유자와 협업자만 같은 주소에서 미리 볼 수 있습니다.' },
  published: { label: '공개', description: '방문자는 마지막 공개 릴리스를 읽습니다. 이후 편집·이동·삭제는 변경사항을 다시 공개할 때까지 작업본에만 남습니다.' },
  unpublished: { label: '비공개', description: '내용과 협업자 설정은 보존되며 권한 있는 사용자만 미리 볼 수 있습니다.' },
};

const BLOCKER_COPY: Record<ReadinessBlocker, string> = {
  invalid_link: '서버와 위키 연결이 일치하지 않습니다.',
  invalid_site_slug: '공개 사이트 주소를 먼저 설정해 주세요.',
  missing_root_page: '서버 위키 대문이 없습니다.',
  missing_public_root_revision: '대문에 공개 가능한 최신 판이 없습니다.',
  missing_public_document: '공개 가능한 문서를 한 개 이상 준비해 주세요.',
  missing_required_documents: '대문·시작하기·규칙·FAQ 문서를 모두 공개 가능한 상태로 준비해 주세요.',
  incomplete_introduction: '대문에 실제 서버 소개를 80자 이상 작성하거나 기본 본문을 직접 보강해 주세요.',
  placeholder_rules: '기본 규칙 체크리스트를 서버의 실제 공식 규칙으로 교체해 주세요.',
  missing_official_channel: '공식 홈페이지 또는 Discord 채널을 서버 정보에 등록해 주세요.',
  search_index_not_ready: '필수 문서의 검색 색인이 최신 판과 일치하지 않습니다. 잠시 후 다시 확인해 주세요.',
};

export function ServerWikiPublicationSettings({ serverId }: { readonly serverId: string }) {
  const baseUrl = normalizeApiBaseUrl();
  const [publication, setPublication] = useState<PublicationState | null>(null);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ readonly tone: 'error' | 'success'; readonly text: string } | null>(null);

  async function load() {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${encodeURIComponent(serverId)}/wiki-publication`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? '공개 상태를 불러오지 못했습니다.');
      setPublication(body as PublicationState);
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '공개 상태를 불러오지 못했습니다.' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [baseUrl, serverId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function changeStatus(status: 'published' | 'unpublished') {
    if (!publication || saving || reason.trim().length < 5) return;
    if (status === 'unpublished' && confirmation !== '비공개') return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${encodeURIComponent(serverId)}/wiki-publication`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({ status, expectedVersion: publication.version, reason: reason.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? '공개 상태를 변경하지 못했습니다.');
      setPublication(body as PublicationState);
      setReason('');
      setConfirmation('');
      setMessage({ tone: 'success', text: status === 'published' ? '서버 위키를 공개했습니다.' : '서버 위키를 비공개로 전환했습니다.' });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '공개 상태를 변경하지 못했습니다.' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <section className="flex min-h-28 items-center justify-center rounded-xl border border-white/10 bg-white/[0.025]"><Loader2 className="size-5 animate-spin text-emerald-300" aria-label="공개 상태 불러오는 중" /></section>;
  if (!publication) return <section className="rounded-xl border border-red-300/25 bg-red-400/10 p-4 text-sm text-red-100">{message?.text ?? '공개 상태를 불러오지 못했습니다.'}<button type="button" onClick={() => void load()} className="mt-3 flex min-h-11 items-center gap-2 rounded-lg border border-red-200/30 px-4"><RefreshCw className="size-4" />다시 시도</button></section>;

  const copy = STATUS_COPY[publication.status];
  const canPublish = reason.trim().length >= 5 && publication.readiness.ready;
  const canUnpublish = reason.trim().length >= 5 && confirmation === '비공개';

  return (
    <section className="rounded-xl border border-emerald-300/20 bg-emerald-400/[0.04] p-4 sm:p-6" aria-labelledby="server-wiki-publication-title">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-emerald-400/10 text-emerald-300"><Globe2 className="size-5" aria-hidden="true" /></span>
          <div>
            <div className="flex flex-wrap items-center gap-2"><h2 id="server-wiki-publication-title" className="font-semibold text-white">공개 상태</h2><span className="rounded-full border border-emerald-300/25 px-2.5 py-1 text-xs font-bold text-emerald-200" aria-live="polite">{copy.label}</span></div>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">{copy.description}</p>
            <a href={publication.wikiUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-emerald-300 hover:text-emerald-200"><ExternalLink className="size-4" />위키 주소 열기</a>
          </div>
        </div>
        <div className="text-right text-xs leading-5 text-slate-500">
          <p>상태 버전 {publication.version}</p>
          {publication.release ? <p>공개 릴리스 v{publication.release.version} · 문서 {publication.release.pageCount}개</p> : null}
        </div>
      </div>

      {!publication.readiness.ready ? <div className="mt-5 rounded-lg border border-amber-300/25 bg-amber-400/10 p-4"><p className="flex items-center gap-2 text-sm font-semibold text-amber-100"><ShieldAlert className="size-4" />공개 전 확인이 필요합니다</p><ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-amber-100/80">{publication.readiness.blockers.map((blocker) => <li key={blocker}>{BLOCKER_COPY[blocker]}</li>)}</ul></div> : null}
      {message ? <p className={`mt-4 text-sm ${message.tone === 'error' ? 'text-red-200' : 'text-emerald-200'}`} role="status">{message.text}</p> : null}

      <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)_auto] lg:items-end">
        <label className="text-xs font-semibold text-slate-300">변경 사유
          <input value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={500} placeholder="5자 이상 입력" className="mt-1.5 min-h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-emerald-300/50" />
        </label>
        {publication.status === 'published' ? <label className="text-xs font-semibold text-slate-300">확인 문구: 비공개
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="비공개" className="mt-1.5 min-h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-amber-300/50" />
        </label> : <div className="hidden lg:block" />}
        <div className="flex flex-col gap-2 sm:flex-row">
          <button type="button" onClick={() => void changeStatus('published')} disabled={!canPublish || saving} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-emerald-400 px-5 text-sm font-bold text-emerald-950 disabled:cursor-not-allowed disabled:opacity-50 lg:w-auto">{saving ? <Loader2 className="size-4 animate-spin" /> : null}{publication.status === 'published' ? '변경사항 공개' : '위키 공개'}</button>
          {publication.status === 'published' ? <button type="button" onClick={() => void changeStatus('unpublished')} disabled={!canUnpublish || saving} className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-amber-300/35 px-5 text-sm font-bold text-amber-100 hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-50 lg:w-auto">비공개 전환</button> : null}
        </div>
      </div>
    </section>
  );
}

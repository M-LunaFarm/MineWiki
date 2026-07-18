import Link from 'next/link';
import { AlertCircle, CheckCircle2, ExternalLink } from 'lucide-react';

export type ServerWikiReadiness = {
  readonly status: 'unlinked' | 'repair_required' | 'needs_attention' | 'ready';
  readonly wikiUrl: string | null;
  readonly completedChecks: number;
  readonly totalChecks: number;
  readonly checks: Record<string, boolean>;
  readonly nextAction: { readonly code: string; readonly label: string; readonly href: string } | null;
};

const READINESS_LABELS: Readonly<Record<string, string>> = {
  canonicalLink: '안전한 서버 연결',
  requiredDocuments: '필수 문서 4개',
  introduction: '서버 소개',
  officialRules: '공식 규칙',
  officialChannels: '공식 홈페이지 또는 Discord',
  searchIndex: '문서 검색 색인',
};

export function ServerWikiReadinessCard({ readiness }: { readonly readiness: ServerWikiReadiness }) {
  if (readiness.status === 'unlinked') return null;
  const ready = readiness.status === 'ready';
  const tone = ready
    ? 'border-emerald-400/25 bg-emerald-400/5'
    : readiness.status === 'repair_required'
      ? 'border-red-400/25 bg-red-400/5'
      : 'border-amber-300/25 bg-amber-300/5';
  const title = ready
    ? '문서 공간 준비 완료'
    : readiness.status === 'repair_required'
      ? '연결 복구 필요'
      : '문서 완성도 보강 필요';

  return (
    <div className={`mt-4 rounded-lg border p-4 ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold text-white">
          {ready
            ? <CheckCircle2 className="size-4 text-emerald-300" />
            : <AlertCircle className="size-4 text-amber-300" />}
          {title}
        </p>
        <span className="text-xs text-slate-400">
          {readiness.completedChecks}/{readiness.totalChecks} 확인 완료
        </span>
      </div>
      {readiness.status === 'needs_attention' ? (
        <div className="mt-3 grid gap-2 text-xs text-slate-300 sm:grid-cols-2">
          {Object.entries(readiness.checks).map(([key, complete]) => (
            <span key={key} className="flex items-center gap-2">
              <span className={`size-1.5 rounded-full ${complete ? 'bg-emerald-300' : 'bg-amber-300'}`} />
              {READINESS_LABELS[key] ?? key}
            </span>
          ))}
        </div>
      ) : null}
      {readiness.nextAction ? (
        <Link href={readiness.nextAction.href} className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg bg-[#13ec80] px-4 py-2 text-xs font-bold text-[#06140d] transition hover:bg-[#1ee6a4]">
          {readiness.nextAction.label}
          <ExternalLink className="size-3.5" />
        </Link>
      ) : null}
    </div>
  );
}

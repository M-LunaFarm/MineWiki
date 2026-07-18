'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment } from 'react';
import type { AuditEvent } from '../../lib/audit-api';

export function AuditEventRow({ event, expanded, onToggle }: {
  readonly event: AuditEvent;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return <Fragment>
    <tr>
      <td className="px-4 py-3">
        <button type="button" onClick={onToggle} aria-expanded={expanded} aria-label={`${event.action} 상세 ${expanded ? '닫기' : '열기'}`} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-slate-300 hover:bg-white/5 hover:text-white">
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
      </td>
      <td className="whitespace-nowrap px-4 py-3">{formatDate(event.createdAt)}</td>
      <td className="px-4 py-3"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${severityClass(event.severity)}`}>{event.severity}</span></td>
      <td className="px-4 py-3 font-semibold text-white">{event.category}</td>
      <td className="px-4 py-3 font-mono text-xs">{event.action}</td>
      <td className="px-4 py-3">{event.subjectType ? `${event.subjectType}:${event.subjectId ?? '-'}` : '-'}</td>
    </tr>
    {expanded ? <tr className="bg-black/20"><td colSpan={6} className="px-5 py-5">
      <dl className="grid gap-4 text-xs sm:grid-cols-2 xl:grid-cols-4">
        <Detail label="이벤트 ID" value={event.id} />
        <Detail label="작업 계정" value={event.actorAccountId} />
        <Detail label="위키 프로필" value={event.actorProfileId} />
        <Detail label="요청 ID" value={event.requestId} />
        {event.ipAddress ? <Detail label="IP 주소" value={event.ipAddress} /> : null}
        {event.userAgent ? <Detail label="User-Agent" value={event.userAgent} /> : null}
      </dl>
      <div className="mt-4"><p className="text-xs font-semibold text-slate-400">안전하게 마스킹된 메타데이터</p><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border border-white/10 bg-black/30 p-3 text-xs leading-5 text-slate-300">{formatMetadata(event.metadata)}</pre></div>
    </td></tr> : null}
  </Fragment>;
}

function Detail({ label, value }: { readonly label: string; readonly value: string | null }) {
  return <div><dt className="font-semibold text-slate-500">{label}</dt><dd className="mt-1 break-all font-mono text-slate-200">{value ?? '-'}</dd></div>;
}

function formatMetadata(value: unknown): string {
  if (value === null || value === undefined) return '-';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value));
}

function severityClass(severity: string): string {
  if (severity === 'critical' || severity === 'error') return 'bg-red-400/15 text-red-200';
  if (severity === 'warning') return 'bg-amber-300/15 text-amber-100';
  return 'bg-emerald-300/10 text-emerald-200';
}

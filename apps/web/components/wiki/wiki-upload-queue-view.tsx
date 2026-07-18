'use client';

import Link from 'next/link';
import { CheckCircle2, CircleAlert, Clock3, Loader2, RotateCcw, Trash2 } from 'lucide-react';

export interface WikiUploadResult {
  readonly id: string;
  readonly filename: string;
  readonly wikiDocumentPath: string | null;
}

export interface WikiUploadQueueItem {
  readonly id: string;
  readonly file: File;
  readonly status: 'queued' | 'uploading' | 'success' | 'failed';
  readonly result: WikiUploadResult | null;
  readonly error: string | null;
}

interface WikiUploadQueueViewProps {
  readonly items: readonly WikiUploadQueueItem[];
  readonly busy: boolean;
  readonly onRemove: (id: string) => void;
  readonly onRetry: (id: string) => void;
}

export function WikiUploadQueueView({ items, busy, onRemove, onRetry }: WikiUploadQueueViewProps) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="wiki-upload-queue-title" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="wiki-upload-queue-title" className="text-sm font-semibold text-slate-200">업로드 대기열</h2>
        <span className="text-xs text-slate-500">{items.length} / 10개 · {formatBytes(items.reduce((sum, item) => sum + item.file.size, 0))}</span>
      </div>
      <ul className="divide-y divide-white/10 border border-white/10 bg-black/10">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
            <QueueStatus status={item.status} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-200">{item.file.name}</p>
              <p className="mt-1 text-xs text-slate-500">{formatBytes(item.file.size)}</p>
              {item.status === 'success' && item.result ? (
                <div className="mt-2 text-xs text-emerald-200">
                  <code className="break-all">{`[[파일:${item.result.filename}]]`}</code>
                  {item.result.wikiDocumentPath ? <Link href={item.result.wikiDocumentPath} className="ml-3 font-semibold underline underline-offset-4">파일 문서</Link> : null}
                </div>
              ) : null}
              {item.status === 'failed' && item.error ? <p role="alert" className="mt-2 text-xs leading-5 text-red-200">{item.error}</p> : null}
            </div>
            <div className="flex shrink-0 gap-2">
              {item.status === 'failed' ? <button type="button" disabled={busy} onClick={() => onRetry(item.id)} className="btn-secondary min-h-9 px-3 text-xs disabled:opacity-50"><RotateCcw className="size-3.5" /> 재시도</button> : null}
              {item.status !== 'uploading' ? <button type="button" disabled={busy} onClick={() => onRemove(item.id)} aria-label={`${item.file.name} 대기열에서 제거`} className="grid min-h-9 min-w-9 place-items-center rounded-md border border-white/10 text-slate-400 hover:text-red-200 disabled:opacity-50"><Trash2 className="size-4" /></button> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function QueueStatus({ status }: { readonly status: WikiUploadQueueItem['status'] }) {
  if (status === 'uploading') return <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-emerald-300" aria-label="업로드 중" />;
  if (status === 'success') return <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-300" aria-label="완료" />;
  if (status === 'failed') return <CircleAlert className="mt-0.5 size-5 shrink-0 text-red-300" aria-label="실패" />;
  return <Clock3 className="mt-0.5 size-5 shrink-0 text-slate-500" aria-label="대기" />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

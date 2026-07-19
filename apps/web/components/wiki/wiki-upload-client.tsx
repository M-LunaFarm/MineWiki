'use client';

import Link from 'next/link';
import { ClipboardCopy, ImagePlus, Loader2, OctagonX } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  fetchWikiFileVersions,
  listWikiFiles,
  restoreWikiFileVersion,
  uploadWikiMedia,
  type UploadedFileMetadata,
  type WikiFileVersion,
} from '../../lib/wiki-api';
import {
  mergeWikiUploadSelection,
  runWikiUploadQueue,
  successfulWikiUploadMarkup,
  wikiUploadMetadataError,
} from '../../lib/wiki-upload-queue.mjs';
import { useAuth } from '../providers/auth-context';
import { WikiUploadQueueView, type WikiUploadQueueItem } from './wiki-upload-queue-view';

interface WikiUploadClientProps {
  readonly spaceId: string;
}

export function WikiUploadClient({ spaceId }: WikiUploadClientProps) {
  const { account, loading: authLoading } = useAuth();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const queueRef = useRef<WikiUploadQueueItem[]>([]);
  const continueRef = useRef(true);
  const [queue, setQueue] = useState<WikiUploadQueueItem[]>([]);
  const [license, setLicense] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState('');
  const [replaceFileId, setReplaceFileId] = useState('');
  const [replaceableFiles, setReplaceableFiles] = useState<UploadedFileMetadata[]>([]);
  const [versions, setVersions] = useState<WikiFileVersion[]>([]);
  const sourceRequired = Boolean(license && license !== 'self-created');
  const queuedCount = queue.filter((item) => item.status === 'queued').length;
  const successCount = queue.filter((item) => item.status === 'success').length;

  useEffect(() => {
    if (!account) return;
    void listWikiFiles({ limit: 100 }).then((files) => {
      setReplaceableFiles(files.filter((file) =>
        file.ownerAccountId === account.id
        && file.status === 'active'
        && file.linkedResourceType === 'wiki_space'
        && file.linkedResourceId === spaceId));
    }).catch(() => setReplaceableFiles([]));
  }, [account, spaceId]);

  useEffect(() => {
    if (!replaceFileId) {
      setVersions([]);
      return;
    }
    void fetchWikiFileVersions(replaceFileId).then(setVersions).catch((error) => {
      setVersions([]);
      setMessage(error instanceof Error ? error.message : '버전 이력을 불러오지 못했습니다.');
    });
  }, [replaceFileId]);

  function replaceQueue(next: WikiUploadQueueItem[]) {
    queueRef.current = next;
    setQueue(next);
  }

  function patchQueueItem(id: string, patch: Partial<WikiUploadQueueItem>) {
    const next = queueRef.current.map((item) => item.id === id ? { ...item, ...patch } : item);
    replaceQueue(next);
    const current = next.find((item) => item.id === id);
    if (current) setProgress(`${current.file.name}: ${statusLabel(current.status)}`);
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    const merged = mergeWikiUploadSelection(queueRef.current, selected) as {
      items: WikiUploadQueueItem[];
      rejected: string[];
    };
    replaceQueue(merged.items);
    setMessage(merged.rejected.length > 0 ? merged.rejected.join('\n') : null);
    event.currentTarget.value = '';
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const metadataError = wikiUploadMetadataError({ queuedCount, license, sourceUrl });
    if (metadataError) {
      setMessage(metadataError);
      return;
    }
    await uploadItems(queueRef.current);
  }

  async function uploadItems(items: readonly WikiUploadQueueItem[]) {
    if (replaceFileId && items.length !== 1) {
      setMessage('기존 파일 교체는 한 번에 한 파일만 선택할 수 있습니다.');
      return;
    }
    setUploading(true);
    setMessage(null);
    continueRef.current = true;
    const run = await runWikiUploadQueue(
      items,
      async (item: WikiUploadQueueItem) => uploadWikiMedia({
        data: await readFileAsDataUrl(item.file),
        filename: item.file.name,
        spaceId,
        license,
        sourceUrl: sourceUrl.trim() || undefined,
        sourceText: sourceText.trim() || undefined,
        replaceFileId: replaceFileId || undefined,
      }),
      (id: string, patch: Partial<WikiUploadQueueItem>) => patchQueueItem(id, patch),
      () => continueRef.current,
    );
    setUploading(false);
    const failed = queueRef.current.filter((item) => item.status === 'failed').length;
    const succeeded = queueRef.current.filter((item) => item.status === 'success').length;
    const replaced = replaceFileId
      ? queueRef.current.find((item) => item.status === 'success')?.result
      : null;
    if (replaced?.id) {
      setReplaceFileId(replaced.id);
      setVersions(await fetchWikiFileVersions(replaced.id));
    }
    setProgress(run.stopped
      ? `업로드를 중단했습니다. ${succeeded}개 완료, 나머지는 대기 중입니다.`
      : `${succeeded}개 업로드 완료${failed > 0 ? `, ${failed}개 실패` : ''}`);
  }

  async function restoreVersion(version: WikiFileVersion) {
    const current = versions.find((item) => item.isCurrent);
    if (!current || !replaceFileId || version.isCurrent) return;
    if (!window.confirm(`파일 버전 ${version.versionNo}의 실제 파일로 복원할까요? 복원 작업도 새 버전으로 기록됩니다.`)) return;
    setUploading(true);
    setMessage(null);
    try {
      await restoreWikiFileVersion({
        fileId: replaceFileId,
        versionId: version.id,
        expectedCurrentVersionNo: current.versionNo,
      });
      setVersions(await fetchWikiFileVersions(replaceFileId));
      setProgress(`파일 버전 ${version.versionNo}을 새 현재 버전으로 복원했습니다.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '파일 버전을 복원하지 못했습니다.');
    } finally {
      setUploading(false);
    }
  }

  async function retryItem(id: string) {
    const metadataError = wikiUploadMetadataError({ queuedCount: 1, license, sourceUrl });
    if (metadataError) {
      setMessage(metadataError);
      return;
    }
    const current = queueRef.current.find((item) => item.id === id && item.status === 'failed');
    if (!current) return;
    const queued = { ...current, status: 'queued' as const, error: null, result: null };
    replaceQueue(queueRef.current.map((item) => item.id === id ? queued : item));
    await uploadItems([queued]);
  }

  function removeItem(id: string) {
    replaceQueue(queueRef.current.filter((item) => item.id !== id));
  }

  async function copySuccessfulMarkup() {
    const markup = successfulWikiUploadMarkup(queueRef.current);
    if (!markup) return;
    try {
      await navigator.clipboard.writeText(markup);
      setProgress(`성공한 파일 ${successCount}개의 삽입 문법을 복사했습니다.`);
    } catch {
      setMessage('클립보드에 복사하지 못했습니다. 각 파일의 삽입 문법을 직접 복사해 주세요.');
    }
  }

  if (authLoading) return <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 계정을 확인하는 중입니다.</p>;
  if (!account) return <div className="surface-flat p-5 text-sm text-slate-300">파일 업로드는 위키 계정이 필요합니다. <Link href="/login?returnTo=%2Fwiki%2Fupload" className="font-semibold text-emerald-300 hover:underline">로그인</Link></div>;

  return (
    <form onSubmit={submit} className="surface-flat space-y-5 p-5">
      <label className="grid gap-2 text-sm font-semibold text-slate-200">
        업로드 방식
        <select value={replaceFileId} onChange={(event) => { setReplaceFileId(event.target.value); replaceQueue([]); }} disabled={uploading} className="min-h-11 rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-200">
          <option value="">새 파일 등록</option>
          {replaceableFiles.map((file) => <option key={file.id} value={file.id}>기존 파일 교체 · {file.wikiFilename}</option>)}
        </select>
        <span className="text-xs font-normal text-slate-500">교체 시 논리 파일명은 유지되고 이전 바이트와 리비전은 버전 이력에 보존됩니다.</span>
      </label>
      {versions.length > 0 ? (
        <section className="rounded-lg border border-white/10 bg-black/15 p-4" aria-label="파일 버전 이력">
          <h2 className="text-sm font-semibold text-white">버전 이력</h2>
          <ul className="mt-3 space-y-2">
            {versions.map((version) => (
              <li key={version.id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-white/10 px-3 py-2 text-xs text-slate-300">
                <span>v{version.versionNo} · {(version.size / 1024).toFixed(1)} KiB · {new Date(version.createdAt).toLocaleString('ko-KR')}</span>
                {version.isCurrent ? <strong className="text-emerald-300">현재</strong> : <button type="button" disabled={uploading} onClick={() => void restoreVersion(version)} className="btn-secondary min-h-9 px-3">이 버전 복원</button>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <label className="grid gap-2 text-sm font-semibold text-slate-200">
        이미지 또는 동영상 <span className="text-xs font-normal text-slate-500">PNG, JPEG, WebP, MP4, WebM · 동영상 1080p/5분 이하 · {replaceFileId ? '교체 파일 1개' : '최대 10개'} · 합계 20MiB</span>
        <input ref={fileInput} type="file" multiple={!replaceFileId} accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" onChange={selectFiles} disabled={uploading || queue.length >= (replaceFileId ? 1 : 10)} className="min-h-11 rounded-lg border border-white/10 bg-[#0d1219] px-3 py-2 text-sm text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-emerald-300 file:px-3 file:py-1.5 file:font-semibold file:text-slate-950 disabled:opacity-50" />
      </label>
      <WikiUploadQueueView items={queue} busy={uploading} onRemove={removeItem} onRetry={(id) => void retryItem(id)} />
      <UploadAttribution license={license} sourceUrl={sourceUrl} sourceText={sourceText} sourceRequired={sourceRequired} disabled={uploading} onLicense={setLicense} onSourceUrl={setSourceUrl} onSourceText={setSourceText} />
      {message ? <p role="alert" className="whitespace-pre-line rounded-lg border border-red-300/20 bg-red-300/[0.06] px-4 py-3 text-sm text-red-100">{message}</p> : null}
      <p role="status" aria-live="polite" className="sr-only">{progress}</p>
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={uploading || queuedCount === 0} className="btn-primary min-h-11 disabled:opacity-50">
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
          {uploading ? '직렬 업로드 중' : `${queuedCount}개 업로드`}
        </button>
        {uploading ? <button type="button" onClick={() => { continueRef.current = false; setProgress('현재 파일 이후 업로드 중단을 요청했습니다.'); }} className="btn-secondary min-h-11"><OctagonX className="size-4" /> 현재 파일 후 중단</button> : null}
        {successCount > 0 ? <button type="button" disabled={uploading} onClick={() => void copySuccessfulMarkup()} className="btn-secondary min-h-11 disabled:opacity-50"><ClipboardCopy className="size-4" /> 성공 {successCount}개 문법 복사</button> : null}
      </div>
    </form>
  );
}

function UploadAttribution(props: {
  readonly license: string;
  readonly sourceUrl: string;
  readonly sourceText: string;
  readonly sourceRequired: boolean;
  readonly disabled: boolean;
  readonly onLicense: (value: string) => void;
  readonly onSourceUrl: (value: string) => void;
  readonly onSourceText: (value: string) => void;
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-2 text-sm font-semibold text-slate-200">
          라이선스
          <select value={props.license} onChange={(event) => props.onLicense(event.target.value)} required disabled={props.disabled} className="min-h-11 rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-200">
            <option value="">선택하세요</option>
            {LICENSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="grid gap-2 text-sm font-semibold text-slate-200">
          원본 출처 URL <span className="text-xs font-normal text-slate-500">{props.sourceRequired ? '필수' : '선택'}</span>
          <input type="url" value={props.sourceUrl} onChange={(event) => props.onSourceUrl(event.target.value)} required={props.sourceRequired} disabled={props.disabled} placeholder="https://..." className="min-h-11 rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-300/50" />
        </label>
      </div>
      <label className="grid gap-2 text-sm font-semibold text-slate-200">
        제작자·출처 표기 <span className="text-xs font-normal text-slate-500">선택, 최대 255자</span>
        <input value={props.sourceText} maxLength={255} onChange={(event) => props.onSourceText(event.target.value)} disabled={props.disabled} placeholder="예: Mojang Studios / 공식 위키" className="min-h-11 rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-300/50" />
      </label>
    </>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('파일을 읽지 못했습니다.'));
    reader.onerror = () => reject(reader.error ?? new Error('파일을 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });
}

function statusLabel(status: WikiUploadQueueItem['status']): string {
  return ({ queued: '대기 중', uploading: '업로드 중', success: '완료', failed: '실패' })[status];
}

const LICENSES = [
  { value: 'self-created', label: '직접 제작' }, { value: 'cc-by-4.0', label: 'CC BY 4.0' },
  { value: 'cc-by-sa-4.0', label: 'CC BY-SA 4.0' }, { value: 'cc0-1.0', label: 'CC0 1.0' },
  { value: 'public-domain', label: '퍼블릭 도메인' }, { value: 'fair-use', label: '공정 이용' },
  { value: 'permission-granted', label: '권리자 이용 허락' },
] as const;

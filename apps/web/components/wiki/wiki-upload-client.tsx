'use client';

import Link from 'next/link';
import { CheckCircle2, ImagePlus, Loader2 } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { uploadWikiImage } from '../../lib/wiki-api';
import { useAuth } from '../providers/auth-context';

interface WikiUploadClientProps {
  readonly spaceId: string;
}

interface UploadResult {
  readonly filename: string;
  readonly wikiDocumentPath: string | null;
}

export function WikiUploadClient({ spaceId }: WikiUploadClientProps) {
  const { account, loading: authLoading } = useAuth();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [license, setLicense] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const sourceRequired = Boolean(license && license !== 'self-created');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file || !license) {
      setMessage('이미지와 라이선스를 모두 선택해 주세요.');
      return;
    }
    if (!file.type.startsWith('image/')) {
      setMessage('PNG, JPEG, WebP 이미지 파일만 업로드할 수 있습니다.');
      return;
    }
    if (sourceRequired && !sourceUrl.trim()) {
      setMessage('직접 제작하지 않은 파일은 원본 출처 URL이 필요합니다.');
      return;
    }
    setUploading(true);
    setMessage(null);
    setResult(null);
    try {
      const uploaded = await uploadWikiImage({
        data: await readFileAsDataUrl(file),
        filename: file.name,
        spaceId,
        license,
        sourceUrl: sourceUrl.trim() || undefined,
        sourceText: sourceText.trim() || undefined,
      });
      setResult(uploaded);
      if (fileInput.current) fileInput.current.value = '';
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '파일을 업로드하지 못했습니다.');
    } finally {
      setUploading(false);
    }
  }

  if (authLoading) {
    return <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 계정을 확인하는 중입니다.</p>;
  }
  if (!account) {
    return (
      <div className="surface-flat p-5 text-sm text-slate-300">
        파일 업로드는 위키 계정이 필요합니다. <Link href="/login?returnTo=%2Fwiki%2Fupload" className="font-semibold text-emerald-300 hover:underline">로그인</Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="surface-flat space-y-5 p-5">
      <label className="grid gap-2 text-sm font-semibold text-slate-200">
        이미지 파일 <span className="text-xs font-normal text-slate-500">PNG, JPEG, WebP</span>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" required className="min-h-11 rounded-lg border border-white/10 bg-[#0d1219] px-3 py-2 text-sm text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-emerald-300 file:px-3 file:py-1.5 file:font-semibold file:text-slate-950" />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-2 text-sm font-semibold text-slate-200">
          라이선스
          <select value={license} onChange={(event) => setLicense(event.target.value)} required className="min-h-11 rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-200">
            <option value="">선택하세요</option>
            {LICENSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="grid gap-2 text-sm font-semibold text-slate-200">
          원본 출처 URL <span className="text-xs font-normal text-slate-500">{sourceRequired ? '필수' : '선택'}</span>
          <input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} required={sourceRequired} placeholder="https://..." className="min-h-11 rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-300/50" />
        </label>
      </div>
      <label className="grid gap-2 text-sm font-semibold text-slate-200">
        제작자·출처 표기 <span className="text-xs font-normal text-slate-500">선택, 최대 255자</span>
        <input value={sourceText} maxLength={255} onChange={(event) => setSourceText(event.target.value)} placeholder="예: Mojang Studios / 공식 위키" className="min-h-11 rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-300/50" />
      </label>
      {message ? <p role="alert" className="rounded-lg border border-red-300/20 bg-red-300/[0.06] px-4 py-3 text-sm text-red-100">{message}</p> : null}
      {result ? <UploadSuccess result={result} /> : null}
      <button type="submit" disabled={uploading} className="btn-primary min-h-11 disabled:opacity-50">
        {uploading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
        {uploading ? '업로드 중' : '파일 업로드'}
      </button>
    </form>
  );
}

function UploadSuccess({ result }: { readonly result: UploadResult }) {
  return (
    <div role="status" className="rounded-lg border border-emerald-300/25 bg-emerald-300/[0.06] px-4 py-3 text-sm text-emerald-100">
      <p className="flex items-center gap-2 font-semibold"><CheckCircle2 className="size-4" /> 업로드와 파일 문서 생성이 완료되었습니다.</p>
      <p className="mt-2 font-mono text-xs text-emerald-200">{`[[파일:${result.filename}]]`}</p>
      {result.wikiDocumentPath ? <Link href={result.wikiDocumentPath} className="mt-2 inline-block font-semibold underline underline-offset-4">파일 문서 열기</Link> : null}
    </div>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('파일을 읽지 못했습니다.'));
    reader.onerror = () => reject(reader.error ?? new Error('파일을 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });
}

const LICENSES = [
  { value: 'self-created', label: '직접 제작' },
  { value: 'cc-by-4.0', label: 'CC BY 4.0' },
  { value: 'cc-by-sa-4.0', label: 'CC BY-SA 4.0' },
  { value: 'cc0-1.0', label: 'CC0 1.0' },
  { value: 'public-domain', label: '퍼블릭 도메인' },
  { value: 'fair-use', label: '공정 이용' },
  { value: 'permission-granted', label: '권리자 이용 허락' },
] as const;

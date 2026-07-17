'use client';

import { ImageUp, Loader2, Save } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ServerDetail } from '@minewiki/schemas';
import { csrfHeaders } from '../../lib/csrf';

interface ServerProfileSettingsProps {
  readonly serverId: string;
  readonly baseUrl: string;
  readonly initial: Pick<
    ServerDetail,
    | 'name'
    | 'tags'
    | 'shortDescription'
    | 'longDescription'
    | 'websiteUrl'
    | 'discordUrl'
    | 'bannerUrl'
  >;
}

type Feedback = { readonly tone: 'success' | 'error'; readonly message: string };

export function ServerProfileSettings({
  serverId,
  baseUrl,
  initial,
}: ServerProfileSettingsProps) {
  const router = useRouter();
  const bannerInput = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(initial.name);
  const [tags, setTags] = useState(initial.tags.join(', '));
  const [shortDescription, setShortDescription] = useState(initial.shortDescription);
  const [longDescription, setLongDescription] = useState(initial.longDescription);
  const [websiteUrl, setWebsiteUrl] = useState(initial.websiteUrl ?? '');
  const [discordUrl, setDiscordUrl] = useState(initial.discordUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${serverId}/profile`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({
          name,
          tags: parseTags(tags),
          shortDescription,
          longDescription,
          websiteUrl: websiteUrl.trim() || null,
          discordUrl: discordUrl.trim() || null,
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response, '서버 정보를 저장하지 못했습니다.'));
      setFeedback({ tone: 'success', message: '서버 소개와 링크를 저장했습니다.' });
      router.refresh();
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : '서버 정보를 저장하지 못했습니다.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function uploadBanner() {
    const file = bannerInput.current?.files?.[0];
    if (!file) {
      setFeedback({ tone: 'error', message: '배너 이미지를 선택해 주세요.' });
      return;
    }
    if (!file.type.startsWith('image/')) {
      setFeedback({ tone: 'error', message: '이미지 파일만 배너로 사용할 수 있습니다.' });
      return;
    }
    setUploadingBanner(true);
    setFeedback(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${serverId}/banner`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({ data: await readFileAsDataUrl(file) }),
      });
      if (!response.ok) throw new Error(await responseMessage(response, '배너를 저장하지 못했습니다.'));
      setFeedback({ tone: 'success', message: '서버 배너를 저장했습니다.' });
      if (bannerInput.current) bannerInput.current.value = '';
      router.refresh();
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : '배너를 저장하지 못했습니다.',
      });
    } finally {
      setUploadingBanner(false);
    }
  }

  return (
    <section className="mt-5 rounded-lg border border-[#2a2a2d] bg-[#1c1c1f] p-5">
      <h4 className="text-base font-semibold text-white">서버 정보</h4>
      <p className="mt-2 text-xs leading-5 text-slate-400">
        랭킹 상세의 소개 본문과 서버 위키 헤더에 반영됩니다. 접속 주소 변경은 검증 상태를 보호하기 위해 별도 지원 절차를 사용합니다.
      </p>
      <form onSubmit={saveProfile} className="mt-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="서버 이름">
            <input value={name} onChange={(event) => setName(event.target.value)} minLength={3} maxLength={32} required className={INPUT_CLASS} />
          </Field>
          <Field label="태그" help="쉼표로 구분, 최대 12개">
            <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="survival, economy" className={INPUT_CLASS} />
          </Field>
        </div>
        <Field label="한 줄 소개" help={`${shortDescription.length}/160`}>
          <input value={shortDescription} onChange={(event) => setShortDescription(event.target.value)} maxLength={160} required className={INPUT_CLASS} />
        </Field>
        <Field label="상세 소개" help={`${longDescription.length}/20000`}>
          <textarea value={longDescription} onChange={(event) => setLongDescription(event.target.value)} maxLength={20_000} required rows={8} className={`${INPUT_CLASS} resize-y py-3`} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="웹사이트" help="선택">
            <input type="url" value={websiteUrl} onChange={(event) => setWebsiteUrl(event.target.value)} placeholder="https://..." className={INPUT_CLASS} />
          </Field>
          <Field label="Discord 초대" help="선택">
            <input type="url" value={discordUrl} onChange={(event) => setDiscordUrl(event.target.value)} placeholder="https://discord.gg/..." className={INPUT_CLASS} />
          </Field>
        </div>
        <button type="submit" disabled={saving} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-[#13ec80] px-5 text-sm font-semibold text-slate-950 disabled:opacity-60">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          {saving ? '저장 중…' : '서버 정보 저장'}
        </button>
      </form>
      <div className="mt-5 border-t border-[#2a2a2d] pt-5">
        <p className="text-sm font-semibold text-white">배너 이미지</p>
        <p className="mt-1 text-xs text-slate-400">가로형 이미지를 권장합니다. 현재 배너: {initial.bannerUrl ? '등록됨' : '없음'}</p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <input ref={bannerInput} type="file" accept="image/png,image/jpeg,image/webp" className="min-h-11 min-w-0 flex-1 rounded-lg border border-[#2a2a2d] bg-[#141416] px-3 py-2 text-xs text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-slate-700 file:px-3 file:py-1.5 file:text-slate-100" />
          <button type="button" onClick={() => void uploadBanner()} disabled={uploadingBanner} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-[#13ec80]/30 bg-[#13ec80]/10 px-5 text-sm font-semibold text-[#13ec80] disabled:opacity-60">
            {uploadingBanner ? <Loader2 className="size-4 animate-spin" /> : <ImageUp className="size-4" />}
            {uploadingBanner ? '업로드 중…' : '배너 저장'}
          </button>
        </div>
      </div>
      {feedback ? <p role="status" className={`mt-4 text-sm ${feedback.tone === 'success' ? 'text-emerald-300' : 'text-red-300'}`}>{feedback.message}</p> : null}
    </section>
  );
}

function Field({ label, help, children }: { readonly label: string; readonly help?: string; readonly children: ReactNode }) {
  return <label className="grid gap-2 text-xs font-semibold text-slate-300"><span>{label} {help ? <span className="font-normal text-slate-500">· {help}</span> : null}</span>{children}</label>;
}

function parseTags(value: string): string[] {
  return [...new Set(value.split(',').map((tag) => tag.trim()).filter(Boolean))].slice(0, 12);
}

async function responseMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({}));
  return typeof body?.message === 'string' ? body.message : fallback;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('배너 파일을 읽지 못했습니다.'));
    reader.onerror = () => reject(reader.error ?? new Error('배너 파일을 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });
}

const INPUT_CLASS = 'min-h-11 w-full rounded-lg border border-[#2a2a2d] bg-[#141416] px-3 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-[#13ec80]/50';

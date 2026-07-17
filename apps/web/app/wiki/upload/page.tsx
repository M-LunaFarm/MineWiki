import { notFound } from 'next/navigation';
import { WikiUploadClient } from '../../../components/wiki/wiki-upload-client';
import { fetchWikiPageByPath } from '../../../lib/wiki-server-api';

interface WikiUploadPageProps {
  readonly searchParams: Promise<{ readonly spaceId?: string }>;
}

export default async function WikiUploadPage({ searchParams }: WikiUploadPageProps) {
  const requestedSpaceId = (await searchParams).spaceId?.trim();
  const mainPage = await fetchWikiPageByPath('/wiki');
  if (!mainPage) notFound();
  const spaceId = requestedSpaceId && /^\d+$/u.test(requestedSpaceId)
    ? requestedSpaceId
    : mainPage.spaceId;

  return (
    <section className="mx-auto w-full max-w-3xl space-y-7 px-4 py-10 sm:px-6 lg:px-0">
      <header className="border-b border-white/10 pb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">Wiki File</p>
        <h1 className="mt-3 text-3xl font-bold text-white">파일 업로드</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          기존 문서를 먼저 만들지 않아도 이미지를 위키에 등록할 수 있습니다.
          업로드가 끝나면 출처와 라이선스를 보존하는 파일 문서와 삽입 문법을 함께 제공합니다.
        </p>
      </header>
      <aside className="grid gap-3 sm:grid-cols-3" aria-label="업로드 처리 단계">
        <UploadStep number="1" title="이미지 선택" text="PNG, JPEG, WebP 파일" />
        <UploadStep number="2" title="권리 정보" text="라이선스와 원본 출처" />
        <UploadStep number="3" title="문서 생성" text="파일 문서와 삽입 문법" />
      </aside>
      <WikiUploadClient spaceId={spaceId} />
    </section>
  );
}

function UploadStep(props: {
  readonly number: string;
  readonly title: string;
  readonly text: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
      <span className="text-xs font-bold text-emerald-300">{props.number}</span>
      <p className="mt-2 text-sm font-semibold text-white">{props.title}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{props.text}</p>
    </div>
  );
}

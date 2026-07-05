'use client';

import type { ChangeEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Bold,
  Code2,
  Eye,
  Heading2,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  Loader2,
  PencilLine,
  Quote,
} from 'lucide-react';
import {
  extractMarkdownImageUrls,
  renderSafeMarkdown,
  stripMarkdownImages,
} from '../../lib/markdown';

const MAX_EDITOR_IMAGE_SIZE_BYTES = 2 * 1024 * 1024;

type EditorTab = 'write' | 'preview';

interface ServerDescriptionEditorProps {
  readonly value: string;
  readonly onChange: (nextValue: string) => void;
  readonly apiBaseUrl: string;
  readonly disabled?: boolean;
}

interface UploadState {
  readonly uploading: boolean;
  readonly error: string | null;
}

export function ServerDescriptionEditor({
  value,
  onChange,
  apiBaseUrl,
  disabled = false,
}: ServerDescriptionEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const valueRef = useRef(value);
  const [tab, setTab] = useState<EditorTab>('write');
  const [uploadState, setUploadState] = useState<UploadState>({
    uploading: false,
    error: null,
  });

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const previewHtml = useMemo(() => {
    const markdownWithoutImages = stripMarkdownImages(value);
    const markdown = markdownWithoutImages || value;
    return markdown ? renderSafeMarkdown(markdown) : '';
  }, [value]);

  const galleryImages = useMemo(() => extractMarkdownImageUrls(value), [value]);

  const updateValueWithSelection = useCallback(
    (
      nextValue: string,
      selection?: {
        readonly start: number;
        readonly end: number;
      },
    ) => {
      valueRef.current = nextValue;
      onChange(nextValue);
      if (!selection) {
        return;
      }
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(selection.start, selection.end);
      });
    },
    [onChange],
  );

  const insertBlock = useCallback(
    (block: string) => {
      const textarea = textareaRef.current;
      const currentValue = valueRef.current;
      if (!textarea) {
        const prefix = currentValue.length > 0 && !currentValue.endsWith('\n') ? '\n' : '';
        updateValueWithSelection(`${currentValue}${prefix}${block}\n`);
        return;
      }

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = currentValue.slice(0, start);
      const after = currentValue.slice(end);
      const prefix = before.endsWith('\n') || before.length === 0 ? '' : '\n';
      const suffix = after.startsWith('\n') || after.length === 0 ? '' : '\n';
      const replacement = `${prefix}${block}${suffix}`;
      const nextValue = `${before}${replacement}${after}`;
      const cursor = before.length + replacement.length;
      updateValueWithSelection(nextValue, { start: cursor, end: cursor });
    },
    [updateValueWithSelection],
  );

  const wrapSelection = useCallback(
    (prefix: string, suffix: string, placeholder: string) => {
      const textarea = textareaRef.current;
      const currentValue = valueRef.current;
      if (!textarea) {
        const base =
          currentValue.length > 0 && !currentValue.endsWith('\n')
            ? `${currentValue}\n`
            : currentValue;
        updateValueWithSelection(`${base}${prefix}${placeholder}${suffix}`);
        return;
      }

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const selected = currentValue.slice(start, end) || placeholder;
      const replacement = `${prefix}${selected}${suffix}`;
      const nextValue = `${currentValue.slice(0, start)}${replacement}${currentValue.slice(end)}`;
      const selectionStart = start + prefix.length;
      const selectionEnd = selectionStart + selected.length;
      updateValueWithSelection(nextValue, { start: selectionStart, end: selectionEnd });
    },
    [updateValueWithSelection],
  );

  const handleLinkInsert = useCallback(() => {
    if (disabled) {
      return;
    }
    const entered = window.prompt('링크 URL을 입력하세요.', 'https://');
    if (!entered) {
      return;
    }
    const url = entered.trim();
    if (!/^https?:\/\//i.test(url)) {
      setUploadState((current) => ({
        ...current,
        error: '링크는 http:// 또는 https://로 시작해야 합니다.',
      }));
      return;
    }
    setUploadState((current) => ({ ...current, error: null }));
    wrapSelection('[', `](${url})`, '링크 텍스트');
  }, [disabled, wrapSelection]);

  const handleImageSelect = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) {
        return;
      }
      if (!file.type.startsWith('image/')) {
        setUploadState({ uploading: false, error: '이미지 파일만 업로드할 수 있습니다.' });
        return;
      }
      if (file.size > MAX_EDITOR_IMAGE_SIZE_BYTES) {
        setUploadState({
          uploading: false,
          error: '상세 설명 이미지는 2MB 이하의 파일만 업로드할 수 있습니다.',
        });
        return;
      }

      setUploadState({ uploading: true, error: null });
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const response = await fetch(`${apiBaseUrl}/v1/servers/assets/images`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            data: dataUrl,
            filename: file.name,
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body?.message ?? '상세 설명 이미지 업로드에 실패했습니다.');
        }

        const uploadedUrl =
          typeof body?.url === 'string'
            ? body.url
            : typeof body?.publicPath === 'string'
              ? body.publicPath
              : null;
        if (!uploadedUrl) {
          throw new Error('업로드된 이미지 URL을 확인할 수 없습니다.');
        }

        insertBlock(`![${normalizeAltText(file.name)}](${uploadedUrl})`);
        setUploadState({ uploading: false, error: null });
        setTab('write');
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : '상세 설명 이미지 업로드 중 오류가 발생했습니다.';
        setUploadState({ uploading: false, error: message });
      }
    },
    [apiBaseUrl, insertBlock],
  );

  const handleTextareaChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    valueRef.current = nextValue;
    onChange(nextValue);
  };

  const toolbarDisabled = disabled || uploadState.uploading;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#333333] bg-[#121212] p-2">
        <ToolbarButton
          onClick={() => wrapSelection('**', '**', '굵은 텍스트')}
          disabled={toolbarDisabled}
          icon={<Bold className="h-3.5 w-3.5" aria-hidden="true" />}
          title="굵게"
        >
          굵게
        </ToolbarButton>
        <ToolbarButton
          onClick={() => wrapSelection('*', '*', '기울임 텍스트')}
          disabled={toolbarDisabled}
          icon={<Italic className="h-3.5 w-3.5" aria-hidden="true" />}
          title="기울임"
        >
          기울임
        </ToolbarButton>
        <ToolbarButton
          onClick={() => insertBlock('## 섹션 제목')}
          disabled={toolbarDisabled}
          icon={<Heading2 className="h-3.5 w-3.5" aria-hidden="true" />}
          title="제목"
        >
          제목
        </ToolbarButton>
        <ToolbarButton
          onClick={() => insertBlock('- 항목 1\n- 항목 2')}
          disabled={toolbarDisabled}
          icon={<List className="h-3.5 w-3.5" aria-hidden="true" />}
          title="목록"
        >
          목록
        </ToolbarButton>
        <ToolbarButton
          onClick={() => insertBlock('> 인용문')}
          disabled={toolbarDisabled}
          icon={<Quote className="h-3.5 w-3.5" aria-hidden="true" />}
          title="인용"
        >
          인용
        </ToolbarButton>
        <ToolbarButton
          onClick={() => wrapSelection('`', '`', '코드')}
          disabled={toolbarDisabled}
          icon={<Code2 className="h-3.5 w-3.5" aria-hidden="true" />}
          title="코드"
        >
          코드
        </ToolbarButton>
        <ToolbarButton
          onClick={handleLinkInsert}
          disabled={toolbarDisabled}
          icon={<LinkIcon className="h-3.5 w-3.5" aria-hidden="true" />}
          title="링크"
        >
          링크
        </ToolbarButton>
        <ToolbarButton
          onClick={() => fileInputRef.current?.click()}
          disabled={toolbarDisabled}
          icon={
            uploadState.uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
            )
          }
          title="이미지 업로드"
        >
          {uploadState.uploading ? '업로드 중' : '이미지'}
        </ToolbarButton>
      </div>

      <div className="overflow-hidden rounded-lg border border-[#333333] bg-[#121212]">
        <div className="flex items-center justify-between border-b border-[#2a2a2d] bg-[#161618] px-3 py-2">
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              className={`rounded-md px-2 py-1 font-semibold transition ${
                tab === 'write'
                  ? 'bg-[#13ec80]/20 text-[#13ec80]'
                  : 'text-[#9ca3af] hover:bg-white/5 hover:text-white'
              }`}
              onClick={() => setTab('write')}
            >
              <span className="inline-flex items-center gap-1.5">
                <PencilLine className="h-3.5 w-3.5" aria-hidden="true" />
                작성
              </span>
            </button>
            <button
              type="button"
              className={`rounded-md px-2 py-1 font-semibold transition ${
                tab === 'preview'
                  ? 'bg-[#13ec80]/20 text-[#13ec80]'
                  : 'text-[#9ca3af] hover:bg-white/5 hover:text-white'
              }`}
              onClick={() => setTab('preview')}
            >
              <span className="inline-flex items-center gap-1.5">
                <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                미리보기
              </span>
            </button>
          </div>
          <p className="text-[11px] text-[#6b7280]">{value.length}자 · 이미지 최대 2MB</p>
        </div>

        {tab === 'write' ? (
          <div className="relative">
            <textarea
              ref={textareaRef}
              className="h-72 w-full resize-y border-0 bg-transparent px-4 py-3 text-sm leading-6 text-white outline-none placeholder:text-[#5f666f] focus:ring-0"
              placeholder={
                '예시:\n## 서버 특징\n- 야생 중심 운영\n- 초보자 보호 구역 제공\n\n## 접속 전 안내\n규칙과 디스코드 공지를 확인해 주세요.'
              }
              value={value}
              onChange={handleTextareaChange}
              disabled={disabled}
            />
            {uploadState.uploading ? (
              <div className="absolute inset-x-4 bottom-4 flex items-center gap-2 rounded-lg border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-xs text-sky-200">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                이미지를 업로드한 뒤 본문에 삽입합니다.
              </div>
            ) : null}
          </div>
        ) : (
          <div className="min-h-72 space-y-5 px-4 py-3">
            {previewHtml ? (
              <div
                className="prose prose-invert max-w-none space-y-3 text-[14px] leading-relaxed text-[#d1d5db]"
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            ) : (
              <div className="flex min-h-52 items-center justify-center rounded-lg border border-dashed border-[#333333] bg-[#0e0e10] px-4 text-center">
                <div>
                  <Eye className="mx-auto h-5 w-5 text-[#6b7280]" aria-hidden="true" />
                  <p className="mt-2 text-sm font-semibold text-[#9ca3af]">
                    미리볼 내용이 없습니다
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[#6b7280]">
                    작성 탭에서 서버 특징, 규칙, 시작 방법을 입력하면 이곳에 렌더링됩니다.
                  </p>
                </div>
              </div>
            )}
            {galleryImages.length > 0 ? (
              <div>
                <p className="mb-2 text-xs font-semibold text-[#9ca3af]">
                  문서에 포함된 이미지 ({galleryImages.length})
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {galleryImages.map((imageUrl, index) => (
                    <a
                      key={`${imageUrl}-${index}`}
                      href={imageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="overflow-hidden rounded border border-[#2a2a2d] bg-[#0e0e10]"
                    >
                      <img
                        src={imageUrl}
                        alt={`상세 설명 이미지 ${index + 1}`}
                        className="h-24 w-full object-cover"
                        loading="lazy"
                      />
                    </a>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={handleImageSelect}
      />

      {uploadState.error ? (
        <p className="flex items-start gap-1.5 text-xs text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {uploadState.error}
        </p>
      ) : null}
      <p className="text-xs leading-5 text-[#A0A0A0]">
        이미지 업로드 후 Markdown 이미지 문법이 자동 삽입됩니다. 운영 규칙, 시즌 정보, 보상 안내를
        섹션으로 나누면 읽기 쉽습니다.
      </p>
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  disabled,
  icon,
  title,
}: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled: boolean;
  readonly icon: ReactNode;
  readonly title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1.5 rounded-md border border-[#333333] bg-[#161618] px-2.5 py-1.5 text-xs font-semibold text-[#c4c7ce] transition hover:border-[#13ec80]/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
    >
      {icon}
      {children}
    </button>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : null;
      if (!result) {
        reject(new Error('이미지 파일을 읽을 수 없습니다.'));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => {
      reject(new Error('이미지 파일을 읽는 중 오류가 발생했습니다.'));
    };
    reader.readAsDataURL(file);
  });
}

function normalizeAltText(filename: string): string {
  const trimmed = filename.trim();
  const withoutExtension = trimmed.replace(/\.[^.]+$/, '').trim();
  if (!withoutExtension) {
    return '업로드 이미지';
  }
  return withoutExtension.slice(0, 80);
}

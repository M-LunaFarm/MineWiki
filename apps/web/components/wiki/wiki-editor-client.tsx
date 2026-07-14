'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { buildCategoryWikiToolPath, buildServerWikiToolPath } from '../../lib/wiki-routes.mjs';
import { AlertTriangle, Eye, FileImage, ImagePlus, LayoutTemplate, Loader2, Save } from 'lucide-react';
import { type ChangeEvent, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useAuth } from '../providers/auth-context';
import {
  fetchWikiRevision,
  fetchWikiSection,
  createWikiEditRequest,
  listWikiFiles,
  listWikiDocumentTemplates,
  previewWikiMarkup,
  saveWikiPage,
  saveWikiSection,
  uploadWikiImage,
  type UploadedFileMetadata,
  type WikiDocumentTemplateSummary,
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [contentRaw, setContentRaw] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [isMinor, setIsMinor] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [blockingErrors, setBlockingErrors] = useState<string[]>([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [fileSearch, setFileSearch] = useState('');
  const [wikiFiles, setWikiFiles] = useState<UploadedFileMetadata[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [fileLicense, setFileLicense] = useState('');
  const [fileSourceUrl, setFileSourceUrl] = useState('');
  const [fileSourceText, setFileSourceText] = useState('');
  const [templates, setTemplates] = useState<WikiDocumentTemplateSummary[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [loadingRevision, setLoadingRevision] = useState(Boolean(page));
  const [sectionAnchor, setSectionAnchor] = useState<string | null | undefined>(undefined);
  const [sectionTitle, setSectionTitle] = useState<string | null>(null);
  const [baseRevisionId, setBaseRevisionId] = useState<string | undefined>(page?.revision.id);
  const [previewing, startPreviewTransition] = useTransition();
  const [saving, startSaveTransition] = useTransition();
  const fileSourceRequired = Boolean(fileLicense && fileLicense !== 'self-created');
  const canUploadImage = Boolean(page && fileLicense && (!fileSourceRequired || fileSourceUrl.trim()));

  const heading = page
    ? sectionAnchor
      ? `${sectionTitle ?? page.displayTitle} 섹션 편집`
      : `${page.displayTitle} 편집`
    : `${title} 새 문서 작성`;
  const editorPath = routePath.startsWith('/server/')
    ? buildServerWikiToolPath(routePath, 'edit')
    : routePath.startsWith('/wiki/category/')
      ? buildCategoryWikiToolPath(routePath, 'edit')
      : `${routePath}/edit`;
  const loginReturnTo = sectionAnchor ? `${editorPath}?section=${encodeURIComponent(sectionAnchor)}` : editorPath;
  const loginHref = `/login?returnTo=${encodeURIComponent(loginReturnTo)}`;

  useEffect(() => {
    const anchor = new URLSearchParams(window.location.search).get('section')?.trim();
    setSectionAnchor(anchor || null);
  }, [page?.id]);

  useEffect(() => {
    let cancelled = false;
    async function loadRevision() {
      if (sectionAnchor === undefined) return;
      if (!page) {
        setContentRaw('');
        setLoadingRevision(false);
        return;
      }
      if (sectionAnchor && !account) {
        setLoadingRevision(false);
        return;
      }
      try {
        setLoadingRevision(true);
        if (sectionAnchor) {
          const section = await fetchWikiSection(page.id, sectionAnchor);
          if (!cancelled) {
            setContentRaw(section.contentRaw);
            setSectionTitle(section.title);
            setBaseRevisionId(section.baseRevisionId);
          }
        } else {
          const revision = await fetchWikiRevision(page.revision.id);
          if (!cancelled) {
            setContentRaw(revision.contentRaw);
            setSectionTitle(null);
            setBaseRevisionId(revision.id);
          }
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
  }, [account, page, sectionAnchor]);

  useEffect(() => {
    if (!account || page) return;
    let cancelled = false;
    setLoadingTemplates(true);
    listWikiDocumentTemplates()
      .then((items) => {
        if (cancelled) return;
        setTemplates(items);
        setSelectedTemplateId(items[0]?.id ?? '');
      })
      .catch((error) => {
        if (!cancelled) setFeedback(error instanceof Error ? error.message : '문서 양식을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!cancelled) setLoadingTemplates(false);
      });
    return () => { cancelled = true; };
  }, [account, page]);

  const canSubmit = useMemo(() => {
    return Boolean(account && contentRaw.trim() && editSummary.trim() && !loadingRevision && blockingErrors.length === 0);
  }, [account, contentRaw, editSummary, loadingRevision, blockingErrors.length]);

  function renderPreview() {
    setFeedback(null);
    setBlockingErrors([]);
    startPreviewTransition(async () => {
      try {
        const preview = await previewWikiMarkup(contentRaw);
        setPreviewHtml(preview.html);
        setBlockingErrors(preview.blockingErrors);
        if (preview.blockingErrors.length > 0) {
          setFeedback(null);
        } else if (preview.errors.length > 0) {
          setFeedback(preview.errors.join('\n'));
        }
      } catch (error) {
        setFeedback(error instanceof Error ? error.message : '미리보기를 생성하지 못했습니다.');
      }
    });
  }

  function submit() {
    if (!canSubmit) {
      setFeedback(blockingErrors.length > 0 ? null : '본문과 편집 요약을 입력해야 합니다.');
      return;
    }
    setFeedback(null);
    startSaveTransition(async () => {
      try {
        if (sectionAnchor && page && baseRevisionId) {
          const result = await saveWikiSection({
            pageId: page.id,
            anchor: sectionAnchor,
            contentRaw,
            editSummary,
            isMinor,
            baseRevisionId
          });
          router.push(`${routePath}#${encodeURIComponent(result.sectionAnchor)}`);
        } else {
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
        }
        router.refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : '저장하지 못했습니다.';
        setFeedback(`${message} 충돌이 발생했다면 최신 리비전을 다시 불러온 뒤 재시도하세요.`);
      }
    });
  }

  function applyTemplate() {
    const template = templates.find((item) => item.id === selectedTemplateId);
    if (!template) return;
    if (contentRaw.trim() && !window.confirm('작성 중인 본문을 선택한 문서 양식으로 바꿀까요?')) return;
    let next = template.contentRaw.replaceAll('{{문서명}}', title);
    if (template.defaultCategory && !next.includes(`[[분류:${template.defaultCategory}`)) {
      next = `${next.trimEnd()}\n\n[[분류:${template.defaultCategory}]]\n`;
    }
    setContentRaw(next);
    setEditSummary((current) => current || `${template.title}으로 초안 작성`);
    setBlockingErrors([]);
    setFeedback(`${template.title}을 적용했습니다. 저장 전에 내용을 확인하세요.`);
  }

  function submitForReview() {
    if (!account || !page || !baseRevisionId || !contentRaw.trim() || !editSummary.trim()) {
      setFeedback('기존 문서의 본문과 편집 요약을 입력해야 편집 요청을 보낼 수 있습니다.');
      return;
    }
    setFeedback(null);
    startSaveTransition(async () => {
      try {
        await createWikiEditRequest({ pageId: page.id, baseRevisionId, contentRaw, editSummary, isMinor });
        setFeedback('편집 요청을 제출했습니다. 문서 관리자가 검토하면 실제 리비전으로 반영됩니다.');
      } catch (error) {
        setFeedback(error instanceof Error ? error.message : '편집 요청을 제출하지 못했습니다.');
      }
    });
  }

  async function loadWikiFiles(search = fileSearch) {
    setLoadingFiles(true);
    setFeedback(null);
    try {
      const files = await listWikiFiles({ search, limit: 40 });
      setWikiFiles(files);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '파일 목록을 불러오지 못했습니다.');
    } finally {
      setLoadingFiles(false);
    }
  }

  function insertFileMarkup(filename: string, caption?: string | null) {
    const cleanCaption = caption?.trim() || filename;
    setContentRaw((current) => `${current}${current.endsWith('\n') || !current ? '' : '\n'}[[파일:${filename}|섬네일|${cleanCaption}]]\n`);
    setFilePickerOpen(false);
    setBlockingErrors([]);
  }

  async function handleImageSelect(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    if (!page) {
      setFeedback('새 문서를 먼저 저장한 뒤 파일을 업로드해 주세요. 파일은 저장된 문서의 ACL에 연결됩니다.');
      return;
    }
    if (!fileLicense) {
      setFeedback('파일의 라이선스를 선택해 주세요.');
      return;
    }
    if (fileSourceRequired && !fileSourceUrl.trim()) {
      setFeedback('직접 제작하지 않은 파일은 원본 출처 URL이 필요합니다.');
      return;
    }
    if (!file.type.startsWith('image/')) {
      setFeedback('이미지 파일만 업로드할 수 있습니다.');
      return;
    }
    setUploadingImage(true);
    setFeedback(null);
    try {
      const data = await readFileAsDataUrl(file);
      const uploaded = await uploadWikiImage({
        data,
        filename: file.name,
        pageId: page.id,
        license: fileLicense,
        sourceUrl: fileSourceUrl.trim() || undefined,
        sourceText: fileSourceText.trim() || undefined,
      });
      const alt = normalizeAltText(file.name);
      setContentRaw((current) => `${current}${current.endsWith('\n') || !current ? '' : '\n'}[[파일:${uploaded.filename}|섬네일|${alt}]]\n`);
      setBlockingErrors([]);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '이미지 업로드 중 오류가 발생했습니다.');
    } finally {
      setUploadingImage(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-4xl items-center justify-center px-4">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-300" />
      </div>
    );
  }

  if (!account) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-3xl flex-col justify-center px-4 py-12">
        <div className="surface-flat p-6">
          <h1 className="text-2xl font-bold text-white">로그인이 필요합니다</h1>
          <p className="mt-3 text-sm text-slate-300">문서 편집은 MineWiki 계정으로 로그인한 사용자만 사용할 수 있습니다.</p>
          <Link href={loginHref} className="btn-primary mt-5 h-10">
            로그인
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
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
        {sectionAnchor ? <p className="mt-2 text-sm font-medium text-emerald-300">선택한 섹션만 수정하며 나머지 문서는 그대로 유지됩니다.</p> : null}
      </header>

      {feedback ? (
        <div className="flex gap-3 rounded-lg border border-amber-300/25 bg-amber-500/10 p-4 text-sm text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <p className="whitespace-pre-wrap">{feedback}</p>
        </div>
      ) : null}
      {blockingErrors.length > 0 ? (
        <div className="flex gap-3 rounded-lg border border-red-300/30 bg-red-500/10 p-4 text-sm text-red-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <p className="whitespace-pre-wrap">{blockingErrors.join('\n')}</p>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="space-y-4">
          <textarea
            aria-label={sectionAnchor ? '위키 섹션 본문' : '위키 문서 본문'}
            value={contentRaw}
            onChange={(event) => {
              setContentRaw(event.target.value);
              setBlockingErrors([]);
            }}
            disabled={loadingRevision || saving}
            className="min-h-[520px] w-full resize-y rounded-lg border border-white/10 bg-[#0d1219] p-4 font-mono text-sm leading-6 text-slate-100 outline-none transition focus:border-emerald-300/50"
            spellCheck={false}
          />
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
            <input
              aria-label="편집 요약"
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
              disabled={!canSubmit || saving || uploadingImage}
              className="btn-primary h-10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              저장
            </button>
          </div>
          {page && !sectionAnchor ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.025] p-4">
              <p className="max-w-2xl text-xs leading-5 text-slate-400">직접 편집 권한이 없거나 관리자의 검토가 필요한 변경은 편집 요청으로 제출할 수 있습니다.</p>
              <button type="button" onClick={submitForReview} disabled={saving || loadingRevision || !contentRaw.trim() || !editSummary.trim()} className="btn-secondary h-10 disabled:opacity-50">검토 요청</button>
            </div>
          ) : null}
          <section className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
            <h2 className="text-sm font-semibold text-white">파일 저작권·출처</h2>
            <p className="mt-2 text-xs leading-5 text-slate-400">업로드 파일은 이 문서의 <code>upload_file</code> ACL을 따릅니다. 라이선스와 출처는 파일이 표시되는 모든 문서에 함께 노출됩니다.</p>
            {page ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1.5 text-xs font-semibold text-slate-300">
                  라이선스 <span className="text-red-300">필수</span>
                  <select value={fileLicense} onChange={(event) => setFileLicense(event.target.value)} className="h-10 rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-100" aria-label="파일 라이선스">
                    <option value="">선택하세요</option>
                    {WIKI_FILE_LICENSES.map((license) => <option key={license.value} value={license.value}>{license.label}</option>)}
                  </select>
                </label>
                <label className="grid gap-1.5 text-xs font-semibold text-slate-300">
                  원본 출처 URL {fileSourceRequired ? <span className="text-red-300">필수</span> : <span className="text-slate-500">선택</span>}
                  <input type="url" value={fileSourceUrl} onChange={(event) => setFileSourceUrl(event.target.value)} placeholder="https://..." className="h-10 rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-emerald-300/50" />
                </label>
                <label className="grid gap-1.5 text-xs font-semibold text-slate-300 sm:col-span-2">
                  제작자·출처 표기 <span className="text-slate-500">선택</span>
                  <input value={fileSourceText} maxLength={255} onChange={(event) => setFileSourceText(event.target.value)} placeholder="예: Mojang Studios / 공식 위키" className="h-10 rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-emerald-300/50" />
                </label>
              </div>
            ) : <p className="mt-4 rounded-md border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2 text-xs text-amber-100">새 문서를 먼저 저장해야 파일을 문서 ACL에 안전하게 연결할 수 있습니다.</p>}
          </section>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="inline-flex h-9 items-center gap-2 rounded-md border border-white/10 px-3 text-xs font-semibold text-slate-200 hover:border-emerald-300/40 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => fileInputRef.current?.click()}
              disabled={!canUploadImage || uploadingImage || saving || loadingRevision}
            >
              {uploadingImage ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
              이미지
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(event) => void handleImageSelect(event)}
            />
            <button
              type="button"
              className="inline-flex h-9 items-center gap-2 rounded-md border border-white/10 px-3 text-xs font-semibold text-slate-200 hover:border-emerald-300/40 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => {
                const nextOpen = !filePickerOpen;
                setFilePickerOpen(nextOpen);
                if (nextOpen && wikiFiles.length === 0) {
                  void loadWikiFiles();
                }
              }}
              disabled={saving || loadingRevision}
            >
              <FileImage className="h-3.5 w-3.5" />
              파일
            </button>
          </div>
          {filePickerOpen ? (
            <section className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  value={fileSearch}
                  onChange={(event) => setFileSearch(event.target.value)}
                  placeholder="파일명 검색"
                  className="h-9 flex-1 rounded-md border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-emerald-300/50"
                />
                <button
                  type="button"
                  onClick={() => void loadWikiFiles(fileSearch)}
                  disabled={loadingFiles}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-white/10 px-3 text-xs font-semibold text-slate-200 hover:border-emerald-300/40 disabled:opacity-50"
                >
                  {loadingFiles ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
                  검색
                </button>
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {wikiFiles.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    onClick={() => insertFileMarkup(file.filename, file.originalName)}
                    className="flex min-h-16 items-center gap-3 rounded-md border border-white/10 bg-[#0d1219] p-3 text-left text-sm text-slate-200 hover:border-emerald-300/40"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-md bg-white/[0.05] text-emerald-200">
                      <FileImage className="h-5 w-5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-white">{file.originalName ?? file.filename}</span>
                      <span className="block truncate text-xs text-slate-500">{file.filename}</span>
                      {file.license ? <span className="mt-1 block truncate text-[11px] text-emerald-300">{wikiFileLicenseLabel(file.license)}{file.sourceText ? ` · ${file.sourceText}` : ''}</span> : null}
                    </span>
                  </button>
                ))}
              </div>
              {!loadingFiles && wikiFiles.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">사용 가능한 위키 파일이 없습니다.</p>
              ) : null}
            </section>
          ) : null}
        </section>

        <aside className="space-y-4">
          {!page ? (
            <section className="surface-flat p-4">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-white"><LayoutTemplate className="size-4 text-emerald-300" /> 문서 양식</h2>
              <p className="mt-2 text-xs leading-5 text-slate-500">빈 문서에서 검증된 기본 구조로 시작합니다.</p>
              {loadingTemplates ? <p className="mt-4 flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> 불러오는 중</p> : templates.length > 0 ? (
                <div className="mt-4 space-y-3">
                  <select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)} className="h-11 w-full rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-white" aria-label="문서 양식 선택">
                    {templates.map((template) => <option key={template.id} value={template.id}>{template.title}</option>)}
                  </select>
                  <p className="min-h-10 text-xs leading-5 text-slate-400">{templates.find((template) => template.id === selectedTemplateId)?.description ?? '기본 문서 양식'}</p>
                  <button type="button" onClick={applyTemplate} disabled={!selectedTemplateId || saving} className="btn-secondary h-11 w-full">양식 적용</button>
                </div>
              ) : <p className="mt-4 text-sm text-slate-500">사용 가능한 문서 양식이 없습니다.</p>}
            </section>
          ) : null}
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
                <dd>최신 판과 다르면 저장 차단</dd>
              </div>
              {sectionAnchor ? <div className="flex justify-between gap-4"><dt className="text-slate-500">편집 범위</dt><dd className="text-right">{sectionTitle ?? sectionAnchor}</dd></div> : null}
            </dl>
          </section>

          <section className="surface-flat p-4">
            <h2 className="text-sm font-semibold text-white">포함 문서</h2>
            <p className="mt-2 text-xs leading-5 text-slate-400">반복하는 안내를 틀 문서로 나누고, 저장된 문서에서 불러올 수 있습니다.</p>
            <code className="mt-3 block overflow-x-auto rounded-md border border-white/10 bg-[#0d1219] px-3 py-2 text-xs text-emerald-200">
              {'[include(틀:안내,이름=값)]'}
            </code>
            <p className="mt-3 text-xs leading-5 text-slate-500">틀의 <code>@이름@</code> 또는 <code>@이름=기본값@</code>이 전달한 값으로 표시됩니다. 미리보기에서는 포함 본문을 해석하지 않으며, 저장 후 읽기 권한이 있는 틀만 표시됩니다.</p>
            <div className="mt-4 border-t border-white/10 pt-4">
              <p className="text-xs font-semibold text-slate-300">본문 목차</p>
              <code className="mt-2 block rounded-md border border-white/10 bg-[#0d1219] px-3 py-2 text-xs text-emerald-200">{'[목차]  또는  [목차(hide)]'}</code>
            </div>
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
    </div>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('파일을 읽지 못했습니다.'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('파일을 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });
}

function normalizeAltText(filename: string): string {
  return filename.trim().replace(/\.[^.]+$/u, '').replace(/[|[\]]/g, '').slice(0, 80) || 'image';
}

const WIKI_FILE_LICENSES = [
  { value: 'self-created', label: '직접 제작' },
  { value: 'cc-by-4.0', label: 'CC BY 4.0' },
  { value: 'cc-by-sa-4.0', label: 'CC BY-SA 4.0' },
  { value: 'cc0-1.0', label: 'CC0 1.0' },
  { value: 'public-domain', label: '퍼블릭 도메인' },
  { value: 'fair-use', label: '공정 이용' },
  { value: 'permission-granted', label: '권리자 이용 허락' },
] as const;

function wikiFileLicenseLabel(value: string): string {
  return WIKI_FILE_LICENSES.find((item) => item.value === value)?.label ?? value;
}

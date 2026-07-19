'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { buildCategoryWikiToolPath, buildServerWikiToolPath, buildStandardWikiToolPath } from '../../lib/wiki-routes.mjs';
import { buildWikiFileMarkup } from '../../lib/wiki-file-markup.mjs';
import { buildWikiEditorDraftKey, readWikiEditorDraft, removeWikiEditorDraft, writeWikiEditorDraft } from '../../lib/wiki-editor-draft.mjs';
import { applyWikiEditorFormat, wikiEditorShortcutAction } from '../../lib/wiki-editor-formatting.mjs';
import { AlertTriangle, Eye, FileImage, ImagePlus, LayoutTemplate, Loader2, Save } from 'lucide-react';
import { type ChangeEvent, type KeyboardEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useAuth } from '../providers/auth-context';
import { CaptchaChallenge, isCaptchaConfigured } from '../security/captcha-challenge';
import { WikiEditorLoadError } from './wiki-editor-load-error';
import { WikiEditorToolbar, type WikiEditorFormatAction } from './wiki-editor-toolbar';
import {
  fetchWikiRevision,
  fetchWikiSection,
  fetchWikiCreateContext,
  createWikiEditRequest,
  createWikiPageRequest,
  listWikiFiles,
  listWikiDocumentTemplates,
  previewWikiMarkup,
  saveWikiPage,
  saveWikiSection,
  uploadWikiImage,
  type UploadedFileMetadata,
  type WikiEditConflictDetails,
  type WikiDocumentTemplateSummary,
  type WikiCreateContext,
  WikiApiError,
  type ServerWikiPresentation,
  type WikiPageResponse,
  type WikiPolicyAcceptance,
} from '../../lib/wiki-api';

interface WikiEditorClientProps {
  readonly page: WikiPageResponse | null;
  readonly namespace: string;
  readonly title: string;
  readonly createSpaceId: string | null;
  readonly routePath: string;
  readonly presentation: ServerWikiPresentation | null;
  readonly presentationLoadFailed: boolean;
}

interface WikiEditorDraft {
  readonly baseRevisionId: string | null;
  readonly contentRaw: string;
  readonly editSummary: string;
  readonly isMinor: boolean;
  readonly savedAt: number;
}

export function WikiEditorClient({ page, namespace, title, createSpaceId, routePath, presentation, presentationLoadFailed }: WikiEditorClientProps) {
  const router = useRouter();
  const { account, loading } = useAuth();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftSourceTokenRef = useRef('');
  const loadedSourceTokenRef = useRef('');
  const sourceSnapshotRef = useRef({ contentRaw: '', editSummary: '', isMinor: false });
  const [contentRaw, setContentRaw] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [isMinor, setIsMinor] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [submittedRequestId, setSubmittedRequestId] = useState<string | null>(null);
  const [blockingErrors, setBlockingErrors] = useState<string[]>([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [fileSearch, setFileSearch] = useState('');
  const [wikiFiles, setWikiFiles] = useState<UploadedFileMetadata[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [fileDisplayWidth, setFileDisplayWidth] = useState('');
  const [fileDisplayAlign, setFileDisplayAlign] = useState('normal');
  const [fileDisplayFit, setFileDisplayFit] = useState('contain');
  const [fileDisplayAlt, setFileDisplayAlt] = useState('');
  const [fileLicense, setFileLicense] = useState('');
  const [fileSourceUrl, setFileSourceUrl] = useState('');
  const [fileSourceText, setFileSourceText] = useState('');
  const [templates, setTemplates] = useState<WikiDocumentTemplateSummary[]>([]);
  const [createContext, setCreateContext] = useState<WikiCreateContext | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [loadingRevision, setLoadingRevision] = useState(Boolean(page));
  const [sourceReady, setSourceReady] = useState(false);
  const [sourceLoadError, setSourceLoadError] = useState<string | null>(null);
  const [sourceReloadKey, setSourceReloadKey] = useState(0);
  const [sectionAnchor, setSectionAnchor] = useState<string | null | undefined>(undefined);
  const [sectionTitle, setSectionTitle] = useState<string | null>(null);
  const [baseRevisionId, setBaseRevisionId] = useState<string | undefined>(page?.revision.id);
  const [baseRevisionNo, setBaseRevisionNo] = useState<number | undefined>(page?.revision.revisionNo);
  const [editConflict, setEditConflict] = useState<WikiEditConflictDetails | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<WikiEditorDraft | null>(null);
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saved' | 'unavailable'>('idle');
  const [previewing, startPreviewTransition] = useTransition();
  const [saving, startSaveTransition] = useTransition();
  const fileSourceRequired = Boolean(fileLicense && fileLicense !== 'self-created');
  const uploadSpaceId = page ? null : createContext?.spaceId ?? null;
  const canUploadImage = Boolean(account && (page || uploadSpaceId) && fileLicense && (!fileSourceRequired || fileSourceUrl.trim()));
  const hasUnresolvedConflict = containsWikiConflictMarkers(contentRaw);
  const anonymousReviewEnabled = Boolean(
    !account
    && page
    && sectionAnchor === null
    && process.env.NEXT_PUBLIC_WIKI_ANONYMOUS_EDIT_REQUESTS_ENABLED === 'true'
    && isCaptchaConfigured()
  );
  const needsCaptcha = Boolean((!page || anonymousReviewEnabled) && isCaptchaConfigured());
  const policyRequired = Boolean(presentation?.policy.required && presentation.policy.html);
  const policyReady = !presentationLoadFailed && (!policyRequired || policyAccepted);
  const policyAcceptance: WikiPolicyAcceptance | undefined = policyRequired && policyAccepted && presentation
    ? { version: presentation.policy.version, accepted: true }
    : undefined;

  const applyEditorFormat = useCallback((action: WikiEditorFormatAction) => {
    const textarea = textareaRef.current;
    const result = applyWikiEditorFormat({
      value: contentRaw,
      selectionStart: textarea?.selectionStart ?? contentRaw.length,
      selectionEnd: textarea?.selectionEnd ?? contentRaw.length,
    }, action);
    setContentRaw(result.value);
    setBlockingErrors([]);
    requestAnimationFrame(() => {
      const current = textareaRef.current;
      if (!current) return;
      current.focus();
      current.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  }, [contentRaw]);

  const handleEditorKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = wikiEditorShortcutAction(event);
    if (!action) return;
    event.preventDefault();
    applyEditorFormat(action as WikiEditorFormatAction);
  }, [applyEditorFormat]);

  useEffect(() => {
    setPolicyAccepted(false);
  }, [presentation?.policy.version]);

  const heading = page
    ? sectionAnchor
      ? `${sectionTitle ?? page.displayTitle} 섹션 편집`
      : `${page.displayTitle} 편집`
    : `${title} 새 문서 작성`;
  const editorPath = routePath.startsWith('/server/') || routePath.startsWith('/serverWiki/')
    ? buildServerWikiToolPath(routePath, 'edit')
    : routePath.startsWith('/wiki/category/')
      ? buildCategoryWikiToolPath(routePath, 'edit')
      : buildStandardWikiToolPath(routePath, 'edit');
  const loginReturnTo = sectionAnchor ? `${editorPath}?section=${encodeURIComponent(sectionAnchor)}` : editorPath;
  const loginHref = `/login?returnTo=${encodeURIComponent(loginReturnTo)}`;
  const accountId = account?.id;
  const draftContext = useMemo(() => accountId && sectionAnchor !== undefined
    ? { accountId, routePath, sectionAnchor: sectionAnchor ?? '' }
    : null, [accountId, routePath, sectionAnchor]);
  const draftKey = useMemo(() => draftContext ? buildWikiEditorDraftKey(draftContext) : null, [draftContext]);
  const draftSourceToken = draftKey ? `${draftKey}:${page?.revision.id ?? 'new'}` : null;

  useEffect(() => {
    const anchor = new URLSearchParams(window.location.search).get('section')?.trim();
    setSectionAnchor(anchor || null);
  }, [page?.id]);

  useEffect(() => {
    let cancelled = false;
    async function loadRevision() {
      if (sectionAnchor === undefined) return;
      setSourceReady(false);
      setSourceLoadError(null);
      loadedSourceTokenRef.current = '';
      if (!page) {
        setContentRaw('');
        setLoadingRevision(false);
        loadedSourceTokenRef.current = draftSourceToken ?? '';
        setSourceReady(true);
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
            setBaseRevisionNo(page.revision.revisionNo);
            setEditConflict(null);
            loadedSourceTokenRef.current = draftSourceToken ?? '';
            setSourceReady(true);
          }
        } else {
          const revision = await fetchWikiRevision(page.revision.id);
          if (!cancelled) {
            setContentRaw(revision.contentRaw);
            setSectionTitle(null);
            setBaseRevisionId(revision.id);
            setBaseRevisionNo(revision.revisionNo);
            setEditConflict(null);
            loadedSourceTokenRef.current = draftSourceToken ?? '';
            setSourceReady(true);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setSourceLoadError(error instanceof Error ? error.message : '리비전을 불러오지 못했습니다.');
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
  }, [account, draftSourceToken, page, sectionAnchor, sourceReloadKey]);

  useEffect(() => {
    if (!sourceReady || !draftContext || !draftKey || !draftSourceToken || loadedSourceTokenRef.current !== draftSourceToken || draftSourceTokenRef.current === draftSourceToken) return;
    draftSourceTokenRef.current = draftSourceToken;
    sourceSnapshotRef.current = { contentRaw, editSummary: '', isMinor: false };
    const draft = readWikiEditorDraft(window.localStorage, draftKey, draftContext) as WikiEditorDraft | null;
    if (draft && (draft.contentRaw !== contentRaw || draft.editSummary || draft.isMinor)) {
      setPendingDraft(draft);
      setDraftStatus('saved');
    } else {
      setPendingDraft(null);
      setDraftStatus('idle');
    }
  }, [contentRaw, draftContext, draftKey, draftSourceToken, sourceReady]);

  useEffect(() => {
    if (!sourceReady || !draftContext || !draftKey || draftSourceTokenRef.current !== draftSourceToken || pendingDraft) return;
    const source = sourceSnapshotRef.current;
    const dirty = contentRaw !== source.contentRaw || editSummary !== source.editSummary || isMinor !== source.isMinor;
    if (!dirty) {
      removeWikiEditorDraft(window.localStorage, draftKey);
      setDraftStatus('idle');
      return;
    }
    const timer = window.setTimeout(() => {
      const saved = writeWikiEditorDraft(window.localStorage, draftKey, draftContext, {
        baseRevisionId, contentRaw, editSummary, isMinor
      });
      setDraftStatus(saved ? 'saved' : 'unavailable');
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [baseRevisionId, contentRaw, draftContext, draftKey, draftSourceToken, editSummary, isMinor, pendingDraft, sourceReady]);

  useEffect(() => {
    const source = sourceSnapshotRef.current;
    const dirty = sourceReady && (contentRaw !== source.contentRaw || editSummary !== source.editSummary || isMinor !== source.isMinor);
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [contentRaw, editSummary, isMinor, sourceReady]);

  useEffect(() => {
    if (!account || page) {
      setCreateContext(null);
      return;
    }
    let cancelled = false;
    fetchWikiCreateContext({ namespace, title, spaceId: createSpaceId ?? undefined })
      .then((context) => { if (!cancelled) setCreateContext(context); })
      .catch((error) => {
        if (!cancelled) setFeedback(error instanceof Error ? error.message : '새 문서 공간을 확인하지 못했습니다.');
      });
    return () => { cancelled = true; };
  }, [account, createSpaceId, namespace, page, title]);

  useEffect(() => {
    if (!account || page || !createContext) return;
    let cancelled = false;
    setLoadingTemplates(true);
    listWikiDocumentTemplates({ spaceId: createContext.spaceId })
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
  }, [account, createContext, page]);

  const canSubmit = useMemo(() => {
    return Boolean(account && (page || createContext) && sourceReady && contentRaw.trim() && editSummary.trim() && !loadingRevision && blockingErrors.length === 0 && !hasUnresolvedConflict && (!needsCaptcha || captchaToken) && policyReady);
  }, [account, page, createContext, sourceReady, contentRaw, editSummary, loadingRevision, blockingErrors.length, hasUnresolvedConflict, needsCaptcha, captchaToken, policyReady]);
  const saveBlocker = blockingErrors.length > 0
    ? '차단 오류를 먼저 해결해야 저장할 수 있습니다.'
    : !page && !createContext
      ? '새 문서가 속할 위키 공간과 작성 권한을 확인하고 있습니다.'
    : hasUnresolvedConflict
      ? '동시 편집 충돌 표시를 모두 정리해야 저장할 수 있습니다.'
      : !contentRaw.trim()
        ? '문서 본문을 입력해 주세요.'
        : !editSummary.trim()
          ? '편집 요약을 입력해 주세요.'
          : needsCaptcha && !captchaToken
            ? '로봇 방지 확인을 완료해 주세요.'
            : !policyReady
              ? '서버 위키 기여 정책을 확인해 주세요.'
              : null;

  function renderPreview() {
    setFeedback(null);
    setBlockingErrors([]);
    startPreviewTransition(async () => {
      try {
        const preview = await previewWikiMarkup(contentRaw, {
          pageId: page?.id,
          namespace,
          localPath: page?.slug ?? title,
        });
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
    if (!page && !createContext) {
      setFeedback('새 문서가 속할 위키 공간과 작성 권한을 확인한 뒤 다시 시도해 주세요.');
      return;
    }
    if (!page && !createContext?.canCreate) {
      setFeedback('이 공간에는 문서를 직접 만들 수 없습니다. 새 문서 검토 요청을 이용해 주세요.');
      return;
    }
    if (!canSubmit) {
      setFeedback(blockingErrors.length > 0 ? null : needsCaptcha && !captchaToken
        ? '새 문서를 만들기 전에 로봇 방지 확인을 완료해 주세요.'
        : !policyReady
          ? presentationLoadFailed
            ? '서버 위키 기여 정책을 불러오지 못해 저장을 중단했습니다. 새로고침 후 다시 시도해 주세요.'
            : '서버 위키 기여 정책을 확인하고 동의해 주세요.'
          : '본문과 편집 요약을 입력해야 합니다.');
      return;
    }
    setFeedback(null);
    startSaveTransition(async () => {
      try {
        if (sectionAnchor && !editConflict && page && baseRevisionId) {
          const result = await saveWikiSection({
            pageId: page.id,
            anchor: sectionAnchor,
            contentRaw,
            editSummary,
            isMinor,
            baseRevisionId,
            policyAcceptance,
          });
          router.push(`${routePath}#${encodeURIComponent(result.sectionAnchor)}`);
        } else {
          await saveWikiPage({
            pageId: page?.id,
            spaceId: page ? undefined : createContext?.spaceId,
            namespace,
            title,
            contentRaw,
            editSummary,
            isMinor,
            baseRevisionId,
            captchaToken: needsCaptcha ? captchaToken ?? undefined : undefined,
            policyAcceptance,
          });
          router.push(routePath);
        }
        if (draftKey) removeWikiEditorDraft(window.localStorage, draftKey);
        router.refresh();
      } catch (error) {
        if (needsCaptcha) { setCaptchaToken(null); setCaptchaKey((current) => current + 1); }
        const conflict = wikiEditConflict(error);
        if (conflict) {
          setContentRaw(conflict.mergedContentRaw);
          setBaseRevisionId(conflict.currentRevisionId);
          setBaseRevisionNo(conflict.currentRevisionNo);
          setEditConflict(conflict);
          setBlockingErrors([]);
          setFeedback(null);
          return;
        }
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
    if (!page && !createContext) {
      setFeedback('새 문서가 속할 위키 공간과 요청 권한을 확인한 뒤 다시 시도해 주세요.');
      return;
    }
    if (!page && !createContext?.canRequest) {
      setFeedback('이 공간에는 새 문서 검토 요청을 제출할 수 없습니다.');
      return;
    }
    if ((!account && !anonymousReviewEnabled) || !contentRaw.trim() || !editSummary.trim() || (page && !baseRevisionId)) {
      setFeedback('본문과 편집 요약을 입력해야 편집 요청을 보낼 수 있습니다.');
      return;
    }
    if (needsCaptcha && !captchaToken) {
      setFeedback('새 문서 요청을 보내기 전에 로봇 방지 확인을 완료해 주세요.');
      return;
    }
    if (!policyReady) {
      setFeedback(presentationLoadFailed
        ? '서버 위키 기여 정책을 불러오지 못해 요청을 중단했습니다. 새로고침 후 다시 시도해 주세요.'
        : '서버 위키 기여 정책을 확인하고 동의해 주세요.');
      return;
    }
    setFeedback(null);
    startSaveTransition(async () => {
      try {
        if (page && baseRevisionId) {
          const request = await createWikiEditRequest({
            pageId: page.id,
            baseRevisionId,
            contentRaw,
            editSummary,
            isMinor,
            captchaToken: anonymousReviewEnabled ? captchaToken ?? undefined : undefined,
            policyAcceptance,
          });
          setSubmittedRequestId(request.id);
        } else {
          await createWikiPageRequest({ namespace, title, spaceId: createContext?.spaceId, contentRaw, editSummary, isMinor, captchaToken: captchaToken ?? undefined, policyAcceptance });
        }
        if (draftKey) removeWikiEditorDraft(window.localStorage, draftKey);
        sourceSnapshotRef.current = { contentRaw, editSummary, isMinor };
        setDraftStatus('idle');
        setFeedback(page
          ? '편집 요청을 제출했습니다. 문서 관리자가 검토하면 실제 리비전으로 반영됩니다.'
          : '새 문서 작성 요청을 제출했습니다. 관리자가 승인하기 전까지 문서는 공개되지 않습니다.');
      } catch (error) {
        if (needsCaptcha) { setCaptchaToken(null); setCaptchaKey((current) => current + 1); }
        setFeedback(error instanceof Error ? error.message : '편집 요청을 제출하지 못했습니다.');
      }
    });
  }

  function restorePendingDraft() {
    if (!pendingDraft) return;
    setContentRaw(pendingDraft.contentRaw);
    setEditSummary(pendingDraft.editSummary);
    setIsMinor(pendingDraft.isMinor);
    setBlockingErrors([]);
    setPendingDraft(null);
    setDraftStatus('saved');
    setFeedback(pendingDraft.baseRevisionId && pendingDraft.baseRevisionId !== baseRevisionId
      ? '이전 리비전에서 작성한 초안을 복원했습니다. 저장할 때 최신 판과 안전하게 병합합니다.'
      : '브라우저에 저장된 초안을 복원했습니다.');
  }

  function discardPendingDraft() {
    if (draftKey) removeWikiEditorDraft(window.localStorage, draftKey);
    setPendingDraft(null);
    setDraftStatus('idle');
  }

  function confirmEditorNavigation(event: MouseEvent<HTMLAnchorElement>) {
    const source = sourceSnapshotRef.current;
    const dirty = contentRaw !== source.contentRaw || editSummary !== source.editSummary || isMinor !== source.isMinor;
    if (dirty && !window.confirm('저장하지 않은 편집 내용이 있습니다. 이 페이지를 나갈까요?')) {
      event.preventDefault();
    }
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
    const markup = buildWikiFileMarkup({
      filename, caption, width: fileDisplayWidth, align: fileDisplayAlign, objectFit: fileDisplayFit, alt: fileDisplayAlt
    });
    setContentRaw((current) => `${current}${current.endsWith('\n') || !current ? '' : '\n'}${markup}\n`);
    setFilePickerOpen(false);
    setBlockingErrors([]);
  }

  async function handleImageSelect(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    if (!page && !uploadSpaceId) {
      setFeedback('새 문서가 속할 위키 공간과 업로드 권한을 확인한 뒤 다시 시도해 주세요.');
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
        pageId: page?.id,
        spaceId: uploadSpaceId ?? undefined,
        license: fileLicense,
        sourceUrl: fileSourceUrl.trim() || undefined,
        sourceText: fileSourceText.trim() || undefined,
      });
      const alt = normalizeAltText(file.name);
      const markup = buildWikiFileMarkup({
        filename: uploaded.filename, caption: alt, width: fileDisplayWidth, align: fileDisplayAlign, objectFit: fileDisplayFit, alt: fileDisplayAlt
      });
      setContentRaw((current) => `${current}${current.endsWith('\n') || !current ? '' : '\n'}${markup}\n`);
      setBlockingErrors([]);
      setFeedback(uploaded.wikiDocumentPath
        ? `이미지를 삽입했습니다. 파일 문서: ${uploaded.wikiDocumentPath}`
        : '이미지를 삽입했습니다.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '이미지 업로드 중 오류가 발생했습니다.');
    } finally {
      setUploadingImage(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-4xl items-center justify-center gap-3 px-4 text-sm text-slate-300" role="status">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-300" />
        계정과 편집 권한을 확인하는 중입니다.
      </div>
    );
  }

  if (!account && !anonymousReviewEnabled) {
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

  if (sourceLoadError) {
    return (
      <WikiEditorLoadError
        title="편집 원문을 불러오지 못했습니다"
        message={`${sourceLoadError} 원문과 기준 리비전을 확인하기 전에는 편집하거나 저장할 수 없습니다.`}
        backHref={routePath}
        onRetry={() => setSourceReloadKey((current) => current + 1)}
      />
    );
  }

  if (!sourceReady || loadingRevision) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-4xl items-center justify-center gap-3 px-4 text-sm text-slate-300" role="status">
        <Loader2 className="size-5 animate-spin text-emerald-300" />
        편집 원문을 불러오는 중입니다.
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="border-b border-white/10 pb-5">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-slate-400">
          <Link href={routePath} onClick={confirmEditorNavigation} className="hover:text-emerald-200">
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
        <div className="flex gap-3 rounded-lg border border-amber-300/25 bg-amber-500/10 p-4 text-sm text-amber-100" role="status" aria-live="polite">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <div><p className="whitespace-pre-wrap">{feedback}</p>{submittedRequestId && page ? <Link className="mt-2 inline-flex font-semibold underline underline-offset-4" href={`/wiki/edit-requests/${page.id}?request=${submittedRequestId}&returnTo=${encodeURIComponent(routePath)}`}>내 요청 보기</Link> : null}</div>
        </div>
      ) : null}
      {blockingErrors.length > 0 ? (
        <div className="flex gap-3 rounded-lg border border-red-300/30 bg-red-500/10 p-4 text-sm text-red-100" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <p className="whitespace-pre-wrap">{blockingErrors.join('\n')}</p>
        </div>
      ) : null}

      {pendingDraft ? (
        <section className="flex flex-col gap-3 rounded-lg border border-sky-300/25 bg-sky-500/10 p-4 text-sm text-sky-50 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="wiki-saved-draft-title">
          <div>
            <p id="wiki-saved-draft-title" className="font-semibold" role="status" aria-live="polite">이 브라우저에 저장된 편집 초안이 있습니다.</p>
            <p className="mt-1 text-xs text-sky-100/75">{new Date(pendingDraft.savedAt).toLocaleString('ko-KR')} 저장 · 현재 원문을 바꾸기 전까지 자동 저장을 멈춥니다.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={restorePendingDraft} className="btn-primary min-h-11">초안 복원</button>
            <button type="button" onClick={discardPendingDraft} className="btn-secondary min-h-11">초안 삭제</button>
          </div>
        </section>
      ) : null}

      {presentationLoadFailed ? (
        <div className="flex gap-3 rounded-lg border border-red-300/30 bg-red-500/10 p-4 text-sm text-red-100" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <p>서버 위키의 편집 정책을 불러오지 못했습니다. 정책을 확인하지 않은 변경은 저장할 수 없습니다.</p>
        </div>
      ) : null}

      {presentation?.policy.html || presentation?.editHelpHtml ? (
        <section className="space-y-4 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.045] p-4 sm:p-5" aria-labelledby="server-wiki-policy-title">
          <div>
            <h2 id="server-wiki-policy-title" className="text-sm font-semibold text-white">이 서버 위키의 편집 안내</h2>
            <p className="mt-1 text-xs leading-5 text-slate-400">서버 운영진이 정한 기여 기준과 문서 작성 도움말입니다.</p>
          </div>
          {presentation.policy.html ? (
            <div className="wiki-rendered rounded-lg border border-white/10 bg-black/10 px-4 py-3 text-sm" dangerouslySetInnerHTML={{ __html: presentation.policy.html }} />
          ) : null}
          {presentation.editHelpHtml ? (
            <details className="rounded-lg border border-white/10 bg-black/10 px-4 py-3" open={!presentation.policy.html}>
              <summary className="cursor-pointer text-sm font-semibold text-emerald-200">편집 도움말</summary>
              <div className="wiki-rendered mt-3 text-sm" dangerouslySetInnerHTML={{ __html: presentation.editHelpHtml }} />
            </details>
          ) : null}
          {policyRequired ? (
            <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.07] px-4 py-3 text-sm text-slate-200">
              <input type="checkbox" checked={policyAccepted} onChange={(event) => setPolicyAccepted(event.target.checked)} className="mt-0.5 h-5 w-5 flex-none accent-emerald-400" />
              <span><strong className="text-white">기여 정책 v{presentation.policy.version}을 확인했습니다.</strong><span className="mt-1 block text-xs leading-5 text-slate-400">정책이 개정되면 최신 내용을 다시 확인해야 합니다.</span></span>
            </label>
          ) : null}
        </section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="space-y-4">
          {editConflict ? (
            <div className="rounded-lg border border-amber-300/30 bg-amber-500/10 p-4 text-sm text-amber-50" role="alert">
              <div className="flex gap-3">
                <AlertTriangle className="mt-0.5 size-4 flex-none" />
                <div className="min-w-0 space-y-2">
                  <p className="font-semibold">동시 편집 충돌 {editConflict.conflictCount}개를 확인해야 합니다.</p>
                  <p className="text-xs leading-5 text-amber-100/80">
                    초안은 유지했고 최신 #{editConflict.currentRevisionNo} 판과 함께 편집기에 표시했습니다. <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; 내 편집</code>, <code>=======</code>, <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt; 최신 판</code> 범위를 직접 정리하면 저장이 다시 활성화됩니다.
                  </p>
                  {editConflict.scope === 'section' ? <p className="text-xs font-medium text-amber-200">섹션 충돌 복구는 안전한 병합을 위해 전체 문서 원문으로 전환됩니다.</p> : null}
                  {!hasUnresolvedConflict ? <p className="text-xs font-semibold text-emerald-200">충돌 표시를 모두 정리했습니다. 편집 요약을 확인하고 저장하세요.</p> : null}
                </div>
              </div>
            </div>
          ) : null}
          <WikiEditorToolbar
            disabled={loadingRevision || saving}
            onApply={applyEditorFormat}
          />
          <textarea
            ref={textareaRef}
            aria-label={sectionAnchor ? '위키 섹션 본문' : '위키 문서 본문'}
            value={contentRaw}
            onChange={(event) => {
              setContentRaw(event.target.value);
              setBlockingErrors([]);
            }}
            onKeyDown={handleEditorKeyDown}
            disabled={loadingRevision || saving}
            className="min-h-[520px] w-full resize-y rounded-lg border border-white/10 bg-[#0d1219] p-4 font-mono text-sm leading-6 text-slate-100 outline-none transition focus:border-emerald-300/50"
            spellCheck={false}
          />
          <p className="min-h-5 text-xs text-slate-500" role="status" aria-live="polite">
            {draftStatus === 'saved' ? '이 브라우저에 초안을 자동 저장했습니다.' : draftStatus === 'unavailable' ? '브라우저 저장소를 사용할 수 없어 자동 저장하지 못했습니다.' : '내용을 수정하면 이 브라우저에 초안을 자동 저장합니다.'}
          </p>
          <section id="wiki-mobile-preview" className="surface-flat p-4 lg:hidden" aria-labelledby="wiki-mobile-preview-title">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 id="wiki-mobile-preview-title" className="text-sm font-semibold text-white">미리보기</h2>
                <p className="mt-1 text-xs text-slate-500">저장 전에 현재 본문이 어떻게 보이는지 확인합니다.</p>
              </div>
              <button
                type="button"
                onClick={renderPreview}
                disabled={previewing}
                className="inline-flex min-h-11 items-center gap-2 rounded-md border border-white/10 px-3 text-xs font-semibold text-slate-200 hover:border-emerald-300/40 disabled:opacity-50"
              >
                {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
                {previewHtml ? '새로고침' : '미리보기'}
              </button>
            </div>
            <div
              className="wiki-rendered max-h-[420px] overflow-auto p-4 text-sm"
              aria-live="polite"
              dangerouslySetInnerHTML={{ __html: previewHtml || '<p>미리보기를 생성하세요.</p>' }}
            />
          </section>
          {needsCaptcha ? <CaptchaChallenge resetKey={captchaKey} onTokenChange={setCaptchaToken} /> : null}
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
            <input
              aria-label="편집 요약"
              value={editSummary}
              onChange={(event) => setEditSummary(event.target.value)}
              maxLength={500}
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
            {account && (page || createContext?.canCreate) ? (
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit || saving || uploadingImage}
                aria-describedby="wiki-save-requirement"
                className="btn-primary h-10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                저장
              </button>
            ) : <span aria-hidden="true" />}
          </div>
          <p id="wiki-save-requirement" className={saveBlocker ? 'text-xs text-amber-200' : 'text-xs text-slate-500'} aria-live="polite">
            {saveBlocker ?? '본문과 편집 요약이 준비되었습니다.'}
          </p>
          {!sectionAnchor && (page || createContext?.canRequest) ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.025] p-4">
              <p className="max-w-2xl text-xs leading-5 text-slate-400">{anonymousReviewEnabled
                ? '로그인 없이 검토 요청만 제출됩니다. IP 주소는 악용 방지와 감사 목적으로만 제한 보관되며 공개 화면에는 표시되지 않습니다. 승인 전까지 문서는 변경되지 않습니다.'
                : page ? '직접 편집 권한이 없거나 관리자의 검토가 필요한 변경은 편집 요청으로 제출할 수 있습니다.' : '직접 생성할 수 없는 문서도 관리자가 검토하는 새 문서 요청으로 제출할 수 있습니다.'}</p>
              <button type="button" onClick={submitForReview} disabled={saving || loadingRevision || !contentRaw.trim() || !editSummary.trim() || (needsCaptcha && !captchaToken) || !policyReady} className="btn-secondary h-10 disabled:opacity-50">{page ? '검토 요청' : '새 문서 검토 요청'}</button>
            </div>
          ) : null}
          <section className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
            <h2 className="text-sm font-semibold text-white">파일 저작권·출처</h2>
            <p className="mt-2 text-xs leading-5 text-slate-400">업로드 파일은 이 문서의 <code>upload_file</code> ACL을 따릅니다. 라이선스와 출처는 파일이 표시되는 모든 문서에 함께 노출됩니다.</p>
            {page || uploadSpaceId ? (
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
            ) : <p className="mt-4 rounded-md border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2 text-xs text-amber-100">새 문서가 속할 위키 공간과 업로드 권한을 확인하고 있습니다.</p>}
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
              aria-expanded={filePickerOpen}
              aria-controls="wiki-file-picker"
              disabled={!account || saving || loadingRevision}
            >
              <FileImage className="h-3.5 w-3.5" />
              파일
            </button>
          </div>
          {filePickerOpen ? (
            <section id="wiki-file-picker" className="rounded-lg border border-white/10 bg-white/[0.03] p-4" aria-label="위키 파일 선택">
              <fieldset className="mb-4 grid gap-3 rounded-lg border border-white/10 bg-[#0d1219]/70 p-3 sm:grid-cols-2 lg:grid-cols-4">
                <legend className="px-1 text-xs font-semibold text-slate-300">파일 표시 설정</legend>
                <label className="grid gap-1.5 text-xs text-slate-400">
                  너비(px)
                  <input type="number" min={1} max={4096} value={fileDisplayWidth} onChange={(event) => setFileDisplayWidth(event.target.value)} placeholder="원본 크기" className="h-9 rounded-md border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-emerald-300/50" />
                </label>
                <label className="grid gap-1.5 text-xs text-slate-400">
                  정렬
                  <select value={fileDisplayAlign} onChange={(event) => setFileDisplayAlign(event.target.value)} className="h-9 rounded-md border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-100">
                    <option value="normal">기본</option><option value="left">왼쪽</option><option value="center">가운데</option><option value="right">오른쪽</option>
                  </select>
                </label>
                <label className="grid gap-1.5 text-xs text-slate-400">
                  이미지 맞춤
                  <select value={fileDisplayFit} onChange={(event) => setFileDisplayFit(event.target.value)} className="h-9 rounded-md border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-100">
                    <option value="contain">전체 표시</option><option value="cover">영역 채우기</option><option value="fill">늘려 채우기</option><option value="scale-down">자동 축소</option>
                  </select>
                </label>
                <label className="grid gap-1.5 text-xs text-slate-400">
                  대체 텍스트
                  <input value={fileDisplayAlt} maxLength={256} onChange={(event) => setFileDisplayAlt(event.target.value)} placeholder="비우면 캡션 사용" className="h-9 rounded-md border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-emerald-300/50" />
                </label>
              </fieldset>
              <form className="flex flex-col gap-3 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void loadWikiFiles(fileSearch); }} role="search">
                <input
                  value={fileSearch}
                  onChange={(event) => setFileSearch(event.target.value)}
                  placeholder="파일명 검색"
                  className="h-9 flex-1 rounded-md border border-white/10 bg-[#0d1219] px-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-emerald-300/50"
                />
                <button
                  type="submit"
                  disabled={loadingFiles}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-white/10 px-3 text-xs font-semibold text-slate-200 hover:border-emerald-300/40 disabled:opacity-50"
                >
                  {loadingFiles ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
                  검색
                </button>
              </form>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {wikiFiles.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    onClick={() => insertFileMarkup(file.wikiFilename ?? file.filename, file.originalName)}
                    className="flex min-h-16 items-center gap-3 rounded-md border border-white/10 bg-[#0d1219] p-3 text-left text-sm text-slate-200 hover:border-emerald-300/40"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-md bg-white/[0.05] text-emerald-200">
                      <FileImage className="h-5 w-5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-white">{file.originalName ?? file.wikiFilename ?? file.filename}</span>
                      <span className="block truncate text-xs text-slate-500">{file.wikiFilename ?? file.filename}</span>
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
                <dd>{baseRevisionId ? `#${baseRevisionNo ?? page?.revision.revisionNo}` : '새 문서'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">충돌 처리</dt>
                <dd>비중첩 수정은 자동 병합</dd>
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
            <p className="mt-3 text-xs leading-5 text-slate-500">틀의 <code>@이름@</code> 또는 <code>@이름=기본값@</code>이 전달한 값으로 표시됩니다. 미리보기와 저장된 문서 모두 현재 계정이 읽을 수 있는 틀만 본문에 펼칩니다.</p>
            <div className="mt-4 border-t border-white/10 pt-4">
              <p className="text-xs font-semibold text-slate-300">본문 목차</p>
              <code className="mt-2 block rounded-md border border-white/10 bg-[#0d1219] px-3 py-2 text-xs text-emerald-200">{'[목차]  또는  [목차(hide)]'}</code>
            </div>
            <div className="mt-4 border-t border-white/10 pt-4">
              <p className="text-xs font-semibold text-slate-300">수식</p>
              <code className="mt-2 block overflow-x-auto rounded-md border border-white/10 bg-[#0d1219] px-3 py-2 text-xs text-emerald-200">{'인라인: [math(x^2 + y^2)]'}</code>
              <code className="mt-2 block overflow-x-auto whitespace-pre rounded-md border border-white/10 bg-[#0d1219] px-3 py-2 text-xs text-emerald-200">{'블록: {{{#!latex\n\\frac{a}{b}\n}}}'}</code>
              <p className="mt-2 text-xs leading-5 text-slate-500">긴 블록 수식은 문서 폭을 늘리지 않고 수식 안에서만 가로로 스크롤됩니다.</p>
            </div>
          </section>

          <section className="surface-flat hidden p-4 lg:block">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-white">미리보기</h2>
              <button
                type="button"
                onClick={renderPreview}
                disabled={previewing}
                className="inline-flex h-8 items-center gap-2 rounded-md border border-white/10 px-3 text-xs font-semibold text-slate-200 hover:border-emerald-300/40"
              >
                {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
                {previewHtml ? '새로고침' : '미리보기'}
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

function wikiEditConflict(error: unknown): WikiEditConflictDetails | null {
  if (!(error instanceof WikiApiError) || error.code !== 'wiki_edit_conflict') return null;
  const details = error.details;
  if (!details || typeof details !== 'object') return null;
  const candidate = details as Partial<WikiEditConflictDetails>;
  if (
    candidate.type !== 'wiki_edit_conflict' ||
    (candidate.scope !== 'page' && candidate.scope !== 'section') ||
    typeof candidate.baseRevisionId !== 'string' ||
    typeof candidate.currentRevisionId !== 'string' ||
    typeof candidate.currentRevisionNo !== 'number' ||
    typeof candidate.mergedContentRaw !== 'string' ||
    typeof candidate.conflictCount !== 'number'
  ) {
    return null;
  }
  return candidate as WikiEditConflictDetails;
}

function containsWikiConflictMarkers(contentRaw: string): boolean {
  return /^(?:<<<<<<< 내 편집|\|\|\|\|\|\|\| 기준 판|=======|>>>>>>> 최신 판)$/m.test(
    contentRaw.replace(/\r\n?/g, '\n')
  );
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

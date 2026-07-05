'use client';

import Image from 'next/image';
import Link from 'next/link';
import {
  ChangeEvent,
  DragEvent,
  KeyboardEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  CircleAlert,
  FileImage,
  ImagePlus,
  Info,
  Loader2,
  ShieldCheck,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  serverRegistrationSchema,
  type ServerRegistrationPayload,
  type ServerDetail,
} from '@creepervote/schemas';
import { useAuth } from '../../../components/providers/auth-context';
import { normalizeApiBaseUrl } from '../../../lib/runtime-config';
import { buildServerPath } from '../../../lib/server-routes';
import { SiteHeader } from '../../../components/layout/site-header';
import { ServerDescriptionEditor } from '../../../components/servers/server-description-editor';
import {
  getServerPreviewFallbackClass,
  getServerPreviewInitial,
  getServerPreviewSeed,
} from '../../../lib/server-preview';

type FormState = {
  name: string;
  joinHost: string;
  joinPort: string;
  edition: 'java' | 'bedrock';
  supportedVersions: string[];
  tags: string;
  shortDescription: string;
  longDescription: string;
  websiteUrl: string;
  discordUrl: string;
};

const DEFAULT_FORM: FormState = {
  name: '',
  joinHost: '',
  joinPort: '25565',
  edition: 'java',
  supportedVersions: [],
  tags: '',
  shortDescription: '',
  longDescription: '',
  websiteUrl: '',
  discordUrl: '',
};

function parseList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const MAX_SUPPORTED_VERSIONS = 8;
const MAX_BANNER_SIZE_BYTES = 2 * 1024 * 1024;

const VERSION_OPTIONS: Record<FormState['edition'], string[]> = {
  java: [
    '1.21.1',
    '1.21',
    '1.20.6',
    '1.20.4',
    '1.20.2',
    '1.20.1',
    '1.19.4',
    '1.19.3',
    '1.19.2',
    '1.18.2',
    '1.17.1',
    '1.16.5',
    '1.15.2',
    '1.14.4',
    '1.12.2',
  ],
  bedrock: [
    '1.21.30',
    '1.21.20',
    '1.21.2',
    '1.20.81',
    '1.20.80',
    '1.20.73',
    '1.20.62',
    '1.20.51',
    '1.19.83',
    '1.18.32',
    '1.17.41',
    '1.16.221',
  ],
};

type BannerState = {
  dataUrl: string | null;
  previewUrl: string | null;
  fileName: string | null;
  error: string | null;
  uploading: boolean;
  uploaded: boolean;
};

type ReadinessItem = {
  label: string;
  done: boolean;
  helper: string;
};

const INITIAL_BANNER_STATE: BannerState = {
  dataUrl: null,
  previewUrl: null,
  fileName: null,
  error: null,
  uploading: false,
  uploaded: false,
};

export default function ServerRegisterPage() {
  const { account, loading } = useAuth();
  const router = useRouter();
  const apiBaseUrl = useMemo(() => normalizeApiBaseUrl(), []);

  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [registeredServer, setRegisteredServer] = useState<ServerDetail | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [customVersion, setCustomVersion] = useState('');
  const [bannerState, setBannerState] = useState<BannerState>(() => ({ ...INITIAL_BANNER_STATE }));
  const [bannerDragActive, setBannerDragActive] = useState(false);
  const availableVersions = useMemo(() => VERSION_OPTIONS[form.edition], [form.edition]);
  const bannerInputRef = useRef<HTMLInputElement | null>(null);

  const handleChange =
    (field: keyof FormState) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const { value } = event.target;
      setForm((current) => ({ ...current, [field]: value }));
    };

  const handleLongDescriptionChange = useCallback((nextValue: string) => {
    setForm((current) => ({ ...current, longDescription: nextValue }));
  }, []);
  const handleToggleVersion = (version: string) => {
    setForm((current) => {
      const alreadySelected = current.supportedVersions.includes(version);
      if (alreadySelected) {
        const updated = current.supportedVersions.filter((item) => item !== version);
        setVersionError(
          updated.length === 0 ? '최소 하나 이상의 지원 버전을 선택해 주세요.' : null,
        );
        return { ...current, supportedVersions: updated };
      }
      if (current.supportedVersions.length >= MAX_SUPPORTED_VERSIONS) {
        setVersionError(`지원 버전은 최대 ${MAX_SUPPORTED_VERSIONS}개까지 선택할 수 있습니다.`);
        return current;
      }
      setVersionError(null);
      return { ...current, supportedVersions: [...current.supportedVersions, version] };
    });
  };

  const handleRemoveVersion = (version: string) => {
    setForm((current) => {
      const updated = current.supportedVersions.filter((item) => item !== version);
      setVersionError(updated.length === 0 ? '최소 하나 이상의 지원 버전을 선택해 주세요.' : null);
      return { ...current, supportedVersions: updated };
    });
  };

  const handleAddCustomVersion = () => {
    const normalized = customVersion.trim();
    if (!normalized) {
      return;
    }
    let added = false;
    setForm((current) => {
      if (current.supportedVersions.includes(normalized)) {
        setVersionError(null);
        return current;
      }
      if (current.supportedVersions.length >= MAX_SUPPORTED_VERSIONS) {
        setVersionError(`지원 버전은 최대 ${MAX_SUPPORTED_VERSIONS}개까지 선택할 수 있습니다.`);
        return current;
      }
      added = true;
      setVersionError(null);
      return { ...current, supportedVersions: [...current.supportedVersions, normalized] };
    });
    if (added) {
      setCustomVersion('');
    }
  };

  const handleCustomVersionKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleAddCustomVersion();
    }
  };

  const resetBannerSelection = () => {
    setBannerState(() => ({ ...INITIAL_BANNER_STATE }));
    setBannerDragActive(false);
    if (bannerInputRef.current) {
      bannerInputRef.current.value = '';
    }
  };

  const prepareBannerFile = (file: File) => {
    if (!file) {
      resetBannerSelection();
      return;
    }
    if (!file.type.startsWith('image/')) {
      setBannerState(() => ({
        ...INITIAL_BANNER_STATE,
        error: '이미지 파일만 업로드할 수 있습니다.',
      }));
      if (bannerInputRef.current) {
        bannerInputRef.current.value = '';
      }
      return;
    }
    if (file.size > MAX_BANNER_SIZE_BYTES) {
      setBannerState(() => ({
        ...INITIAL_BANNER_STATE,
        error: '배너 이미지는 2MB 이하의 파일만 업로드할 수 있습니다.',
      }));
      if (bannerInputRef.current) {
        bannerInputRef.current.value = '';
      }
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : null;
      if (!result) {
        setBannerState(() => ({
          ...INITIAL_BANNER_STATE,
          error: '이미지 미리보기를 불러오지 못했습니다.',
        }));
        return;
      }
      setBannerState(() => ({
        dataUrl: result,
        previewUrl: result,
        fileName: file.name,
        error: null,
        uploading: false,
        uploaded: false,
      }));
    };
    reader.onerror = () => {
      setBannerState(() => ({
        ...INITIAL_BANNER_STATE,
        error: '이미지 파일을 읽는 중 오류가 발생했습니다.',
      }));
    };
    reader.readAsDataURL(file);
    if (bannerInputRef.current) {
      bannerInputRef.current.value = '';
    }
  };

  const handleBannerSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      resetBannerSelection();
      return;
    }
    prepareBannerFile(file);
  };

  const handleBannerDragOver = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!bannerDragActive) {
      setBannerDragActive(true);
    }
  };

  const handleBannerDragLeave = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setBannerDragActive(false);
    }
  };

  const handleBannerDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setBannerDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) {
      return;
    }
    prepareBannerFile(file);
  };

  const uploadBanner = useCallback(
    async (serverId: string, dataUrl: string): Promise<boolean> => {
      setBannerState((current) => ({
        ...current,
        uploading: true,
        error: null,
        uploaded: false,
      }));
      try {
        const response = await fetch(`${apiBaseUrl}/v1/servers/${serverId}/banner`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ data: dataUrl }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body?.message ?? '배너 업로드에 실패했습니다.');
        }
        await response.json();
        setBannerState((current) => ({
          ...current,
          uploading: false,
          uploaded: true,
          error: null,
        }));
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : '배너 업로드 중 오류가 발생했습니다.';
        setBannerState((current) => ({
          ...current,
          uploading: false,
          uploaded: false,
          error: message,
        }));
        setErrors((current) => [...current, message]);
        return false;
      }
    },
    [apiBaseUrl, setErrors],
  );

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#121212] px-4 text-[#A0A0A0]">
        <div className="rounded-xl border border-[#333333] bg-[#1A1A1A] px-5 py-3 text-sm">
          서버 등록 도구를 불러오는 중입니다...
        </div>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#121212] px-4">
        <div className="w-full max-w-xl rounded-xl border border-[#333333] bg-[#1A1A1A] p-6 text-center">
          <h2 className="text-xl font-bold text-white">로그인이 필요합니다</h2>
          <p className="mt-3 text-sm text-[#A0A0A0]">
            서버를 등록하려면 Discord 또는 NAVER 계정으로 로그인해야 합니다.
          </p>
          <Link
            className="mt-5 inline-flex rounded-lg bg-[#13ec80] px-5 py-2.5 text-sm font-bold text-black transition hover:bg-[#35f29a]"
            href="/login?returnTo=/servers/register"
          >
            로그인하기
          </Link>
        </div>
      </div>
    );
  }

  const buildPayload = (): ServerRegistrationPayload => {
    const supportedVersions = Array.from(
      new Set(
        form.supportedVersions
          .map((version) => version.trim())
          .filter((version) => version.length > 0),
      ),
    );
    const tags = parseList(form.tags);
    const joinPort = Number.parseInt(form.joinPort, 10);

    return {
      name: form.name,
      joinHost: form.joinHost,
      joinPort: Number.isNaN(joinPort) ? 25565 : joinPort,
      edition: form.edition,
      supportedVersions,
      tags,
      shortDescription: form.shortDescription,
      longDescription: form.longDescription,
      websiteUrl: form.websiteUrl ? form.websiteUrl : null,
      discordUrl: form.discordUrl ? form.discordUrl : null,
    };
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors([]);
    setNotice(null);
    setRegisteredServer(null);
    if (form.supportedVersions.length === 0) {
      setVersionError('최소 하나 이상의 지원 버전을 선택해 주세요.');
      return;
    }
    setVersionError(null);

    const payload = buildPayload();
    const parsed = serverRegistrationSchema.safeParse(payload);
    if (!parsed.success) {
      const issueMessages = parsed.error.issues.map((issue) => issue.message);
      const uniqueMessages = Array.from(new Set(issueMessages));
      setErrors(uniqueMessages);
      return;
    }

    const bannerDataUrl = bannerState.dataUrl;
    setSubmitting(true);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(parsed.data),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.message ?? '서버 등록에 실패했습니다.');
      }
      const detail = (await response.json()) as ServerDetail;
      setRegisteredServer(detail);
      const claimUrl = `/claim?serverId=${detail.id}`;
      setNotice('서버가 등록되었습니다. 검증 마법사에서 소유권 확인을 완료하세요.');
      router.prefetch(claimUrl);
      if (bannerDataUrl) {
        const bannerUploaded = await uploadBanner(detail.id, bannerDataUrl);
        if (bannerUploaded) {
          setNotice(
            '서버가 등록되었습니다. 배너 이미지까지 업로드되었습니다. 검증 마법사에서 소유권 확인을 완료하세요.',
          );
        }
      }
      router.push(claimUrl);
    } catch (submitError) {
      setErrors([
        submitError instanceof Error
          ? submitError.message
          : '서버 등록 요청 중 오류가 발생했습니다.',
      ]);
    } finally {
      setSubmitting(false);
    }
  };
  const shortDescriptionCount = form.shortDescription.length;
  const bannerPreviewName = form.name.trim() || '새 서버';
  const bannerPreviewHost = form.joinHost.trim() || 'mc.example.com';
  const parsedPreviewPort = Number.parseInt(form.joinPort, 10);
  const bannerPreviewPort =
    Number.isInteger(parsedPreviewPort) && parsedPreviewPort > 0 ? parsedPreviewPort : 25565;
  const bannerPreviewAddress =
    bannerPreviewPort === 25565 ? bannerPreviewHost : `${bannerPreviewHost}:${bannerPreviewPort}`;
  const bannerPreviewSeed = getServerPreviewSeed({
    joinHost: bannerPreviewHost,
    name: bannerPreviewName,
  });
  const trimmedLongDescription = form.longDescription.trim();
  const readinessItems: ReadinessItem[] = [
    {
      label: '접속 정보',
      done:
        form.name.trim().length > 0 &&
        form.joinHost.trim().length > 0 &&
        form.joinPort.trim().length > 0,
      helper: '서버명, 주소, 포트를 입력하세요.',
    },
    {
      label: '지원 버전',
      done: form.supportedVersions.length > 0,
      helper: '최소 1개 버전이 필요합니다.',
    },
    {
      label: '소개 문구',
      done: form.shortDescription.trim().length > 0 && trimmedLongDescription.length > 0,
      helper: '목록 문구와 상세 설명을 채우세요.',
    },
    {
      label: '검증 이동',
      done: registeredServer !== null,
      helper: '등록 후 MOTD 검증으로 이동합니다.',
    },
  ];
  const completedReadiness = readinessItems.filter((item) => item.done).length;
  const readinessPercent = Math.round((completedReadiness / readinessItems.length) * 100);
  const selectedVersionSummary =
    form.supportedVersions.length > 0
      ? `${form.supportedVersions.length}/${MAX_SUPPORTED_VERSIONS}개 선택됨`
      : '아직 선택 없음';
  const bannerStatusLabel = bannerState.previewUrl
    ? bannerState.uploaded
      ? '업로드 완료'
      : '등록 시 함께 업로드'
    : '기본 미리보기 사용';

  return (
    <div className="min-h-screen bg-[#121212] text-white">
      <SiteHeader />

      <main className="min-h-screen pb-16 pt-24">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-8">
            <div className="mb-5 flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[#2f3d38] bg-[#17211d] px-3 py-1 text-xs font-semibold text-[#9ff4c5]">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  등록 후 소유권 검증으로 이동
                </div>
                <h1 className="text-3xl font-bold text-white">운영 서버 등록</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[#A0A0A0]">
                  서버 목록에 바로 쓰이는 정보입니다. 접속 주소와 지원 버전은 실제 운영 상태에 맞춰
                  입력해 주세요.
                </p>
              </div>
              <div className="grid min-w-[280px] grid-cols-3 overflow-hidden rounded-lg border border-[#333333] bg-[#161616] text-center text-[11px] font-semibold">
                <div className="border-r border-[#333333] bg-[#13ec80]/10 px-3 py-2 text-[#13ec80]">
                  1. 정보 입력
                </div>
                <div className="border-r border-[#333333] px-3 py-2 text-[#8f949d]">2. 검증</div>
                <div className="px-3 py-2 text-[#8f949d]">3. 공개 준비</div>
              </div>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-[#333333]">
              <div
                className="h-full bg-[#13ec80]"
                style={{ width: `${Math.max(readinessPercent, 20)}%` }}
              />
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
              <div className="space-y-6 lg:col-span-2">
                <section className="rounded-xl border border-[#333333] bg-[#1A1A1A] p-6 shadow-sm md:p-8">
                  <div className="mb-6 flex flex-col gap-2 border-b border-[#333333] pb-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-lg font-bold text-white">서버 기본 정보</h2>
                      <p className="mt-1 text-xs text-[#8f949d]">
                        접속 가능한 주소와 서버 목록에 표시될 설명을 입력합니다.
                      </p>
                    </div>
                    <span className="inline-flex w-fit items-center rounded-full border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-200">
                      필수
                    </span>
                  </div>

                  <div className="space-y-6">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-[#A0A0A0]">
                        서버 이름
                      </label>
                      <input
                        className="w-full rounded-lg border border-[#333333] bg-[#121212] px-4 py-3 text-sm text-white outline-none transition focus:border-[#13ec80]"
                        placeholder="예: 마인크래프트 야생 서버"
                        type="text"
                        value={form.name}
                        onChange={handleChange('name')}
                        maxLength={32}
                        required
                      />
                      <p className="mt-1.5 text-xs text-[#6f7680]">
                        목록 카드와 상세 페이지 제목에 그대로 표시됩니다.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                      <div className="md:col-span-3">
                        <label className="mb-1.5 block text-sm font-medium text-[#A0A0A0]">
                          접속 주소
                        </label>
                        <input
                          className="w-full rounded-lg border border-[#333333] bg-[#121212] px-4 py-3 text-sm text-white outline-none transition focus:border-[#13ec80]"
                          placeholder="mc.example.com"
                          type="text"
                          value={form.joinHost}
                          onChange={handleChange('joinHost')}
                          required
                        />
                        <p className="mt-1.5 text-xs text-[#6f7680]">
                          숫자 IP 또는 도메인을 입력하세요. 프로토콜은 넣지 않습니다.
                        </p>
                      </div>
                      <div>
                        <label className="mb-1.5 block text-sm font-medium text-[#A0A0A0]">
                          포트
                        </label>
                        <input
                          className="w-full rounded-lg border border-[#333333] bg-[#121212] px-4 py-3 text-sm text-white outline-none transition focus:border-[#13ec80]"
                          type="number"
                          min={1}
                          max={65535}
                          value={form.joinPort}
                          onChange={handleChange('joinPort')}
                          required
                        />
                      </div>
                    </div>

                    <div>
                      <label className="mb-3 block text-sm font-medium text-[#A0A0A0]">
                        에디션
                      </label>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="cursor-pointer">
                          <input
                            className="peer sr-only"
                            name="edition"
                            type="radio"
                            checked={form.edition === 'java'}
                            onChange={() => {
                              setForm((current) => ({
                                ...current,
                                edition: 'java',
                                supportedVersions: [],
                              }));
                              setVersionError('최소 하나 이상의 지원 버전을 선택해 주세요.');
                            }}
                          />
                          <div
                            className={`flex min-h-[76px] items-center gap-3 rounded-lg border p-4 transition ${
                              form.edition === 'java'
                                ? 'border-[#13ec80] bg-[#13ec80]/10'
                                : 'border-[#333333] bg-[#121212] hover:border-[#4b4b4b]'
                            }`}
                          >
                            <div
                              className={`flex h-5 w-5 items-center justify-center rounded-full border ${
                                form.edition === 'java'
                                  ? 'border-[#13ec80] bg-[#13ec80] text-black'
                                  : 'border-[#666] bg-[#1A1A1A]'
                              }`}
                            >
                              {form.edition === 'java' ? (
                                <Check className="h-3 w-3" aria-hidden="true" />
                              ) : null}
                            </div>
                            <div>
                              <span className="block text-sm font-bold text-white">
                                Java Edition
                              </span>
                              <span className="text-xs text-[#A0A0A0]">PC 런처 기반 서버</span>
                            </div>
                          </div>
                        </label>
                        <label className="cursor-pointer">
                          <input
                            className="peer sr-only"
                            name="edition"
                            type="radio"
                            checked={form.edition === 'bedrock'}
                            onChange={() => {
                              setForm((current) => ({
                                ...current,
                                edition: 'bedrock',
                                supportedVersions: [],
                              }));
                              setVersionError('최소 하나 이상의 지원 버전을 선택해 주세요.');
                            }}
                          />
                          <div
                            className={`flex min-h-[76px] items-center gap-3 rounded-lg border p-4 transition ${
                              form.edition === 'bedrock'
                                ? 'border-[#13ec80] bg-[#13ec80]/10'
                                : 'border-[#333333] bg-[#121212] hover:border-[#4b4b4b]'
                            }`}
                          >
                            <div
                              className={`flex h-5 w-5 items-center justify-center rounded-full border ${
                                form.edition === 'bedrock'
                                  ? 'border-[#13ec80] bg-[#13ec80] text-black'
                                  : 'border-[#666] bg-[#1A1A1A]'
                              }`}
                            >
                              {form.edition === 'bedrock' ? (
                                <Check className="h-3 w-3" aria-hidden="true" />
                              ) : null}
                            </div>
                            <div>
                              <span className="block text-sm font-bold text-white">
                                Bedrock Edition
                              </span>
                              <span className="text-xs text-[#A0A0A0]">모바일, 콘솔, Windows</span>
                            </div>
                          </div>
                        </label>
                      </div>
                    </div>

                    <div>
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <label className="block text-sm font-medium text-[#A0A0A0]">
                          지원 버전
                        </label>
                        <span className="text-xs text-[#8f949d]">{selectedVersionSummary}</span>
                      </div>
                      <div className="space-y-3 rounded-lg border border-[#333333] bg-[#121212] p-3">
                        <div className="flex flex-wrap gap-2">
                          {availableVersions.map((version) => {
                            const selected = form.supportedVersions.includes(version);
                            return (
                              <button
                                key={version}
                                type="button"
                                onClick={() => handleToggleVersion(version)}
                                className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition ${
                                  selected
                                    ? 'border-[#13ec80]/40 bg-[#13ec80]/20 text-[#13ec80]'
                                    : 'border-[#333333] bg-[#1A1A1A] text-[#A0A0A0] hover:border-[#555] hover:text-white'
                                }`}
                              >
                                {version}
                              </button>
                            );
                          })}
                        </div>

                        <div className="flex min-h-[44px] flex-wrap items-center gap-2 rounded-lg border border-[#333333] bg-[#1A1A1A] px-3 py-2">
                          {form.supportedVersions.length > 0 ? (
                            form.supportedVersions.map((version) => (
                              <span
                                key={version}
                                className="inline-flex items-center rounded-md bg-[#121212] px-2.5 py-1 text-xs text-gray-200"
                              >
                                {version}
                                <button
                                  aria-label={`${version} 버전 제거`}
                                  className="ml-1.5 text-[#777] hover:text-white"
                                  onClick={() => handleRemoveVersion(version)}
                                  type="button"
                                >
                                  <X className="h-3 w-3" aria-hidden="true" />
                                </button>
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-[#777]">
                              서버 접속을 허용하는 버전을 선택하세요.
                            </span>
                          )}
                        </div>

                        <div className="flex flex-col gap-2 sm:flex-row">
                          <input
                            className="w-full rounded-lg border border-[#333333] bg-[#1A1A1A] px-3 py-2 text-sm text-white outline-none focus:border-[#13ec80]"
                            placeholder="버전 입력 (Enter로 추가)"
                            type="text"
                            value={customVersion}
                            onChange={(event) => setCustomVersion(event.target.value)}
                            onKeyDown={handleCustomVersionKeyDown}
                          />
                          <button
                            className="rounded-lg border border-[#13ec80]/40 bg-[#13ec80]/10 px-3 py-2 text-sm font-semibold text-[#13ec80] transition hover:bg-[#13ec80]/20"
                            onClick={handleAddCustomVersion}
                            type="button"
                          >
                            추가
                          </button>
                        </div>
                      </div>
                      <p className="mt-1.5 text-xs text-[#A0A0A0]">
                        목록에 없는 버전은 직접 입력할 수 있습니다. 최대 {MAX_SUPPORTED_VERSIONS}
                        개까지 등록됩니다.
                      </p>
                      {versionError ? (
                        <p className="mt-1.5 text-xs text-red-400">{versionError}</p>
                      ) : null}
                    </div>

                    <div>
                      <div className="flex justify-between">
                        <label className="mb-1.5 block text-sm font-medium text-[#A0A0A0]">
                          짧은 소개
                        </label>
                        <span className="text-xs text-[#A0A0A0]">
                          {shortDescriptionCount} / 160
                        </span>
                      </div>
                      <input
                        className="w-full rounded-lg border border-[#333333] bg-[#121212] px-4 py-3 text-sm text-white outline-none transition focus:border-[#13ec80]"
                        maxLength={160}
                        placeholder="서버 목록 카드에 표시될 한 줄 소개입니다."
                        type="text"
                        value={form.shortDescription}
                        onChange={handleChange('shortDescription')}
                        required
                      />
                      <p className="mt-1.5 text-xs text-[#6f7680]">
                        과장보다 서버의 핵심 모드, 운영 방식, 접속 대상을 짧게 쓰는 편이 좋습니다.
                      </p>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-[#A0A0A0]">
                        상세 설명
                      </label>
                      <ServerDescriptionEditor
                        value={form.longDescription}
                        onChange={handleLongDescriptionChange}
                        apiBaseUrl={apiBaseUrl}
                        disabled={submitting}
                      />
                    </div>
                  </div>
                </section>

                <section className="rounded-xl border border-[#333333] bg-[#1A1A1A] p-6 shadow-sm md:p-8">
                  <div className="mb-6 flex flex-col gap-2 border-b border-[#333333] pb-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-lg font-bold text-white">추가 정보</h2>
                      <p className="mt-1 text-xs text-[#8f949d]">
                        커뮤니티 링크와 태그는 유저가 서버 성격을 판단하는 데 도움이 됩니다.
                      </p>
                    </div>
                    <span className="inline-flex w-fit items-center rounded-full border border-[#333333] bg-[#121212] px-2.5 py-1 text-xs font-semibold text-[#A0A0A0]">
                      선택
                    </span>
                  </div>

                  <div className="space-y-6">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-[#A0A0A0]">
                        태그
                      </label>
                      <input
                        className="w-full rounded-lg border border-[#333333] bg-[#121212] px-4 py-3 text-sm text-white outline-none transition focus:border-[#13ec80]"
                        placeholder="#야생 #RPG #경제 (쉼표/공백 구분)"
                        type="text"
                        value={form.tags}
                        onChange={handleChange('tags')}
                      />
                      <p className="mt-1.5 text-xs text-[#6f7680]">
                        예: 야생, 경제, RPG. 검색 필터에 쓰이므로 실제 콘텐츠 기준으로 적어주세요.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                      <div>
                        <label className="mb-1.5 block text-sm font-medium text-[#A0A0A0]">
                          웹사이트 URL
                        </label>
                        <input
                          className="w-full rounded-lg border border-[#333333] bg-[#121212] px-4 py-3 text-sm text-white outline-none transition focus:border-[#13ec80]"
                          placeholder="https://"
                          type="url"
                          value={form.websiteUrl}
                          onChange={handleChange('websiteUrl')}
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-sm font-medium text-[#A0A0A0]">
                          디스코드 초대 링크
                        </label>
                        <input
                          className="w-full rounded-lg border border-[#333333] bg-[#121212] px-4 py-3 text-sm text-white outline-none transition focus:border-[#13ec80]"
                          placeholder="https://discord.gg/"
                          type="url"
                          value={form.discordUrl}
                          onChange={handleChange('discordUrl')}
                        />
                      </div>
                    </div>
                  </div>
                </section>
              </div>

              <div className="space-y-6">
                <section className="sticky top-24 rounded-xl border border-[#333333] bg-[#1A1A1A] p-5 shadow-sm">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-bold text-white">서버 배너</h3>
                      <p className="mt-1 text-xs leading-5 text-[#8f949d]">
                        서버 목록에서 가장 먼저 보이는 이미지입니다.
                      </p>
                    </div>
                    <span className="rounded-full border border-[#333333] bg-[#121212] px-2.5 py-1 text-[11px] font-semibold text-[#A0A0A0]">
                      선택
                    </span>
                  </div>
                  <div className="mb-4">
                    <button
                      type="button"
                      className={`relative flex aspect-video w-full overflow-hidden rounded-lg border-2 border-dashed bg-[#121212] p-3 text-center transition ${
                        bannerDragActive
                          ? 'border-[#13ec80] bg-[#13ec80]/5'
                          : 'border-[#333333] hover:border-[#13ec80]'
                      }`}
                      onClick={() => bannerInputRef.current?.click()}
                      onDragOver={handleBannerDragOver}
                      onDragLeave={handleBannerDragLeave}
                      onDrop={handleBannerDrop}
                    >
                      {bannerState.previewUrl ? (
                        <>
                          <Image
                            alt="배너 미리보기"
                            className="h-full w-full rounded-md object-cover"
                            height={720}
                            src={bannerState.previewUrl}
                            unoptimized
                            width={1280}
                          />
                          <span className="absolute right-3 top-3 rounded-full bg-black/70 px-2 py-1 text-[11px] font-semibold text-white">
                            미리보기
                          </span>
                        </>
                      ) : (
                        <div className="relative h-full w-full rounded-md">
                          <div
                            className={`absolute inset-0 ${getServerPreviewFallbackClass(bannerPreviewSeed)}`}
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />
                          <div className="relative z-10 flex h-full flex-col justify-between p-4 text-left">
                            <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-white/20 bg-black/35 text-2xl font-black text-white">
                              {getServerPreviewInitial(bannerPreviewName)}
                            </div>
                            <div>
                              <p className="text-[10px] font-semibold uppercase text-white/75">
                                기본 미리보기
                              </p>
                              <p className="mt-1 truncate text-lg font-bold text-white">
                                {bannerPreviewName}
                              </p>
                              <p className="truncate text-[11px] text-white/80">
                                {bannerPreviewAddress}
                              </p>
                            </div>
                          </div>
                          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-center gap-2 bg-black/50 px-3 py-2 text-[11px] text-white/85">
                            <UploadCloud className="h-3.5 w-3.5" aria-hidden="true" />
                            클릭하거나 파일을 놓으세요. 권장 1280x720px, 최대 2MB
                          </div>
                        </div>
                      )}
                    </button>
                    <input
                      ref={bannerInputRef}
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={handleBannerSelect}
                      type="file"
                    />
                  </div>

                  <div className="flex items-center gap-3 rounded-lg border border-[#333333] bg-[#121212] p-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[#1A1A1A] text-[#8f949d]">
                      <FileImage className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <p className="truncate text-xs font-medium text-white">
                        {bannerState.fileName ?? '선택된 파일 없음'}
                      </p>
                      <p className="text-[10px] text-[#A0A0A0]">{bannerStatusLabel}</p>
                    </div>
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#333333] text-[#A0A0A0] transition hover:border-[#13ec80]/40 hover:text-white"
                      onClick={() => bannerInputRef.current?.click()}
                      aria-label="배너 이미지 선택"
                    >
                      <ImagePlus className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>

                  {bannerState.previewUrl ? (
                    <button
                      type="button"
                      className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-[#13ec80] transition hover:text-[#35f29a]"
                      onClick={resetBannerSelection}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                      배너 선택 취소
                    </button>
                  ) : null}
                  {bannerState.error ? (
                    <p className="mt-3 flex items-start gap-1.5 text-xs text-red-300">
                      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {bannerState.error}
                    </p>
                  ) : null}
                  {bannerState.uploading ? (
                    <p className="mt-3 flex items-center gap-1.5 text-xs text-sky-300">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      배너를 업로드하고 있습니다.
                    </p>
                  ) : null}
                  {bannerState.uploaded && !bannerState.uploading && !bannerState.error ? (
                    <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-300">
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                      배너 업로드가 완료되었습니다.
                    </p>
                  ) : null}
                </section>

                <section className="rounded-xl border border-[#333333] bg-[#1A1A1A] p-5 shadow-sm">
                  <div className="mb-5">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-base font-bold text-white">등록 준비도</h3>
                      <span className="text-sm font-bold text-[#13ec80]">{readinessPercent}%</span>
                    </div>
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#333333]">
                      <div
                        className="h-full bg-[#13ec80]"
                        style={{ width: `${readinessPercent}%` }}
                      />
                    </div>
                  </div>

                  <div className="mb-5 space-y-2">
                    {readinessItems.map((item) => (
                      <div
                        key={item.label}
                        className="flex items-start gap-3 rounded-lg bg-[#121212] p-3"
                      >
                        <div
                          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                            item.done
                              ? 'border-[#13ec80] bg-[#13ec80] text-black'
                              : 'border-[#4b4b4b] text-[#777]'
                          }`}
                        >
                          {item.done ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
                        </div>
                        <div>
                          <p className="text-xs font-bold text-white">{item.label}</p>
                          <p className="mt-0.5 text-[11px] leading-4 text-[#8f949d]">
                            {item.helper}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>

                  {errors.length > 0 ? (
                    <div className="mb-4 flex gap-3 rounded-lg border border-red-500/20 bg-red-500/10 p-3">
                      <CircleAlert
                        className="mt-0.5 h-4 w-4 shrink-0 text-red-300"
                        aria-hidden="true"
                      />
                      <div>
                        <h4 className="mb-1 text-xs font-bold text-red-300">
                          입력 오류가 있습니다
                        </h4>
                        <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-red-200">
                          {errors.map((error) => (
                            <li key={error}>{error}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  ) : null}

                  {notice ? (
                    <div className="mb-4 rounded-lg border border-[#13ec80]/20 bg-[#13ec80]/10 p-3 text-xs leading-5 text-[#c4f9df]">
                      {notice}
                    </div>
                  ) : null}

                  <div className="mb-6 flex gap-3 rounded-lg border border-[#13ec80]/20 bg-[#13ec80]/5 p-3">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#13ec80]" aria-hidden="true" />
                    <p className="text-xs leading-relaxed text-[#A0A0A0]">
                      등록 버튼을 누르면 서버 상태 확인을 위한{' '}
                      <span className="font-bold text-white">MOTD 검증</span> 단계로 이동합니다.
                    </p>
                  </div>

                  <button
                    className="group flex w-full items-center justify-center gap-2 rounded-xl bg-[#13ec80] px-6 py-3.5 text-sm font-bold text-black transition hover:bg-[#0fb865] disabled:cursor-not-allowed disabled:opacity-60"
                    type="submit"
                    disabled={submitting}
                  >
                    {submitting ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : null}
                    <span>{submitting ? '등록 요청 중' : '서버 등록하기'}</span>
                    {!submitting ? (
                      <ArrowRight
                        className="h-4 w-4 transition group-hover:translate-x-0.5"
                        aria-hidden="true"
                      />
                    ) : null}
                  </button>

                  {registeredServer ? (
                    <div className="mt-4 rounded-lg border border-[#13ec80]/20 bg-[#13ec80]/10 p-3">
                      <p className="text-xs text-[#A0A0A0]">Generated Server ID</p>
                      <code className="text-sm font-bold text-white">{registeredServer.id}</code>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Link
                          href={`/claim?serverId=${registeredServer.id}`}
                          className="rounded-lg bg-[#13ec80] px-3 py-2 text-xs font-bold text-black"
                        >
                          검증 마법사로 이동
                        </Link>
                        <Link
                          href={buildServerPath(registeredServer)}
                          className="rounded-lg border border-[#333333] px-3 py-2 text-xs font-medium text-white transition hover:border-[#13ec80]"
                        >
                          서버 페이지 보기
                        </Link>
                      </div>
                    </div>
                  ) : null}
                </section>
              </div>
            </div>
          </form>
        </div>
        <section className="mx-auto mt-12 w-full max-w-7xl border-t border-[#333333] px-4 pb-4 pt-10 sm:px-6 lg:px-8">
          <div>
            <h4 className="mb-6 font-bold text-white">등록 후 바로 확인할 일</h4>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-md bg-[#1A1A1A] text-xs font-bold text-[#A0A0A0]">
                  1
                </div>
                <div>
                  <p className="text-sm font-bold text-white">MOTD 검증 설정</p>
                  <p className="mt-1 text-xs text-[#A0A0A0]">
                    발급된 코드를 MOTD에 잠시 넣고 검증을 완료하세요.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-md bg-[#1A1A1A] text-xs font-bold text-[#A0A0A0]">
                  2
                </div>
                <div>
                  <p className="text-sm font-bold text-white">Votifier 연결 (선택)</p>
                  <p className="mt-1 text-xs text-[#A0A0A0]">
                    투표 보상을 운영한다면 대시보드에서 플러그인 연결값을 확인하세요.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-md bg-[#1A1A1A] text-xs font-bold text-[#A0A0A0]">
                  3
                </div>
                <div>
                  <p className="text-sm font-bold text-white">목록 노출 확인</p>
                  <p className="mt-1 text-xs text-[#A0A0A0]">
                    배너, 태그, 짧은 소개가 검색 결과에서 잘 읽히는지 확인하세요.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

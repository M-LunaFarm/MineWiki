'use client';

import {
  ChangeEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Globe2,
  Loader2,
  MessageSquare,
  Save,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  MINECRAFT_VERSION_OPTIONS,
  serverRegistrationSchema,
  type ServerRegistrationPayload,
  type ServerDetail,
} from '@minewiki/schemas';
import { useAuth } from '../../../components/providers/auth-context';
import { normalizeApiBaseUrl } from '../../../lib/runtime-config';
import { csrfHeaders } from '../../../lib/csrf';
import { ServerDescriptionEditor } from '../../../components/servers/server-description-editor';
import {
  CaptchaChallenge,
  isCaptchaConfigured,
} from '../../../components/security/captcha-challenge';
import {
  persistClaimMethodPreference,
  type ClaimMethodPreference,
} from '../../../lib/claim-method-preference';

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
const REGISTRATION_DRAFT_KEY_PREFIX = 'minewiki:server-registration-draft';
const REGISTRATION_METHOD_KEY_PREFIX = 'minewiki:server-registration-method';

type ReadinessItem = {
  label: string;
  done: boolean;
  helper: string;
};

export default function ServerRegisterPage() {
  const { account, loading } = useAuth();
  const router = useRouter();
  const apiBaseUrl = useMemo(() => normalizeApiBaseUrl(), []);

  useEffect(() => {
    if (!loading && !account) {
      router.replace('/login?returnTo=/servers/register');
    }
  }, [account, loading, router]);

  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [customVersion, setCustomVersion] = useState('');
  const [selectedClaimMethod, setSelectedClaimMethod] =
    useState<ClaimMethodPreference>('dns');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const [draftOwnerId, setDraftOwnerId] = useState<string | null>(null);
  const captchaRequired = isCaptchaConfigured();
  const availableVersions = useMemo(
    () => MINECRAFT_VERSION_OPTIONS[form.edition],
    [form.edition],
  );
  const errorSummaryRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (errors.length > 0) errorSummaryRef.current?.focus();
  }, [errors]);

  useEffect(() => {
    if (!account?.id) return;
    try {
      const saved = window.localStorage.getItem(`${REGISTRATION_DRAFT_KEY_PREFIX}:${account.id}`);
      const restored = parseStoredRegistrationDraft(saved);
      if (restored) {
        setForm(restored);
        setNotice('이 계정에서 작성하던 서버 등록 초안을 복원했습니다.');
      }
      const savedMethod = window.localStorage.getItem(
        `${REGISTRATION_METHOD_KEY_PREFIX}:${account.id}`,
      );
      if (savedMethod === 'dns' || savedMethod === 'motd') {
        setSelectedClaimMethod(savedMethod);
      }
    } catch {
      // Registration remains available when browser storage is blocked.
    } finally {
      setDraftOwnerId(account.id);
    }
  }, [account?.id]);

  useEffect(() => {
    if (!account?.id || draftOwnerId !== account.id) return;
    try {
      window.localStorage.setItem(`${REGISTRATION_DRAFT_KEY_PREFIX}:${account.id}`, JSON.stringify(form));
    } catch {
      // Registration remains available when browser storage is full or blocked.
    }
  }, [account?.id, draftOwnerId, form]);

  useEffect(() => {
    if (!account?.id || draftOwnerId !== account.id) return;
    try {
      window.localStorage.setItem(
        `${REGISTRATION_METHOD_KEY_PREFIX}:${account.id}`,
        selectedClaimMethod,
      );
    } catch {
      // The choice is still preserved in memory for this registration session.
    }
  }, [account?.id, draftOwnerId, selectedClaimMethod]);

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
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-[#0d1416] px-4 py-3 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin text-[#35e5b7]" />
          서버 등록을 위해 로그인 화면으로 이동 중입니다.
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
    if (form.supportedVersions.length === 0) {
      setVersionError('최소 하나 이상의 지원 버전을 선택해 주세요.');
      return;
    }
    setVersionError(null);

    if (captchaRequired && !captchaToken) {
      setErrors(['서버 등록 전에 보안 확인을 완료해 주세요.']);
      return;
    }

    const payload = buildPayload();
    const parsed = serverRegistrationSchema.safeParse(payload);
    if (!parsed.success) {
      const issueMessages = parsed.error.issues.map((issue) => issue.message);
      const uniqueMessages = Array.from(new Set(issueMessages));
      setErrors(uniqueMessages);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        credentials: 'include',
        body: JSON.stringify({
          ...parsed.data,
          ...(captchaToken ? { captchaToken } : {}),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.message ?? '서버 등록에 실패했습니다.');
      }
      const detail = (await response.json()) as ServerDetail;
      try {
        window.localStorage.removeItem(`${REGISTRATION_DRAFT_KEY_PREFIX}:${account.id}`);
        window.localStorage.removeItem(`${REGISTRATION_METHOD_KEY_PREFIX}:${account.id}`);
      } catch {
        // A completed registration must not fail because draft cleanup is unavailable.
      }
      persistClaimMethodPreference(account.id, detail.id, selectedClaimMethod);
      const claimUrl = `/claim?serverId=${detail.id}`;
      setNotice('서버가 등록되었습니다. 검증 마법사에서 소유권 확인을 완료하세요.');
      router.prefetch(claimUrl);
      router.push(claimUrl);
    } catch (submitError) {
      setCaptchaToken(null);
      setCaptchaResetKey((current) => current + 1);
      setErrors([
        submitError instanceof Error
          ? submitError.message
          : '서버 등록 요청 중 오류가 발생했습니다.',
      ]);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveDraft = () => {
    try {
      window.localStorage.setItem(
        `${REGISTRATION_DRAFT_KEY_PREFIX}:${account.id}`,
        JSON.stringify(form),
      );
      window.localStorage.setItem(
        `${REGISTRATION_METHOD_KEY_PREFIX}:${account.id}`,
        selectedClaimMethod,
      );
      setNotice('입력한 정보와 검증 방식을 이 계정의 임시 저장본으로 보관했습니다.');
      setErrors([]);
    } catch {
      setErrors(['브라우저 저장 공간을 사용할 수 없어 임시 저장하지 못했습니다.']);
    }
  };

  const shortDescriptionCount = form.shortDescription.length;
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
  ];
  const completedReadiness = readinessItems.filter((item) => item.done).length;
  const readinessPercent = Math.round((completedReadiness / readinessItems.length) * 100);
  const selectedVersionSummary =
    form.supportedVersions.length > 0
      ? `${form.supportedVersions.length}/${MAX_SUPPORTED_VERSIONS}개 선택됨`
      : '아직 선택 없음';

  return (
    <div className="server-registration-surface min-h-screen bg-[#121212] text-white">
      <main className="min-h-screen pb-36 pt-8">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-7">
            <div className="mb-5 flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="server-registration-next-chip mb-3 inline-flex items-center gap-2 rounded-full border border-[#2f3d38] bg-[#17211d] px-3 py-1 text-xs font-semibold text-[#9ff4c5]">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  등록 후 소유권 검증으로 이동
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="text-3xl font-bold text-white">운영 서버 등록</h1>
                  <span className="rounded-full border border-[#333333] bg-[#1A1A1A] px-3 py-1 text-xs font-semibold text-[#8f949d]">
                    현재: 미검증
                  </span>
                </div>
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
            <div className="grid gap-4 rounded-xl border border-[#333333] bg-[#1A1A1A] p-5 md:grid-cols-2 md:gap-8">
              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-white">정보 완성도</span>
                  <span className="font-bold text-[#13ec80]">{readinessPercent}%</span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#333333]">
                  <div
                    className="h-full rounded-full bg-[#13ec80] transition-[width]"
                    role="progressbar"
                    aria-label="정보 완성도"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={readinessPercent}
                    style={{ width: `${readinessPercent}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between gap-4 text-xs">
                  <span className="font-bold text-white">소유권 신뢰</span>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 font-semibold text-[#13ec80]"
                    onClick={() =>
                      document.getElementById('claim-method-selector')?.scrollIntoView({
                        behavior: 'smooth',
                        block: 'center',
                      })
                    }
                  >
                    검증 방식 보기
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#333333]" />
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#8f949d]">
                    <span className="h-2.5 w-2.5 rounded-full border-2 border-sky-500" />
                    미검증
                  </span>
                </div>
              </div>
            </div>
          </div>

          <form id="server-registration-form" onSubmit={handleSubmit}>
            {errors.length > 0 ? (
              <div
                ref={errorSummaryRef}
                role="alert"
                aria-live="assertive"
                tabIndex={-1}
                className="mb-6 flex gap-3 rounded-lg border border-red-500/20 bg-red-500/10 p-4 focus:outline-none focus:ring-2 focus:ring-red-300/70"
              >
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-hidden="true" />
                <div>
                  <h4 className="mb-1 text-xs font-bold text-red-300">입력 오류가 있습니다</h4>
                  <ul className="list-disc space-y-0.5 pl-4 text-xs text-red-200">
                    {errors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            {notice ? (
              <div className="server-registration-draft-notice mb-6 rounded-lg border border-[#13ec80]/20 bg-[#13ec80]/10 p-4 text-xs leading-5 text-[#c4f9df]">
                {notice}
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
              <div className="space-y-6 lg:col-span-2">
                <section
                  id="claim-method-selector"
                  className="rounded-xl border border-[#333333] bg-[#1A1A1A] p-6 shadow-sm md:p-8"
                >
                  <div>
                    <h2 className="text-lg font-bold text-white">
                      어떤 방식으로 소유권을 증명할 수 있나요?{' '}
                      <span className="font-medium text-[#8f949d]">(선택)</span>
                    </h2>
                    <p className="mt-1 text-xs leading-5 text-[#8f949d]">
                      둘 중 하나를 선택하면 이후 입력 도움말이 맞춤으로 제공됩니다.
                    </p>
                  </div>
                  <div
                    className="mt-5 grid gap-4 md:grid-cols-2"
                    role="radiogroup"
                    aria-label="소유권 검증 방식"
                  >
                    <ClaimMethodCard
                      checked={selectedClaimMethod === 'dns'}
                      icon={<Globe2 className="h-5 w-5" aria-hidden="true" />}
                      title="DNS TXT"
                      badge="도메인 필요"
                      description="도메인 관리 화면에 인증용 TXT 값을 추가할 수 있어요."
                      onSelect={() => setSelectedClaimMethod('dns')}
                    />
                    <ClaimMethodCard
                      checked={selectedClaimMethod === 'motd'}
                      icon={<MessageSquare className="h-5 w-5" aria-hidden="true" />}
                      title="서버 MOTD"
                      badge="서버 설정 가능"
                      description="서버 설명(MOTD)을 잠시 변경해 인증 문자열을 노출할 수 있어요."
                      onSelect={() => setSelectedClaimMethod('motd')}
                    />
                  </div>
                </section>

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
                      <label
                        htmlFor="server-name"
                        className="mb-1.5 block text-sm font-medium text-[#A0A0A0]"
                      >
                        서버 이름
                      </label>
                      <input
                        id="server-name"
                        name="name"
                        aria-describedby="server-name-help"
                        className="w-full rounded-lg border border-[#333333] bg-[#121212] px-4 py-3 text-sm text-white outline-none transition focus:border-[#13ec80]"
                        placeholder="예: 마인크래프트 야생 서버"
                        type="text"
                        value={form.name}
                        onChange={handleChange('name')}
                        maxLength={32}
                        required
                      />
                      <p id="server-name-help" className="mt-1.5 text-xs text-[#6f7680]">
                        목록 카드와 상세 페이지 제목에 그대로 표시됩니다.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                      <div className="md:col-span-3">
                        <label
                          htmlFor="server-join-host"
                          className="mb-1.5 block text-sm font-medium text-[#A0A0A0]"
                        >
                          접속 주소
                        </label>
                        <input
                          id="server-join-host"
                          name="joinHost"
                          aria-describedby="server-join-host-help"
                          className="w-full rounded-lg border border-[#333333] bg-[#121212] px-4 py-3 text-sm text-white outline-none transition focus:border-[#13ec80]"
                          placeholder="mc.example.com"
                          type="text"
                          value={form.joinHost}
                          onChange={handleChange('joinHost')}
                          required
                        />
                        <p id="server-join-host-help" className="mt-1.5 text-xs text-[#6f7680]">
                          숫자 IP 또는 도메인을 입력하세요. 프로토콜은 넣지 않습니다.
                        </p>
                      </div>
                      <div>
                        <label
                          htmlFor="server-join-port"
                          className="mb-1.5 block text-sm font-medium text-[#A0A0A0]"
                        >
                          포트
                        </label>
                        <input
                          id="server-join-port"
                          name="joinPort"
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
                      <div
                        id="server-edition-label"
                        className="mb-3 block text-sm font-medium text-[#A0A0A0]"
                      >
                        에디션
                      </div>
                      <div
                        role="radiogroup"
                        aria-labelledby="server-edition-label"
                        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                      >
                        <label className="cursor-pointer">
                          <input
                            id="server-edition-java"
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
                            id="server-edition-bedrock"
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
                        <span
                          id="supported-versions-label"
                          className="block text-sm font-medium text-[#A0A0A0]"
                        >
                          지원 버전
                        </span>
                        <span className="text-xs text-[#8f949d]">{selectedVersionSummary}</span>
                      </div>
                      <div
                        role="group"
                        aria-labelledby="supported-versions-label"
                        aria-describedby="supported-versions-help"
                        className="server-registration-version-picker space-y-3 rounded-lg border border-[#333333] bg-[#121212] p-3"
                      >
                        <div className="flex flex-wrap gap-2">
                          {availableVersions.map((version) => {
                            const selected = form.supportedVersions.includes(version);
                            return (
                              <button
                                key={version}
                                type="button"
                                aria-pressed={selected}
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
                                className="server-registration-version-token inline-flex items-center rounded-md bg-[#121212] px-2.5 py-1 text-xs text-gray-200"
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
                            id="server-custom-version"
                            name="customVersion"
                            aria-label="목록에 없는 지원 버전 직접 입력"
                            aria-invalid={Boolean(versionError)}
                            aria-describedby={versionError ? 'supported-versions-error' : undefined}
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
                      <p id="supported-versions-help" className="mt-1.5 text-xs text-[#A0A0A0]">
                        목록에 없는 버전은 직접 입력할 수 있습니다. 최대 {MAX_SUPPORTED_VERSIONS}
                        개까지 등록됩니다.
                      </p>
                      {versionError ? (
                        <p id="supported-versions-error" className="mt-1.5 text-xs text-red-400">
                          {versionError}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </section>

                <section className="rounded-xl border border-[#333333] bg-[#1A1A1A] p-6 shadow-sm md:p-8">
                  <div className="mb-6 flex flex-col gap-2 border-b border-[#333333] pb-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-lg font-bold text-white">서버 소개</h2>
                      <p className="mt-1 text-xs text-[#8f949d]">
                        목록에서 빠르게 읽히는 한 줄과 상세 페이지의 운영 안내를 작성합니다.
                      </p>
                    </div>
                    <span className="inline-flex w-fit items-center rounded-full border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-200">
                      필수
                    </span>
                  </div>
                  <div className="space-y-6">
                    <div>
                      <div className="flex justify-between">
                        <label
                          htmlFor="server-short-description"
                          className="mb-1.5 block text-sm font-medium text-[#A0A0A0]"
                        >
                          짧은 소개
                        </label>
                        <span className="text-xs text-[#A0A0A0]">
                          {shortDescriptionCount} / 160
                        </span>
                      </div>
                      <input
                        id="server-short-description"
                        name="shortDescription"
                        aria-describedby="server-short-description-help"
                        className="w-full rounded-lg border border-[#333333] bg-[#121212] px-4 py-3 text-sm text-white outline-none transition focus:border-[#13ec80]"
                        maxLength={160}
                        placeholder="서버 목록 카드에 표시될 한 줄 소개입니다."
                        type="text"
                        value={form.shortDescription}
                        onChange={handleChange('shortDescription')}
                        required
                      />
                      <p
                        id="server-short-description-help"
                        className="mt-1.5 text-xs text-[#6f7680]"
                      >
                        과장보다 서버의 핵심 모드, 운영 방식, 접속 대상을 짧게 쓰는 편이 좋습니다.
                      </p>
                    </div>

                    <div>
                      <label
                        htmlFor="server-long-description"
                        className="mb-1.5 block text-sm font-medium text-[#A0A0A0]"
                      >
                        상세 설명
                      </label>
                      <ServerDescriptionEditor
                        value={form.longDescription}
                        onChange={handleLongDescriptionChange}
                        apiBaseUrl={apiBaseUrl}
                        disabled={submitting}
                        textareaId="server-long-description"
                        textareaName="longDescription"
                        ariaDescribedBy="server-long-description-help"
                        compact
                      />
                      <p id="server-long-description-help" className="sr-only">
                        서버 특징, 운영 규칙과 접속 전 안내를 입력하세요.
                      </p>
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
                      <label
                        htmlFor="server-tags"
                        className="mb-1.5 block text-sm font-medium text-[#A0A0A0]"
                      >
                        태그
                      </label>
                      <input
                        id="server-tags"
                        name="tags"
                        aria-describedby="server-tags-help"
                        className="w-full rounded-lg border border-[#333333] bg-[#121212] px-4 py-3 text-sm text-white outline-none transition focus:border-[#13ec80]"
                        placeholder="#야생 #RPG #경제 (쉼표/공백 구분)"
                        type="text"
                        value={form.tags}
                        onChange={handleChange('tags')}
                      />
                      <p id="server-tags-help" className="mt-1.5 text-xs text-[#6f7680]">
                        예: 야생, 경제, RPG. 검색 필터에 쓰이므로 실제 콘텐츠 기준으로 적어주세요.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                      <div>
                        <label
                          htmlFor="server-website-url"
                          className="mb-1.5 block text-sm font-medium text-[#A0A0A0]"
                        >
                          웹사이트 URL
                        </label>
                        <input
                          id="server-website-url"
                          name="websiteUrl"
                          className="w-full rounded-lg border border-[#333333] bg-[#121212] px-4 py-3 text-sm text-white outline-none transition focus:border-[#13ec80]"
                          placeholder="https://"
                          type="url"
                          value={form.websiteUrl}
                          onChange={handleChange('websiteUrl')}
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="server-discord-url"
                          className="mb-1.5 block text-sm font-medium text-[#A0A0A0]"
                        >
                          디스코드 초대 링크
                        </label>
                        <input
                          id="server-discord-url"
                          name="discordUrl"
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

              <div>
                <aside className="space-y-3 lg:sticky lg:top-24">
                  <section className="rounded-xl border border-[#13ec80]/35 bg-[#1A1A1A] p-5 shadow-sm">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-bold text-white">1. 정보 입력</h3>
                      <span className="text-xs font-bold text-[#13ec80]">
                        {readinessPercent === 100 ? '완료' : `${readinessPercent}%`}
                      </span>
                    </div>
                    <div className="mt-4 space-y-2">
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
                  </section>

                  <section className="rounded-xl border border-[#13ec80]/35 bg-[#13ec80]/10 p-5 shadow-sm">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-bold text-white">2. 소유권 검증</h3>
                      <span className="rounded-full border border-[#13ec80]/30 bg-[#13ec80]/10 px-2 py-1 text-[10px] font-bold text-[#13ec80]">
                        다음 단계
                      </span>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-[#A0A0A0]">
                      {selectedClaimMethod === 'dns'
                        ? 'DNS에 TXT 레코드를 추가하고 소유권을 확인합니다.'
                        : '서버 MOTD에 인증 문자열을 넣고 소유권을 확인합니다.'}
                    </p>
                    <div className="mt-4 flex items-center gap-2 rounded-lg border border-[#13ec80]/20 bg-[#121212] px-3 py-2.5">
                      {selectedClaimMethod === 'dns' ? (
                        <Globe2 className="h-4 w-4 text-[#13ec80]" aria-hidden="true" />
                      ) : (
                        <MessageSquare className="h-4 w-4 text-[#13ec80]" aria-hidden="true" />
                      )}
                      <span className="text-xs font-semibold text-white">
                        {selectedClaimMethod === 'dns' ? 'DNS TXT 방식' : 'MOTD 방식'}
                      </span>
                    </div>
                    <p className="mt-3 flex items-center gap-1.5 text-[11px] text-[#8f949d]">
                      <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                      정보 입력을 저장한 뒤 진행
                    </p>
                  </section>

                  <section className="rounded-xl border border-[#333333] bg-[#1A1A1A] p-5 shadow-sm">
                    <h3 className="text-sm font-bold text-white">3. 공개 준비</h3>
                    <p className="mt-3 text-xs leading-5 text-[#8f949d]">배너/태그 확인</p>
                  </section>

                  {captchaRequired ? (
                    <CaptchaChallenge
                      resetKey={captchaResetKey}
                      onTokenChange={setCaptchaToken}
                      title="서버 등록 보안 확인"
                      description="자동 등록과 주소 선점을 막기 위해 한 번만 확인합니다."
                    />
                  ) : null}
                </aside>
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
                  <p className="text-sm font-bold text-white">소유권 검증 방식 선택</p>
                  <p className="mt-1 text-xs text-[#A0A0A0]">
                    DNS TXT 또는 MOTD 중 운영 환경에 맞는 방식을 선택해 검증하세요.
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

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[#333333] bg-[#121212] shadow-[0_-8px_30px_rgba(0,0,0,0.12)]">
        <div className="mx-auto flex min-h-[76px] w-full max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#13ec80] text-xs font-black text-black">
              1
            </span>
            <div>
              <p className="text-sm font-bold text-white">1/3 정보 입력</p>
              <p className="text-[11px] text-[#8f949d]">
                {readinessPercent === 100 ? '필수 정보 입력 완료' : `필수 정보 ${readinessPercent}% 완료`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-[#333333] bg-[#1A1A1A] px-5 text-sm font-bold text-white transition hover:border-[#555] sm:flex-none"
              onClick={handleSaveDraft}
            >
              <Save className="h-4 w-4" aria-hidden="true" />
              임시 저장
            </button>
            <button
              form="server-registration-form"
              aria-describedby={
                captchaRequired && !captchaToken ? 'server-submit-status' : undefined
              }
              className="group inline-flex min-h-11 flex-[1.35] items-center justify-center gap-2 rounded-lg bg-[#13ec80] px-6 text-sm font-black text-black transition hover:bg-[#0fb865] disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none"
              type="submit"
              disabled={submitting || (captchaRequired && !captchaToken)}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              <span>{submitting ? '등록 요청 중' : '다음: 소유권 검증'}</span>
              {!submitting ? (
                <ArrowRight
                  className="h-4 w-4 transition group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              ) : null}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ClaimMethodCard({
  checked,
  icon,
  title,
  badge,
  description,
  onSelect,
}: {
  checked: boolean;
  icon: React.ReactNode;
  title: string;
  badge: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <label
      className={`group cursor-pointer rounded-xl border p-5 transition ${
        checked
          ? 'border-[#13ec80] bg-[#13ec80]/10 shadow-[0_0_0_1px_rgba(19,236,128,0.08)]'
          : 'border-[#333333] bg-[#121212] hover:border-[#555]'
      }`}
    >
      <input
        className="sr-only"
        type="radio"
        name="claimMethod"
        value={title}
        checked={checked}
        onChange={onSelect}
      />
      <span className="flex min-h-[190px] flex-col">
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
            checked ? 'border-[#13ec80] bg-[#13ec80]' : 'border-[#555]'
          }`}
          aria-hidden="true"
        >
          {checked ? <Check className="h-3 w-3 text-black" /> : null}
        </span>
        <span
          className={`mt-4 flex h-12 w-12 shrink-0 items-center justify-center rounded-full border ${
            checked
              ? 'border-[#13ec80]/30 bg-white text-black'
              : 'border-[#333333] bg-[#1A1A1A] text-[#8f949d]'
          }`}
        >
          {icon}
        </span>
        <span className="mt-4 min-w-0">
          <span className="text-sm font-bold text-white">
            {title}{' '}
            <span className="font-semibold text-[#8f949d]">({badge})</span>
          </span>
          <span className="mt-2 block text-xs leading-5 text-[#8f949d]">{description}</span>
        </span>
      </span>
    </label>
  );
}

function parseStoredRegistrationDraft(raw: string | null): FormState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof FormState, unknown>>;
    if (!value || typeof value !== 'object') return null;
    if (value.edition !== 'java' && value.edition !== 'bedrock') return null;
    const stringFields = ['name', 'joinHost', 'joinPort', 'tags', 'shortDescription', 'longDescription', 'websiteUrl', 'discordUrl'] as const;
    if (!stringFields.every((field) => typeof value[field] === 'string')) return null;
    if (!Array.isArray(value.supportedVersions)
      || value.supportedVersions.length > MAX_SUPPORTED_VERSIONS
      || !value.supportedVersions.every((item) => typeof item === 'string')) return null;
    return {
      name: value.name,
      joinHost: value.joinHost,
      joinPort: value.joinPort,
      edition: value.edition,
      supportedVersions: value.supportedVersions,
      tags: value.tags,
      shortDescription: value.shortDescription,
      longDescription: value.longDescription,
      websiteUrl: value.websiteUrl,
      discordUrl: value.discordUrl,
    } as FormState;
  } catch {
    return null;
  }
}

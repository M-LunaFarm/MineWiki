'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createSupportGuestTicket,
  createSupportMessage,
  createSupportTicket,
  fetchSupportServerOptions,
  fetchSupportTicketDetail,
  fetchSupportTickets,
  type SupportServerOption,
  type SupportTicket,
  type SupportTicketDetail,
  type SupportTicketStatus,
} from '../../lib/support-api';
import { useAuth } from '../providers/auth-context';

type TicketStatusFilter = 'all' | SupportTicketStatus;
type TicketPriority = SupportTicket['priority'];
type InquiryTab = 'member' | 'guest';

const AUTO_REFRESH_INTERVAL_MS = 20_000;

const CATEGORY_OPTIONS = [
  { value: 'general', label: '일반 문의' },
  { value: 'account', label: '계정 및 로그인' },
  { value: 'billing', label: '결제 및 환불' },
  { value: 'server', label: '서버 등록 및 관리' },
  { value: 'report', label: '신고 및 제재 이의' },
] as const;

const STATUS_FILTERS: ReadonlyArray<{ value: TicketStatusFilter; label: string }> = [
  { value: 'all', label: '전체' },
  { value: 'open', label: '열림' },
  { value: 'pending', label: '대기' },
  { value: 'resolved', label: '해결' },
  { value: 'closed', label: '종료' },
];

const PRIORITY_OPTIONS: ReadonlyArray<{ value: TicketPriority; label: string }> = [
  { value: 'low', label: '낮음' },
  { value: 'normal', label: '보통' },
  { value: 'high', label: '높음' },
  { value: 'urgent', label: '긴급' },
];

const SUPPORT_TOPICS = [
  {
    category: 'account',
    icon: 'account_circle',
    title: '계정 접근',
    description: '로그인, 프로필, 권한 및 계정 복구 관련 문의를 접수합니다.',
    detail: '계정 식별 정보와 발생 시각을 함께 남겨 주세요.',
  },
  {
    category: 'server',
    icon: 'dns',
    title: '서버 등록',
    description: '서버 심사, 노출 정보, 접속 주소, 소유권 확인을 안내합니다.',
    detail: '가능하면 서버를 선택해 주시면 확인 시간이 단축됩니다.',
  },
  {
    category: 'billing',
    icon: 'receipt_long',
    title: '결제 및 환불',
    description: '결제 내역, 청구 오류, 환불 가능 여부를 검토합니다.',
    detail: '결제일과 주문 번호를 문의 내용에 포함해 주세요.',
  },
  {
    category: 'report',
    icon: 'gavel',
    title: '신고 및 제재',
    description: '서비스 정책 위반 신고와 제재 결과 이의 신청을 접수합니다.',
    detail: '증빙 자료와 관련 서버 정보를 구체적으로 작성해 주세요.',
  },
] as const;

const Turnstile = dynamic(() => import('@marsidev/react-turnstile').then((mod) => mod.Turnstile), {
  ssr: false,
  loading: () => <div className="h-16 w-full animate-pulse rounded-lg bg-[#202124]" />,
});

const HCaptcha = dynamic(() => import('@hcaptcha/react-hcaptcha').then((mod) => mod.default), {
  ssr: false,
  loading: () => <div className="h-16 w-full animate-pulse rounded-lg bg-[#202124]" />,
});

function normalizeSiteKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith('your-') || lowered === 'undefined' || lowered === 'null') {
    return undefined;
  }
  return trimmed;
}

export function SupportRedesignPage() {
  const { account, loading: authLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const hydratedFromQueryRef = useRef(false);
  const messageListRef = useRef<HTMLDivElement | null>(null);

  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SupportTicketDetail | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<TicketStatusFilter>('all');
  const [searchKeyword, setSearchKeyword] = useState('');

  const [messageBody, setMessageBody] = useState('');
  const [submittingMessage, setSubmittingMessage] = useState(false);

  const [serverOptions, setServerOptions] = useState<SupportServerOption[]>([]);
  const [serverOptionsLoading, setServerOptionsLoading] = useState(false);

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [activeInquiryTab, setActiveInquiryTab] = useState<InquiryTab>('guest');

  const [memberSubject, setMemberSubject] = useState('');
  const [memberCategory, setMemberCategory] = useState('general');
  const [memberServerId, setMemberServerId] = useState('');
  const [memberPriority, setMemberPriority] = useState<TicketPriority>('normal');
  const [memberBody, setMemberBody] = useState('');
  const [memberSubmitting, setMemberSubmitting] = useState(false);

  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestSubject, setGuestSubject] = useState('');
  const [guestCategory, setGuestCategory] = useState('general');
  const [guestServerId, setGuestServerId] = useState('');
  const [guestBody, setGuestBody] = useState('');
  const [guestSubmitting, setGuestSubmitting] = useState(false);
  const [guestCaptchaToken, setGuestCaptchaToken] = useState<string | null>(null);
  const [guestCaptchaKey, setGuestCaptchaKey] = useState(0);

  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  const turnstileSiteKey = normalizeSiteKey(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
  const hcaptchaSiteKey = normalizeSiteKey(process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY);
  const captchaMode = turnstileSiteKey ? 'turnstile' : hcaptchaSiteKey ? 'hcaptcha' : 'none';
  const captchaRequired = captchaMode !== 'none';

  const loadDetail = useCallback(async (ticketId: string, silent = false) => {
    if (!silent) {
      setDetailLoading(true);
      setError(null);
    }

    try {
      const payload = await fetchSupportTicketDetail(ticketId);
      setDetail(payload);
    } catch (detailError) {
      if (!silent) {
        const message =
          detailError instanceof Error ? detailError.message : '문의 상세를 불러오지 못했습니다.';
        setError(message === 'UNAUTHORIZED' ? '로그인이 필요합니다.' : message);
        setDetail(null);
      }
    } finally {
      if (!silent) {
        setDetailLoading(false);
      }
    }
  }, []);

  const loadTickets = useCallback(
    async (preferredTicketId?: string | null, silent = false) => {
      if (!account) {
        setTickets([]);
        setSelectedTicketId(null);
        setDetail(null);
        if (!silent) {
          setListLoading(false);
        }
        return;
      }

      if (!silent) {
        setListLoading(true);
        setError(null);
      }

      try {
        const response = await fetchSupportTickets({
          view: 'mine',
          status: statusFilter === 'all' ? undefined : statusFilter,
        });
        const nextTickets = response.items;
        setTickets(nextTickets);

        setSelectedTicketId((current) => {
          const candidate = preferredTicketId ?? current;
          if (candidate && nextTickets.some((ticket) => ticket.id === candidate)) {
            return candidate;
          }
          return nextTickets[0]?.id ?? null;
        });
      } catch (listError) {
        const message =
          listError instanceof Error ? listError.message : '문의 목록을 불러오지 못했습니다.';
        if (!silent) {
          setError(message === 'UNAUTHORIZED' ? '로그인이 필요합니다.' : message);
        }
        setTickets([]);
        setSelectedTicketId(null);
        setDetail(null);
      } finally {
        if (!silent) {
          setListLoading(false);
        }
      }
    },
    [account, statusFilter],
  );

  useEffect(() => {
    if (hydratedFromQueryRef.current) {
      return;
    }
    hydratedFromQueryRef.current = true;

    const queryTicket = searchParams.get('ticket');
    if (queryTicket) {
      setSelectedTicketId(queryTicket);
    }

    const querySubject = searchParams.get('subject');
    const queryBody = searchParams.get('body');
    const queryCategory = searchParams.get('category') ?? searchParams.get('type');
    const queryServerId = searchParams.get('serverId');
    const normalizedCategory = CATEGORY_OPTIONS.some((item) => item.value === queryCategory)
      ? queryCategory
      : undefined;

    if (querySubject) {
      setMemberSubject(querySubject);
      setGuestSubject(querySubject);
    }
    if (queryBody) {
      setMemberBody(queryBody);
      setGuestBody(queryBody);
    }
    if (normalizedCategory) {
      setMemberCategory(normalizedCategory);
      setGuestCategory(normalizedCategory);
    }
    if (queryServerId) {
      setMemberServerId(queryServerId);
      setGuestServerId(queryServerId);
    }
  }, [searchParams]);

  useEffect(() => {
    if (account) {
      setActiveInquiryTab('member');
    }
  }, [account]);

  useEffect(() => {
    if (!pathname || !hydratedFromQueryRef.current) {
      return;
    }

    const params = new URLSearchParams(searchParams.toString());
    let changed = false;
    for (const key of ['subject', 'body', 'category', 'serverId']) {
      if (params.has(key)) {
        params.delete(key);
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  useEffect(() => {
    if (!pathname) {
      return;
    }

    const current = searchParams.get('ticket');
    if ((current ?? null) === selectedTicketId) {
      return;
    }

    const params = new URLSearchParams(searchParams.toString());
    if (selectedTicketId) {
      params.set('ticket', selectedTicketId);
    } else {
      params.delete('ticket');
    }

    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams, selectedTicketId]);

  useEffect(() => {
    let cancelled = false;

    const loadServerList = async () => {
      setServerOptionsLoading(true);
      try {
        const items = await fetchSupportServerOptions();
        if (!cancelled) {
          setServerOptions(items);
        }
      } catch {
        if (!cancelled) {
          setServerOptions([]);
        }
      } finally {
        if (!cancelled) {
          setServerOptionsLoading(false);
        }
      }
    };

    void loadServerList();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authLoading) {
      return;
    }
    void loadTickets(searchParams.get('ticket'));
  }, [authLoading, loadTickets, searchParams]);

  useEffect(() => {
    if (!account || !selectedTicketId) {
      setDetail(null);
      return;
    }

    void loadDetail(selectedTicketId);
  }, [account, loadDetail, selectedTicketId]);

  useEffect(() => {
    if (!account || !autoRefresh) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadTickets(undefined, true);
      if (selectedTicketId) {
        void loadDetail(selectedTicketId, true);
      }
    }, AUTO_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [account, autoRefresh, loadDetail, loadTickets, selectedTicketId]);

  useEffect(() => {
    if (!messageListRef.current) {
      return;
    }
    messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
  }, [detail?.messages.length, selectedTicketId]);

  const filteredTickets = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    return tickets.filter((ticket) => {
      if (statusFilter !== 'all' && ticket.status !== statusFilter) {
        return false;
      }

      if (!keyword) {
        return true;
      }

      const haystack = [
        ticket.subject,
        ticket.requester.displayName,
        ticket.latestMessagePreview ?? '',
        ticket.server?.name ?? '',
        ticket.category ?? '',
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(keyword);
    });
  }, [searchKeyword, statusFilter, tickets]);

  const filteredTopics = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    if (!keyword) {
      return SUPPORT_TOPICS;
    }
    return SUPPORT_TOPICS.filter((topic) =>
      [topic.title, topic.description, topic.detail, topic.category]
        .join(' ')
        .toLowerCase()
        .includes(keyword),
    );
  }, [searchKeyword]);

  const statusCount = useMemo(() => {
    return tickets.reduce<Record<SupportTicketStatus, number>>(
      (acc, ticket) => {
        acc[ticket.status] += 1;
        return acc;
      },
      { open: 0, pending: 0, resolved: 0, closed: 0 },
    );
  }, [tickets]);

  const selectedTicket = useMemo(() => {
    if (detail?.ticket && detail.ticket.id === selectedTicketId) {
      return detail.ticket;
    }
    return tickets.find((ticket) => ticket.id === selectedTicketId) ?? null;
  }, [detail?.ticket, selectedTicketId, tickets]);

  const selectedMessages = detail?.messages ?? [];
  const selectedTicketLabel = selectedTicket ? `#${selectedTicket.id.slice(0, 8)}` : null;
  const canSendMessage = Boolean(
    account &&
      selectedTicket &&
      selectedTicket.status !== 'closed' &&
      selectedTicket.status !== 'resolved',
  );

  const handleSelectTopic = useCallback(
    (category: string) => {
      setMemberCategory(category);
      setGuestCategory(category);
      setActiveInquiryTab(account ? 'member' : 'guest');
      document
        .getElementById('support-request-form')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [account],
  );

  const handleSendMessage = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!selectedTicketId || !canSendMessage) {
        return;
      }

      const body = messageBody.trim();
      if (!body) {
        return;
      }

      setSubmittingMessage(true);
      setError(null);
      try {
        const next = await createSupportMessage(selectedTicketId, {
          body,
          isInternal: false,
        });
        setMessageBody('');
        setDetail(next);
        await loadTickets(next.ticket.id, true);
      } catch (sendError) {
        const message =
          sendError instanceof Error ? sendError.message : '메시지 전송에 실패했습니다.';
        setError(message === 'UNAUTHORIZED' ? '로그인이 필요합니다.' : message);
      } finally {
        setSubmittingMessage(false);
      }
    },
    [canSendMessage, loadTickets, messageBody, selectedTicketId],
  );

  const handleCreateMemberTicket = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const subject = memberSubject.trim();
      const body = memberBody.trim();
      if (!subject || !body) {
        setFormError('제목과 내용을 모두 입력해 주세요.');
        setFormSuccess(null);
        return;
      }

      if (!account) {
        setFormError('회원 문의는 로그인 후 접수할 수 있습니다.');
        setFormSuccess(null);
        return;
      }

      setMemberSubmitting(true);
      setFormError(null);
      setFormSuccess(null);

      try {
        const created = await createSupportTicket({
          subject,
          body,
          category: memberCategory.trim() || undefined,
          priority: memberPriority,
          serverId: memberServerId.trim() || undefined,
        });

        setMemberSubject('');
        setMemberBody('');
        setMemberServerId('');
        setFormSuccess(`문의가 등록되었습니다. 문의 번호: ${created.ticket.id}`);
        setSelectedTicketId(created.ticket.id);
        setDetail(created);
        await loadTickets(created.ticket.id);
      } catch (submitError) {
        const message =
          submitError instanceof Error ? submitError.message : '문의 접수에 실패했습니다.';
        setFormError(message === 'UNAUTHORIZED' ? '로그인이 필요합니다.' : message);
      } finally {
        setMemberSubmitting(false);
      }
    },
    [
      account,
      loadTickets,
      memberBody,
      memberCategory,
      memberPriority,
      memberServerId,
      memberSubject,
    ],
  );

  const handleCreateGuestTicket = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const subject = guestSubject.trim();
      const body = guestBody.trim();
      if (!subject || !body) {
        setFormError('제목과 내용을 모두 입력해 주세요.');
        setFormSuccess(null);
        return;
      }

      if (captchaRequired && !guestCaptchaToken) {
        setFormError('보안 확인을 완료해 주세요.');
        setFormSuccess(null);
        return;
      }

      setGuestSubmitting(true);
      setFormError(null);
      setFormSuccess(null);

      try {
        const created = await createSupportGuestTicket({
          subject,
          body,
          category: guestCategory.trim() || undefined,
          priority: 'normal',
          serverId: guestServerId.trim() || undefined,
          guestName: guestName.trim() || undefined,
          guestEmail: guestEmail.trim() || undefined,
          captchaToken: guestCaptchaToken ?? undefined,
        });

        setGuestName('');
        setGuestEmail('');
        setGuestSubject('');
        setGuestBody('');
        setGuestServerId('');
        setGuestCaptchaToken(null);
        setGuestCaptchaKey((current) => current + 1);

        setFormSuccess(`문의가 접수되었습니다. 문의 번호: ${created.ticketId}`);
      } catch (submitError) {
        const message =
          submitError instanceof Error ? submitError.message : '비회원 문의 접수에 실패했습니다.';
        setFormError(message);
        setGuestCaptchaToken(null);
        setGuestCaptchaKey((current) => current + 1);
      } finally {
        setGuestSubmitting(false);
      }
    },
    [
      guestBody,
      guestCaptchaToken,
      guestCategory,
      guestEmail,
      guestName,
      guestServerId,
      guestSubject,
      captchaRequired,
    ],
  );

  const handleCopyTicketLink = useCallback(async () => {
    if (!selectedTicketId || typeof window === 'undefined') {
      return;
    }

    try {
      const params = new URLSearchParams(window.location.search);
      params.set('ticket', selectedTicketId);
      const url = `${window.location.origin}${pathname}?${params.toString()}`;
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      setCopyState('failed');
      window.setTimeout(() => setCopyState('idle'), 1500);
    }
  }, [pathname, selectedTicketId]);

  return (
    <div className="min-h-screen bg-[#111214] pt-16 text-[#F4F4F5]">
      <main>
        <section className="border-b border-[#2C2D30] bg-[#18191C]">
          <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:px-8">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#13ec80]">고객센터</p>
              <h1 className="mt-3 max-w-3xl text-3xl font-semibold tracking-normal text-white sm:text-4xl">
                서비스 이용 중 발생한 문제를 정확하게 접수하고 처리 현황을 확인하세요.
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-6 text-[#B6B7BA]">
                계정, 서버 등록, 결제, 신고 및 정책 이의 신청을 한 곳에서 접수할 수 있습니다. 회원은
                문의 진행 상황과 답변 내역을 이 화면에서 계속 확인할 수 있습니다.
              </p>

              <div className="mt-6 max-w-2xl rounded-lg border border-[#34363A] bg-[#111214] p-2">
                <label className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-[22px] text-[#85878D]">
                    search
                  </span>
                  <input
                    className="h-11 min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-[#73757C]"
                    placeholder="문의 유형, 제목, 서버명으로 검색"
                    type="search"
                    value={searchKeyword}
                    onChange={(event) => setSearchKeyword(event.target.value)}
                  />
                </label>
              </div>
            </div>

            <div className="rounded-lg border border-[#34363A] bg-[#111214] p-5">
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-[#13ec80]">verified_user</span>
                <div>
                  <h2 className="text-sm font-semibold text-white">처리 기준</h2>
                  <p className="mt-1 text-xs leading-5 text-[#A7A9AF]">
                    운영 정책과 접수 내용을 기준으로 순차 검토합니다. 긴급 사안은 우선순위를 높게
                    선택하고 증빙 정보를 함께 제출해 주세요.
                  </p>
                </div>
              </div>
              <dl className="mt-5 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-md border border-[#2C2D30] bg-[#18191C] px-2 py-3">
                  <dt className="text-[11px] text-[#85878D]">열림</dt>
                  <dd className="mt-1 text-lg font-semibold text-cyan-300">{statusCount.open}</dd>
                </div>
                <div className="rounded-md border border-[#2C2D30] bg-[#18191C] px-2 py-3">
                  <dt className="text-[11px] text-[#85878D]">대기</dt>
                  <dd className="mt-1 text-lg font-semibold text-amber-300">
                    {statusCount.pending}
                  </dd>
                </div>
                <div className="rounded-md border border-[#2C2D30] bg-[#18191C] px-2 py-3">
                  <dt className="text-[11px] text-[#85878D]">해결</dt>
                  <dd className="mt-1 text-lg font-semibold text-emerald-300">
                    {statusCount.resolved}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          {error ? (
            <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              {error}
            </div>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="space-y-6">
              <section className="rounded-lg border border-[#34363A] bg-[#18191C]">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#2C2D30] px-5 py-4">
                  <div>
                    <h2 className="text-base font-semibold text-white">문의 유형</h2>
                    <p className="mt-1 text-xs text-[#A7A9AF]">
                      가장 가까운 유형을 선택하면 접수 양식에 반영됩니다.
                    </p>
                  </div>
                  <button
                    className="inline-flex items-center gap-2 rounded-md border border-[#34363A] px-3 py-2 text-xs text-[#D8D9DC] transition hover:border-[#13ec80]/50 hover:text-white"
                    type="button"
                    onClick={() => {
                      setSearchKeyword('');
                      document.getElementById('support-request-form')?.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start',
                      });
                    }}
                  >
                    <span className="material-symbols-outlined text-[16px]">edit_square</span>
                    직접 문의
                  </button>
                </div>
                <div className="grid gap-3 p-5 sm:grid-cols-2">
                  {filteredTopics.length === 0 ? (
                    <div className="col-span-full rounded-lg border border-dashed border-[#34363A] bg-[#151619] p-5 text-sm text-[#A7A9AF]">
                      검색어와 일치하는 문의 유형이 없습니다. 직접 문의를 선택해 내용을 접수해
                      주세요.
                    </div>
                  ) : (
                    filteredTopics.map((topic) => (
                      <button
                        key={topic.category}
                        className="group rounded-lg border border-[#34363A] bg-[#151619] p-4 text-left transition hover:border-[#13ec80]/50 hover:bg-[#18211D]"
                        type="button"
                        onClick={() => handleSelectTopic(topic.category)}
                      >
                        <div className="flex items-start gap-3">
                          <span className="material-symbols-outlined text-[22px] text-[#13ec80]">
                            {topic.icon}
                          </span>
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-white">{topic.title}</h3>
                            <p className="mt-2 text-xs leading-5 text-[#B6B7BA]">
                              {topic.description}
                            </p>
                            <p className="mt-3 text-[11px] leading-4 text-[#85878D]">
                              {topic.detail}
                            </p>
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </section>

              <section className="rounded-lg border border-[#34363A] bg-[#18191C]">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#2C2D30] px-5 py-4">
                  <div>
                    <h2 className="text-base font-semibold text-white">내 문의 현황</h2>
                    <p className="mt-1 text-xs text-[#A7A9AF]">
                      회원 계정으로 접수한 문의와 답변 내역입니다.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex items-center gap-2 rounded-md border border-[#34363A] px-3 py-2 text-xs text-[#D8D9DC]">
                      <input
                        className="h-4 w-4 rounded border-[#55585F] bg-[#111214]"
                        type="checkbox"
                        checked={autoRefresh}
                        onChange={(event) => setAutoRefresh(event.target.checked)}
                      />
                      자동 갱신
                    </label>
                    <button
                      className="inline-flex items-center gap-2 rounded-md border border-[#34363A] px-3 py-2 text-xs text-[#D8D9DC] transition hover:border-[#13ec80]/50 hover:text-white"
                      type="button"
                      onClick={() => void loadTickets(selectedTicketId)}
                    >
                      <span className="material-symbols-outlined text-[16px]">refresh</span>
                      새로고침
                    </button>
                  </div>
                </div>

                <div className="grid min-h-[520px] lg:grid-cols-[320px_minmax(0,1fr)]">
                  <aside className="border-b border-[#2C2D30] lg:border-b-0 lg:border-r">
                    <div className="space-y-3 border-b border-[#2C2D30] p-4">
                      <div className="flex gap-2 overflow-x-auto pb-1">
                        {STATUS_FILTERS.map((filter) => (
                          <button
                            key={filter.value}
                            className={`shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                              statusFilter === filter.value
                                ? 'border-[#13ec80]/50 bg-[#13ec80]/10 text-[#13ec80]'
                                : 'border-[#34363A] bg-[#151619] text-[#A7A9AF] hover:text-white'
                            }`}
                            type="button"
                            onClick={() => setStatusFilter(filter.value)}
                          >
                            {filter.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="max-h-[460px] overflow-y-auto">
                      {authLoading ? (
                        <TicketListSkeleton />
                      ) : !account ? (
                        <div className="p-5 text-sm text-[#A7A9AF]">
                          <p>로그인하면 접수한 문의의 처리 상태와 답변을 확인할 수 있습니다.</p>
                          <Link
                            className="mt-4 inline-flex rounded-md bg-[#13ec80] px-4 py-2 text-xs font-semibold text-[#101211] transition hover:bg-[#10ce70]"
                            href="/login?returnTo=%2Fsupport"
                          >
                            로그인
                          </Link>
                        </div>
                      ) : listLoading ? (
                        <TicketListSkeleton />
                      ) : filteredTickets.length === 0 ? (
                        <div className="p-5 text-sm text-[#A7A9AF]">
                          <p>표시할 문의가 없습니다.</p>
                          <p className="mt-2 text-xs text-[#85878D]">
                            새 문의를 접수하면 이 영역에서 진행 상태를 확인할 수 있습니다.
                          </p>
                        </div>
                      ) : (
                        filteredTickets.map((ticket) => {
                          const selected = ticket.id === selectedTicketId;
                          return (
                            <button
                              key={ticket.id}
                              className={`w-full border-b border-[#2C2D30] px-4 py-3 text-left transition ${
                                selected ? 'bg-[#1C2A23]' : 'hover:bg-[#202124]'
                              }`}
                              type="button"
                              onClick={() => setSelectedTicketId(ticket.id)}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <span className={statusBadgeClass(ticket.status)}>
                                  {statusLabel(ticket.status)}
                                </span>
                                <span className="text-[11px] text-[#85878D]">
                                  {formatRelativeTime(ticket.lastMessageAt)}
                                </span>
                              </div>
                              <h3 className="mt-2 truncate text-sm font-semibold text-white">
                                {ticket.subject}
                              </h3>
                              <p className="mt-1 truncate text-xs text-[#A7A9AF]">
                                {ticket.latestMessagePreview ?? '아직 등록된 메시지가 없습니다.'}
                              </p>
                              <p className="mt-2 truncate text-[11px] text-[#85878D]">
                                {ticket.server?.name ?? '연결 서버 없음'} ·{' '}
                                {categoryLabel(ticket.category)}
                              </p>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </aside>

                  <section className="flex min-w-0 flex-col">
                    <header className="border-b border-[#2C2D30] p-5">
                      {selectedTicket ? (
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="truncate text-base font-semibold text-white">
                                {selectedTicket.subject}
                              </h3>
                              {selectedTicketLabel ? (
                                <span className="rounded border border-[#34363A] bg-[#151619] px-2 py-1 text-[11px] text-[#A7A9AF]">
                                  {selectedTicketLabel}
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-2 text-xs text-[#A7A9AF]">
                              {selectedTicket.server?.name ?? '연결 서버 없음'} ·{' '}
                              {categoryLabel(selectedTicket.category)} ·{' '}
                              {formatDate(selectedTicket.createdAt)}
                            </p>
                          </div>
                          <button
                            className="inline-flex items-center gap-2 rounded-md border border-[#34363A] px-3 py-2 text-xs text-[#D8D9DC] transition hover:border-[#13ec80]/50 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                            type="button"
                            disabled={!selectedTicketId}
                            onClick={() => void handleCopyTicketLink()}
                          >
                            <span className="material-symbols-outlined text-[16px]">
                              content_copy
                            </span>
                            {copyState === 'copied'
                              ? '복사됨'
                              : copyState === 'failed'
                                ? '복사 실패'
                                : '링크 복사'}
                          </button>
                        </div>
                      ) : (
                        <div>
                          <h3 className="text-base font-semibold text-white">문의 상세</h3>
                          <p className="mt-2 text-xs text-[#A7A9AF]">
                            목록에서 문의를 선택하면 상세 내용이 표시됩니다.
                          </p>
                        </div>
                      )}
                    </header>

                    <div
                      ref={messageListRef}
                      className="min-h-[300px] flex-1 space-y-4 overflow-y-auto p-5"
                    >
                      {detailLoading ? (
                        <MessageSkeleton />
                      ) : selectedTicket ? (
                        selectedMessages.length === 0 ? (
                          <EmptyPanel
                            icon="forum"
                            title="등록된 메시지가 없습니다."
                            description="문의가 생성되었지만 아직 대화 내역이 없습니다. 추가 정보가 있으면 아래 답변란에 남겨 주세요."
                          />
                        ) : (
                          selectedMessages.map((message) => {
                            if (message.authorRole === 'system') {
                              return (
                                <div key={message.id} className="flex items-center gap-3 py-2">
                                  <div className="h-px flex-1 bg-[#34363A]" />
                                  <span className="text-[11px] text-[#85878D]">{message.body}</span>
                                  <div className="h-px flex-1 bg-[#34363A]" />
                                </div>
                              );
                            }

                            const isAgent = message.authorRole === 'agent';

                            return (
                              <article
                                key={message.id}
                                className={`flex gap-3 ${isAgent ? 'flex-row-reverse' : ''}`}
                              >
                                <div
                                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                                    isAgent
                                      ? 'bg-[#13ec80] text-[#101211]'
                                      : 'bg-[#2B4C7E] text-white'
                                  }`}
                                >
                                  {isAgent ? (
                                    <span className="material-symbols-outlined text-[18px]">
                                      support_agent
                                    </span>
                                  ) : (
                                    displayInitial(message.authorDisplayName)
                                  )}
                                </div>
                                <div
                                  className={`min-w-0 max-w-[82%] ${isAgent ? 'text-right' : ''}`}
                                >
                                  <div
                                    className={`mb-1 flex items-center gap-2 ${isAgent ? 'justify-end' : ''}`}
                                  >
                                    <span className="text-xs font-semibold text-white">
                                      {message.authorDisplayName}
                                    </span>
                                    <span className="text-[11px] text-[#85878D]">
                                      {formatTime(message.createdAt)}
                                    </span>
                                  </div>
                                  <div
                                    className={`rounded-lg border px-4 py-3 text-left text-sm leading-6 ${
                                      isAgent
                                        ? 'border-[#13ec80]/30 bg-[#13251c] text-[#F3FFF8]'
                                        : 'border-[#34363A] bg-[#151619] text-[#E8E9EC]'
                                    }`}
                                  >
                                    <p className="whitespace-pre-wrap break-words">
                                      {message.body}
                                    </p>
                                  </div>
                                </div>
                              </article>
                            );
                          })
                        )
                      ) : (
                        <EmptyPanel
                          icon="mark_chat_unread"
                          title="선택된 문의가 없습니다."
                          description="문의 내역을 선택하거나 새 문의를 접수해 주세요."
                        />
                      )}
                    </div>

                    <form
                      className="border-t border-[#2C2D30] p-5"
                      onSubmit={(event) => void handleSendMessage(event)}
                    >
                      <textarea
                        className="min-h-[96px] w-full resize-y rounded-lg border border-[#34363A] bg-[#111214] px-4 py-3 text-sm leading-6 text-white outline-none placeholder:text-[#73757C] focus:border-[#13ec80]/60 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={!canSendMessage || submittingMessage}
                        placeholder={
                          canSendMessage
                            ? '추가 답변을 입력해 주세요. 운영팀에 즉시 전달됩니다.'
                            : selectedTicket &&
                                (selectedTicket.status === 'resolved' ||
                                  selectedTicket.status === 'closed')
                              ? '해결 또는 종료된 문의에는 답변을 추가할 수 없습니다.'
                              : '로그인 후 열린 문의에 답변할 수 있습니다.'
                        }
                        value={messageBody}
                        onChange={(event) => setMessageBody(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                          }
                        }}
                      />
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                        <p className="text-xs text-[#85878D]">
                          Ctrl 또는 Command + Enter로 전송할 수 있습니다.
                        </p>
                        <button
                          className="inline-flex items-center gap-2 rounded-md bg-[#13ec80] px-4 py-2 text-sm font-semibold text-[#101211] transition hover:bg-[#10ce70] disabled:cursor-not-allowed disabled:opacity-60"
                          type="submit"
                          disabled={!canSendMessage || submittingMessage || !messageBody.trim()}
                        >
                          {submittingMessage ? '전송 중' : '답변 전송'}
                          <span className="material-symbols-outlined text-[16px]">send</span>
                        </button>
                      </div>
                    </form>
                  </section>
                </div>
              </section>
            </div>

            <aside className="space-y-6">
              <section
                id="support-request-form"
                className="scroll-mt-24 rounded-lg border border-[#34363A] bg-[#18191C]"
              >
                <div className="border-b border-[#2C2D30] px-5 py-4">
                  <h2 className="text-base font-semibold text-white">문의 접수</h2>
                  <p className="mt-1 text-xs leading-5 text-[#A7A9AF]">
                    정확한 확인을 위해 제목, 발생 경위, 관련 서버를 가능한 범위에서 작성해 주세요.
                  </p>
                </div>

                <div className="grid grid-cols-2 border-b border-[#2C2D30]">
                  <button
                    className={`border-b-2 px-4 py-3 text-sm font-medium transition ${
                      activeInquiryTab === 'member'
                        ? 'border-[#13ec80] bg-[#13251c] text-[#13ec80]'
                        : 'border-transparent text-[#A7A9AF] hover:text-white'
                    }`}
                    onClick={() => setActiveInquiryTab('member')}
                    type="button"
                  >
                    회원 문의
                  </button>
                  <button
                    className={`border-b-2 px-4 py-3 text-sm font-medium transition ${
                      activeInquiryTab === 'guest'
                        ? 'border-[#13ec80] bg-[#13251c] text-[#13ec80]'
                        : 'border-transparent text-[#A7A9AF] hover:text-white'
                    }`}
                    onClick={() => setActiveInquiryTab('guest')}
                    type="button"
                  >
                    비회원 문의
                  </button>
                </div>

                {formSuccess ? (
                  <div className="mx-5 mt-5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-100">
                    {formSuccess}
                  </div>
                ) : null}
                {formError ? (
                  <div className="mx-5 mt-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-100">
                    {formError}
                  </div>
                ) : null}

                <div className={activeInquiryTab === 'member' ? 'block' : 'hidden'}>
                  {!account ? (
                    <div className="p-5">
                      <div className="rounded-lg border border-[#34363A] bg-[#151619] p-5 text-center">
                        <span className="material-symbols-outlined text-3xl text-[#13ec80]">
                          lock
                        </span>
                        <h3 className="mt-3 text-sm font-semibold text-white">
                          로그인 후 접수할 수 있습니다.
                        </h3>
                        <p className="mt-2 text-xs leading-5 text-[#A7A9AF]">
                          회원 문의는 진행 상태와 답변 내역을 고객센터에서 계속 확인할 수 있습니다.
                        </p>
                        <Link
                          className="mt-4 inline-flex rounded-md bg-[#13ec80] px-4 py-2 text-xs font-semibold text-[#101211] transition hover:bg-[#10ce70]"
                          href="/login?returnTo=%2Fsupport"
                        >
                          로그인
                        </Link>
                      </div>
                    </div>
                  ) : (
                    <form
                      className="space-y-4 p-5"
                      onSubmit={(event) => void handleCreateMemberTicket(event)}
                    >
                      <SupportTextInput
                        label="제목"
                        placeholder="문의 내용을 간단히 요약해 주세요."
                        value={memberSubject}
                        onChange={setMemberSubject}
                      />
                      <SupportSelect
                        label="문의 유형"
                        value={memberCategory}
                        onChange={setMemberCategory}
                        options={CATEGORY_OPTIONS}
                      />
                      <SupportServerSelect
                        label="관련 서버"
                        value={memberServerId}
                        onChange={setMemberServerId}
                        servers={serverOptions}
                        loading={serverOptionsLoading}
                      />
                      <SupportSelect
                        label="우선순위"
                        value={memberPriority}
                        onChange={(value) => setMemberPriority(value as TicketPriority)}
                        options={PRIORITY_OPTIONS}
                      />
                      <SupportTextarea
                        label="문의 내용"
                        placeholder="발생 시각, 오류 문구, 재현 절차, 요청하시는 조치를 구체적으로 작성해 주세요."
                        value={memberBody}
                        onChange={setMemberBody}
                      />
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs text-[#85878D]">
                          서버 목록 {serverOptionsLoading ? '확인 중' : `${serverOptions.length}개`}
                        </p>
                        <button
                          className="rounded-md bg-[#13ec80] px-4 py-2 text-sm font-semibold text-[#101211] transition hover:bg-[#10ce70] disabled:cursor-not-allowed disabled:opacity-60"
                          type="submit"
                          disabled={memberSubmitting}
                        >
                          {memberSubmitting ? '접수 중' : '문의 접수'}
                        </button>
                      </div>
                    </form>
                  )}
                </div>

                <div className={activeInquiryTab === 'guest' ? 'block' : 'hidden'}>
                  <form
                    className="space-y-4 p-5"
                    onSubmit={(event) => void handleCreateGuestTicket(event)}
                  >
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                      <SupportTextInput
                        label="이름"
                        placeholder="선택 입력"
                        value={guestName}
                        onChange={setGuestName}
                      />
                      <SupportTextInput
                        label="회신 이메일"
                        placeholder="선택 입력"
                        type="email"
                        value={guestEmail}
                        onChange={setGuestEmail}
                      />
                    </div>
                    <SupportTextInput
                      label="제목"
                      placeholder="문의 내용을 간단히 요약해 주세요."
                      value={guestSubject}
                      onChange={setGuestSubject}
                    />
                    <SupportSelect
                      label="문의 유형"
                      value={guestCategory}
                      onChange={setGuestCategory}
                      options={CATEGORY_OPTIONS}
                    />
                    <SupportServerSelect
                      label="관련 서버"
                      value={guestServerId}
                      onChange={setGuestServerId}
                      servers={serverOptions}
                      loading={serverOptionsLoading}
                    />
                    <SupportTextarea
                      label="문의 내용"
                      placeholder="비회원 문의는 회신 정보가 없으면 추가 확인이 어려울 수 있습니다. 필요한 정보를 충분히 작성해 주세요."
                      value={guestBody}
                      onChange={setGuestBody}
                    />

                    {captchaMode !== 'none' ? (
                      <div className="space-y-3 rounded-lg border border-dashed border-[#34363A] bg-[#111214] p-3">
                        <div>
                          <p className="text-xs font-medium text-[#D8D9DC]">보안 확인</p>
                          <p className="mt-1 text-[11px] leading-4 text-[#85878D]">
                            위젯이 표시되지 않으면 잠시 후 다시 시도해 주세요.
                          </p>
                        </div>
                        {captchaMode === 'turnstile' && turnstileSiteKey ? (
                          <Turnstile
                            key={`support-guest-turnstile-${guestCaptchaKey}`}
                            siteKey={turnstileSiteKey}
                            onSuccess={(token) => setGuestCaptchaToken(token)}
                            onExpire={() => setGuestCaptchaToken(null)}
                            options={{ theme: 'dark' }}
                          />
                        ) : null}
                        {captchaMode === 'hcaptcha' && hcaptchaSiteKey ? (
                          <HCaptcha
                            key={`support-guest-hcaptcha-${guestCaptchaKey}`}
                            sitekey={hcaptchaSiteKey}
                            theme="dark"
                            onVerify={(token) => setGuestCaptchaToken(token)}
                            onExpire={() => setGuestCaptchaToken(null)}
                          />
                        ) : null}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-[#34363A] bg-[#111214] p-4 text-xs leading-5 text-[#A7A9AF]">
                        현재 환경에서는 추가 보안 확인 없이 접수됩니다.
                      </div>
                    )}

                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-[#85878D]">
                        서버 목록 {serverOptionsLoading ? '확인 중' : `${serverOptions.length}개`}
                      </p>
                      <button
                        className="rounded-md bg-[#13ec80] px-4 py-2 text-sm font-semibold text-[#101211] transition hover:bg-[#10ce70] disabled:cursor-not-allowed disabled:opacity-60"
                        type="submit"
                        disabled={guestSubmitting}
                      >
                        {guestSubmitting ? '접수 중' : '비회원 접수'}
                      </button>
                    </div>
                  </form>
                </div>
              </section>

              <section className="rounded-lg border border-[#34363A] bg-[#18191C] p-5">
                <h2 className="text-sm font-semibold text-white">작성 전 확인 사항</h2>
                <ul className="mt-4 space-y-3 text-xs leading-5 text-[#A7A9AF]">
                  <li className="flex gap-2">
                    <span className="material-symbols-outlined mt-0.5 text-[16px] text-[#13ec80]">
                      check_circle
                    </span>
                    서버 관련 문의는 서버명 또는 접속 주소를 함께 남겨 주세요.
                  </li>
                  <li className="flex gap-2">
                    <span className="material-symbols-outlined mt-0.5 text-[16px] text-[#13ec80]">
                      check_circle
                    </span>
                    신고 및 이의 신청은 관련 정책 조항과 증빙을 기준으로 검토됩니다.
                  </li>
                  <li className="flex gap-2">
                    <span className="material-symbols-outlined mt-0.5 text-[16px] text-[#13ec80]">
                      check_circle
                    </span>
                    비회원 문의는 문의 번호를 보관해야 추후 확인이 가능합니다.
                  </li>
                </ul>
              </section>
            </aside>
          </div>
        </section>
      </main>
    </div>
  );
}

function TicketListSkeleton() {
  return (
    <div className="space-y-3 p-4">
      {[0, 1, 2].map((item) => (
        <div key={item} className="rounded-lg border border-[#2C2D30] bg-[#151619] p-4">
          <div className="h-3 w-20 animate-pulse rounded bg-[#2C2D30]" />
          <div className="mt-3 h-4 w-4/5 animate-pulse rounded bg-[#2C2D30]" />
          <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-[#2C2D30]" />
        </div>
      ))}
    </div>
  );
}

function MessageSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-20 w-3/4 animate-pulse rounded-lg bg-[#202124]" />
      <div className="ml-auto h-24 w-2/3 animate-pulse rounded-lg bg-[#202124]" />
      <div className="h-16 w-1/2 animate-pulse rounded-lg bg-[#202124]" />
    </div>
  );
}

function EmptyPanel(props: {
  readonly icon: string;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="flex min-h-[220px] items-center justify-center rounded-lg border border-dashed border-[#34363A] bg-[#151619] p-6 text-center">
      <div className="max-w-sm">
        <span className="material-symbols-outlined text-3xl text-[#85878D]">{props.icon}</span>
        <h3 className="mt-3 text-sm font-semibold text-white">{props.title}</h3>
        <p className="mt-2 text-xs leading-5 text-[#A7A9AF]">{props.description}</p>
      </div>
    </div>
  );
}

function SupportTextInput(props: {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: 'text' | 'email';
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-[#D8D9DC]">{props.label}</span>
      <input
        className="mt-1 h-10 w-full rounded-md border border-[#34363A] bg-[#111214] px-3 text-sm text-white outline-none placeholder:text-[#73757C] focus:border-[#13ec80]/60"
        placeholder={props.placeholder}
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function SupportTextarea(props: {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-[#D8D9DC]">{props.label}</span>
      <textarea
        className="mt-1 min-h-[132px] w-full resize-y rounded-md border border-[#34363A] bg-[#111214] px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-[#73757C] focus:border-[#13ec80]/60"
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function SupportSelect(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-[#D8D9DC]">{props.label}</span>
      <select
        className="mt-1 h-10 w-full rounded-md border border-[#34363A] bg-[#111214] px-3 text-sm text-white outline-none focus:border-[#13ec80]/60"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SupportServerSelect(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly servers: SupportServerOption[];
  readonly loading: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-[#D8D9DC]">{props.label}</span>
      <select
        className="mt-1 h-10 w-full rounded-md border border-[#34363A] bg-[#111214] px-3 text-sm text-white outline-none focus:border-[#13ec80]/60"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        <option value="">{props.loading ? '서버 목록 확인 중' : '선택하지 않음'}</option>
        {props.servers.map((server) => (
          <option key={server.id} value={server.id}>
            {server.name} ({server.joinHost})
          </option>
        ))}
      </select>
    </label>
  );
}

function statusLabel(status: SupportTicketStatus): string {
  if (status === 'open') {
    return '열림';
  }
  if (status === 'pending') {
    return '대기';
  }
  if (status === 'resolved') {
    return '해결';
  }
  return '종료';
}

function statusBadgeClass(status: SupportTicketStatus): string {
  const base = 'shrink-0 rounded border px-2 py-1 text-[11px] font-medium';
  if (status === 'open') {
    return `${base} border-cyan-500/30 bg-cyan-500/10 text-cyan-300`;
  }
  if (status === 'pending') {
    return `${base} border-amber-500/30 bg-amber-500/10 text-amber-300`;
  }
  if (status === 'resolved') {
    return `${base} border-emerald-500/30 bg-emerald-500/10 text-emerald-300`;
  }
  return `${base} border-[#4B4D52] bg-[#202124] text-[#B6B7BA]`;
}

function categoryLabel(value: string | null | undefined): string {
  if (!value) {
    return '일반 문의';
  }
  return CATEGORY_OPTIONS.find((item) => item.value === value)?.label ?? value;
}

function displayInitial(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '?';
  }
  return trimmed.charAt(0).toUpperCase();
}

function formatDate(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return '-';
  }
  return new Date(parsed).toLocaleDateString('ko-KR');
}

function formatTime(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return '-';
  }
  return new Date(parsed).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRelativeTime(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return '-';
  }

  const diff = Date.now() - parsed;
  if (diff < 60_000) {
    return '방금 전';
  }
  if (diff < 3_600_000) {
    return `${Math.max(1, Math.floor(diff / 60_000))}분 전`;
  }
  if (diff < 86_400_000) {
    return `${Math.max(1, Math.floor(diff / 3_600_000))}시간 전`;
  }
  return `${Math.max(1, Math.floor(diff / 86_400_000))}일 전`;
}

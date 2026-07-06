'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createSupportGuestTicket,
  createSupportMessage,
  createSupportTicket,
  fetchSupportAgentState,
  fetchSupportServerOptions,
  fetchSupportTicketDetail,
  fetchSupportTickets,
  type SupportServerOption,
  updateSupportTicket,
  type SupportTicket,
  type SupportTicketDetail,
  type SupportTicketStatus,
} from '../../lib/support-api';
import { useAuth } from '../providers/auth-context';

type CenterMode = 'customer' | 'agent';
type TicketView = 'mine' | 'assigned' | 'inbox';
type TicketStatusFilter = 'all' | SupportTicketStatus;
type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

const AUTO_REFRESH_INTERVAL_MS = 20_000;

const STATUS_OPTIONS: ReadonlyArray<{
  value: SupportTicketStatus;
  label: string;
}> = [
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

const VIEW_OPTIONS: ReadonlyArray<{ value: TicketView; label: string }> = [
  { value: 'inbox', label: '전체 인박스' },
  { value: 'assigned', label: '내 배정' },
  { value: 'mine', label: '내 문의' },
];

const QUICK_CATEGORIES = [
  'account',
  'minecraft_verify',
  'discord_guild',
  'server_claim',
  'wiki_edit',
  'plugin_sync',
  'file_upload',
];

const QUICK_AGENT_REPLIES = [
  '안녕하세요. 문의 접수되었습니다. 확인 후 안내드리겠습니다.',
  '추가 확인을 위해 발생 시각/서버 ID/오류 메시지를 보내주세요.',
  '재현 가능한 절차를 전달해 주시면 우선 처리하겠습니다.',
];

const Turnstile = dynamic(
  () => import('@marsidev/react-turnstile').then((mod) => mod.Turnstile),
  {
    ssr: false,
    loading: () => <div className="h-20 w-full animate-pulse rounded-xl bg-[#161618]" />,
  },
);

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

interface SupportCenterProps {
  readonly mode: CenterMode;
}

export function SupportCenter({ mode }: SupportCenterProps) {
  const { account, loading: authLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const hydratedFromQueryRef = useRef(false);
  const messageListRef = useRef<HTMLDivElement | null>(null);

  const [isAgent, setIsAgent] = useState<boolean>(false);
  const [agentLoading, setAgentLoading] = useState(mode === 'agent');

  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submittingTicket, setSubmittingTicket] = useState(false);
  const [submittingMessage, setSubmittingMessage] = useState(false);
  const [updatingTicket, setUpdatingTicket] = useState(false);

  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SupportTicketDetail | null>(null);
  const [serverOptions, setServerOptions] = useState<SupportServerOption[]>([]);
  const [serverOptionsLoading, setServerOptionsLoading] = useState(false);

  const [view, setView] = useState<TicketView>(mode === 'agent' ? 'inbox' : 'mine');
  const [statusFilter, setStatusFilter] = useState<TicketStatusFilter>('all');
  const [ticketSearch, setTicketSearch] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [ticketSubject, setTicketSubject] = useState('');
  const [ticketBody, setTicketBody] = useState('');
  const [ticketCategory, setTicketCategory] = useState('account');
  const [ticketPriority, setTicketPriority] = useState<TicketPriority>('normal');
  const [ticketServerId, setTicketServerId] = useState('');
  const [ticketPageId, setTicketPageId] = useState('');
  const [ticketVerifySessionId, setTicketVerifySessionId] = useState('');
  const [ticketPluginServerId, setTicketPluginServerId] = useState('');
  const [ticketFileId, setTicketFileId] = useState('');

  const [messageBody, setMessageBody] = useState('');
  const [messageInternal, setMessageInternal] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestCaptchaToken, setGuestCaptchaToken] = useState<string | null>(null);
  const [guestCaptchaKey, setGuestCaptchaKey] = useState(0);
  const [guestSubmitting, setGuestSubmitting] = useState(false);
  const [guestSuccessTicketId, setGuestSuccessTicketId] = useState<string | null>(null);
  const [guestError, setGuestError] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const turnstileSiteKey = normalizeSiteKey(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);

  const requiresAgent = mode === 'agent';
  const returnTo = mode === 'agent' ? '/dashboard/support' : '/support';

  const loadDetail = useCallback(
    async (ticketId: string, silent = false) => {
      if (!silent) {
        setDetailLoading(true);
        setError(null);
      }
      try {
        const payload = await fetchSupportTicketDetail(ticketId);
        setDetail(payload);
      } catch (detailError) {
        if (!silent) {
          setError((detailError as Error).message);
          setDetail(null);
        }
      } finally {
        if (!silent) {
          setDetailLoading(false);
        }
      }
    },
    [],
  );

  const loadTickets = useCallback(
    async (preferredTicketId?: string | null) => {
      if (!account) {
        setTickets([]);
        setSelectedTicketId(null);
        setDetail(null);
        return;
      }

      setListLoading(true);
      setError(null);
      try {
        const response = await fetchSupportTickets({
          view: requiresAgent ? view : 'mine',
          status: statusFilter === 'all' ? undefined : statusFilter,
        });

        const nextTickets = response.items;
        setTickets(nextTickets);

        const candidate = preferredTicketId ?? selectedTicketId;
        const nextSelection =
          candidate && nextTickets.some((ticket) => ticket.id === candidate)
            ? candidate
            : nextTickets[0]?.id ?? null;

        setSelectedTicketId(nextSelection);
      } catch (loadError) {
        setError((loadError as Error).message);
      } finally {
        setListLoading(false);
      }
    },
    [account, requiresAgent, selectedTicketId, statusFilter, view],
  );

  useEffect(() => {
    if (hydratedFromQueryRef.current) {
      return;
    }
    hydratedFromQueryRef.current = true;

    const queryTicket = searchParams.get('ticket');
    const querySubject = searchParams.get('subject');
    const queryBody = searchParams.get('body');
    const queryCategory = searchParams.get('category');
    const queryServerId = searchParams.get('serverId');
    const queryPageId = searchParams.get('pageId');
    const queryVerifySessionId = searchParams.get('verifySessionId');
    const queryPluginServerId = searchParams.get('pluginServerId');
    const queryFileId = searchParams.get('fileId');

    if (queryTicket) {
      setSelectedTicketId(queryTicket);
    }
    if (querySubject) {
      setTicketSubject(querySubject);
    }
    if (queryBody) {
      setTicketBody(queryBody);
    }
    if (queryCategory) {
      setTicketCategory(queryCategory);
    }
    if (queryServerId) {
      setTicketServerId(queryServerId);
    }
    if (queryPageId) {
      setTicketPageId(queryPageId);
    }
    if (queryVerifySessionId) {
      setTicketVerifySessionId(queryVerifySessionId);
    }
    if (queryPluginServerId) {
      setTicketPluginServerId(queryPluginServerId);
    }
    if (queryFileId) {
      setTicketFileId(queryFileId);
    }
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    const loadServerOptions = async () => {
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

    void loadServerOptions();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!pathname || !hydratedFromQueryRef.current) {
      return;
    }

    const params = new URLSearchParams(searchParams.toString());
    let changed = false;
    for (const key of [
      'subject',
      'body',
      'category',
      'serverId',
      'pageId',
      'verifySessionId',
      'pluginServerId',
      'fileId',
    ]) {
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
    const next = selectedTicketId;
    if ((current ?? null) === next) {
      return;
    }

    const params = new URLSearchParams(searchParams.toString());
    if (next) {
      params.set('ticket', next);
    } else {
      params.delete('ticket');
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams, selectedTicketId]);

  useEffect(() => {
    if (authLoading) {
      return;
    }

    if (!account) {
      setAgentLoading(false);
      setIsAgent(false);
      setTickets([]);
      setSelectedTicketId(null);
      setDetail(null);
      return;
    }

    let cancelled = false;
    const initialize = async () => {
      if (requiresAgent) {
        setAgentLoading(true);
        try {
          const agentState = await fetchSupportAgentState();
          if (cancelled) {
            return;
          }
          setIsAgent(agentState.isAgent);
          if (!agentState.isAgent) {
            setTickets([]);
            setSelectedTicketId(null);
            setDetail(null);
            return;
          }
        } catch (initError) {
          if (!cancelled) {
            setError((initError as Error).message);
          }
          return;
        } finally {
          if (!cancelled) {
            setAgentLoading(false);
          }
        }
      } else {
        setIsAgent(false);
      }

      if (!cancelled) {
        await loadTickets(searchParams.get('ticket'));
      }
    };

    void initialize();
    return () => {
      cancelled = true;
    };
  }, [account, authLoading, loadTickets, requiresAgent, searchParams]);

  useEffect(() => {
    if (!selectedTicketId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedTicketId);
  }, [loadDetail, selectedTicketId]);

  useEffect(() => {
    if (!account || (requiresAgent && !isAgent)) {
      return;
    }
    void loadTickets();
  }, [account, isAgent, loadTickets, requiresAgent, statusFilter, view]);

  useEffect(() => {
    if (!autoRefresh || !account || (requiresAgent && !isAgent)) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadTickets(selectedTicketId);
      if (selectedTicketId) {
        void loadDetail(selectedTicketId, true);
      }
    }, AUTO_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [account, autoRefresh, isAgent, loadDetail, loadTickets, requiresAgent, selectedTicketId]);

  useEffect(() => {
    if (!messageListRef.current) {
      return;
    }
    messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
  }, [detail?.messages.length, selectedTicketId]);

  const selectedTicket = useMemo(() => {
    if (!detail) {
      return null;
    }
    return detail.ticket;
  }, [detail]);

  const filteredTickets = useMemo(() => {
    const keyword = ticketSearch.trim().toLowerCase();
    if (!keyword) {
      return tickets;
    }

    return tickets.filter((ticket) => {
      const haystack = [
        ticket.subject,
        ticket.requester.displayName,
        ticket.server?.name ?? '',
        ticket.category ?? '',
        ticket.latestMessagePreview ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(keyword);
    });
  }, [ticketSearch, tickets]);

  const statusCount = useMemo(() => {
    return tickets.reduce<Record<SupportTicketStatus, number>>(
      (acc, ticket) => {
        acc[ticket.status] += 1;
        return acc;
      },
      { open: 0, pending: 0, resolved: 0, closed: 0 },
    );
  }, [tickets]);

  const ticketServerOptions = useMemo(() => {
    if (!ticketServerId) {
      return serverOptions;
    }
    const exists = serverOptions.some((server) => server.id === ticketServerId);
    if (exists) {
      return serverOptions;
    }
    return [
      {
        id: ticketServerId,
        name: '직접 지정 서버',
        joinHost: '-',
        edition: 'java',
      },
      ...serverOptions,
    ];
  }, [serverOptions, ticketServerId]);

  const handleCreateTicket = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const subject = ticketSubject.trim();
    const body = ticketBody.trim();
    if (!subject || !body) {
      setError('제목과 내용을 모두 입력해 주세요.');
      return;
    }

    setSubmittingTicket(true);
    setError(null);
    try {
      const created = await createSupportTicket({
        subject,
        body,
        category: ticketCategory.trim() || undefined,
        priority: ticketPriority,
        serverId: ticketServerId.trim() ? ticketServerId.trim() : undefined,
        pageId: ticketPageId.trim() || undefined,
        verifySessionId: ticketVerifySessionId.trim() || undefined,
        pluginServerId: ticketPluginServerId.trim() || undefined,
        fileId: ticketFileId.trim() || undefined,
      });

      setTicketSubject('');
      setTicketBody('');
      setTicketServerId('');
      setTicketPageId('');
      setTicketVerifySessionId('');
      setTicketPluginServerId('');
      setTicketFileId('');
      setDetail(created);
      setSelectedTicketId(created.ticket.id);
      await loadTickets(created.ticket.id);
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setSubmittingTicket(false);
    }
  };

  const handleCreateGuestTicket = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const subject = ticketSubject.trim();
    const body = ticketBody.trim();
    if (!subject || !body) {
      setGuestError('제목과 내용을 모두 입력해 주세요.');
      return;
    }
    if (turnstileSiteKey && !guestCaptchaToken) {
      setGuestError('Turnstile 확인을 완료해 주세요.');
      return;
    }

    setGuestSubmitting(true);
    setGuestError(null);
    setGuestSuccessTicketId(null);

    try {
      const result = await createSupportGuestTicket({
        subject,
        body,
        category: ticketCategory.trim() || undefined,
        priority: ticketPriority,
        serverId: ticketServerId.trim() ? ticketServerId.trim() : undefined,
        pageId: ticketPageId.trim() || undefined,
        verifySessionId: ticketVerifySessionId.trim() || undefined,
        pluginServerId: ticketPluginServerId.trim() || undefined,
        fileId: ticketFileId.trim() || undefined,
        guestName: guestName.trim() || undefined,
        guestEmail: guestEmail.trim() || undefined,
        captchaToken: guestCaptchaToken ?? undefined,
      });

      setTicketSubject('');
      setTicketBody('');
      setTicketServerId('');
      setTicketPageId('');
      setTicketVerifySessionId('');
      setTicketPluginServerId('');
      setTicketFileId('');
      setGuestName('');
      setGuestEmail('');
      setGuestCaptchaToken(null);
      setGuestCaptchaKey((current) => current + 1);
      setGuestSuccessTicketId(result.ticketId);
    } catch (submitError) {
      setGuestError((submitError as Error).message);
      setGuestCaptchaToken(null);
      setGuestCaptchaKey((current) => current + 1);
    } finally {
      setGuestSubmitting(false);
    }
  };

  const handleSendMessage = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedTicketId) {
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
        isInternal: isAgent ? messageInternal : false,
      });
      setMessageBody('');
      setMessageInternal(false);
      setDetail(next);
      await loadTickets(next.ticket.id);
    } catch (sendError) {
      setError((sendError as Error).message);
    } finally {
      setSubmittingMessage(false);
    }
  };

  const handleUpdateTicket = async (patch: {
    status?: SupportTicketStatus;
    priority?: TicketPriority;
    assigneeAccountId?: string | null;
  }) => {
    if (!selectedTicketId) {
      return;
    }

    setUpdatingTicket(true);
    setError(null);
    try {
      const updated = await updateSupportTicket(selectedTicketId, patch);
      setDetail(updated);
      await loadTickets(updated.ticket.id);
    } catch (updateError) {
      setError((updateError as Error).message);
    } finally {
      setUpdatingTicket(false);
    }
  };

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
      window.setTimeout(() => setCopyState('idle'), 1600);
    } catch {
      setCopyState('failed');
      window.setTimeout(() => setCopyState('idle'), 1600);
    }
  }, [pathname, selectedTicketId]);

  if (authLoading || agentLoading) {
    return (
      <div className="rounded-xl border border-[#333333] bg-[#1E1E1E] p-6 text-sm text-[#A0A0A0]">
        고객센터를 준비 중입니다...
      </div>
    );
  }

  if (!account) {
    if (requiresAgent) {
      return (
        <div className="space-y-3 rounded-xl border border-[#333333] bg-[#1E1E1E] p-6 text-sm text-[#A0A0A0]">
          <p>고객센터 인박스는 로그인 후 접근할 수 있습니다.</p>
          <Link
            href={`/login?returnTo=${encodeURIComponent(returnTo)}`}
            className="inline-flex rounded-lg bg-[#13ec80] px-4 py-2 text-xs font-semibold text-black transition hover:bg-[#0fb865]"
          >
            로그인하러 가기
          </Link>
        </div>
      );
    }

    return (
      <div className="space-y-4 rounded-xl border border-[#333333] bg-[#1E1E1E] p-6">
        <div>
          <h1 className="text-lg font-bold text-white">비로그인 문의 접수</h1>
          <p className="mt-1 text-xs text-[#A0A0A0]">
            비회원도 문의를 등록할 수 있습니다. 진행 상황 확인은 로그인 후 이용 가능합니다.
          </p>
        </div>

        {guestSuccessTicketId ? (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-200">
            문의가 접수되었습니다. 티켓 ID: <span className="font-semibold">{guestSuccessTicketId}</span>
          </div>
        ) : null}

        {guestError ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-200">
            {guestError}
          </div>
        ) : null}

        <form onSubmit={handleCreateGuestTicket} className="space-y-3">
          <input
            value={ticketSubject}
            onChange={(event) => setTicketSubject(event.target.value)}
            placeholder="문의 제목"
            className="h-10 w-full rounded-lg border border-[#333333] bg-[#161618] px-3 text-sm text-white placeholder:text-[#6b7280]"
          />
          <textarea
            value={ticketBody}
            onChange={(event) => setTicketBody(event.target.value)}
            placeholder="문의 내용을 입력하세요"
            rows={5}
            className="w-full rounded-lg border border-[#333333] bg-[#161618] px-3 py-2 text-sm text-white placeholder:text-[#6b7280]"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <select
              value={ticketServerId}
              onChange={(event) => setTicketServerId(event.target.value)}
              className="h-10 rounded-lg border border-[#333333] bg-[#161618] px-3 text-xs text-white"
            >
              <option value="">연결 서버 선택 안함</option>
              {ticketServerOptions.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name} ({server.joinHost})
                </option>
              ))}
            </select>
            <select
              value={ticketPriority}
              onChange={(event) => setTicketPriority(event.target.value as TicketPriority)}
              className="h-10 rounded-lg border border-[#333333] bg-[#161618] px-3 text-xs text-white"
            >
              {PRIORITY_OPTIONS.map((priority) => (
                <option key={priority.value} value={priority.value}>
                  우선순위: {priority.label}
                </option>
              ))}
            </select>
          </div>
          <input
            value={ticketCategory}
            onChange={(event) => setTicketCategory(event.target.value)}
            placeholder="카테고리 (예: account, plugin_sync)"
            className="h-10 w-full rounded-lg border border-[#333333] bg-[#161618] px-3 text-xs text-white placeholder:text-[#6b7280]"
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              value={guestName}
              onChange={(event) => setGuestName(event.target.value)}
              placeholder="이름 또는 닉네임 (선택)"
              className="h-10 rounded-lg border border-[#333333] bg-[#161618] px-3 text-xs text-white placeholder:text-[#6b7280]"
            />
            <input
              value={guestEmail}
              onChange={(event) => setGuestEmail(event.target.value)}
              placeholder="회신 이메일 (선택)"
              className="h-10 rounded-lg border border-[#333333] bg-[#161618] px-3 text-xs text-white placeholder:text-[#6b7280]"
            />
          </div>

          {turnstileSiteKey ? (
            <div className="rounded-lg border border-[#333333] bg-[#161618] p-2">
              <Turnstile
                key={`support-guest-turnstile-${guestCaptchaKey}`}
                siteKey={turnstileSiteKey}
                onSuccess={(token) => setGuestCaptchaToken(token)}
                onExpire={() => setGuestCaptchaToken(null)}
                options={{ theme: 'dark' }}
              />
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-[#6b7280]">
              서버 목록 {serverOptionsLoading ? '불러오는 중...' : `${ticketServerOptions.length}개`}
            </span>
            <button
              type="submit"
              disabled={guestSubmitting}
              className="rounded-lg bg-[#13ec80] px-4 py-2 text-sm font-semibold text-black transition hover:bg-[#0fb865] disabled:opacity-60"
            >
              {guestSubmitting ? '접수 중...' : '비회원 문의 접수'}
            </button>
          </div>
        </form>

        <div className="border-t border-[#333333] pt-3 text-xs text-[#A0A0A0]">
          문의 내역 확인/추가 답변은 로그인 후 사용 가능합니다.{` `}
          <Link
            href={`/login?returnTo=${encodeURIComponent(returnTo)}`}
            className="text-[#13ec80] hover:underline"
          >
            로그인하러 가기
          </Link>
        </div>
      </div>
    );
  }

  if (requiresAgent && !isAgent) {
    return (
      <div className="space-y-2 rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-200">
        <p>상담원 권한이 없어 인박스에 접근할 수 없습니다.</p>
        <p className="text-xs text-red-300">운영자가 SupportAgent 테이블에 계정을 등록해야 합니다.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#333333] bg-[#1E1E1E] px-4 py-3">
        <div>
          <h1 className="text-lg font-bold text-white">
            {requiresAgent ? '고객센터 인박스' : '고객센터'}
          </h1>
          <p className="text-xs text-[#A0A0A0]">
            {requiresAgent
              ? '상담 티켓을 확인하고 상태를 갱신하세요.'
              : '문의 티켓을 생성하고 진행 상황을 확인하세요.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="inline-flex items-center gap-1 rounded-lg border border-[#333333] bg-[#161618] px-2 py-1.5 text-[#d1d5db]">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
              className="h-4 w-4 rounded border border-[#444] bg-[#111113]"
            />
            자동 새로고침
          </label>

          {requiresAgent ? (
            <select
              value={view}
              onChange={(event) => setView(event.target.value as TicketView)}
              className="rounded-lg border border-[#333333] bg-[#161618] px-2 py-1.5 text-[#d1d5db]"
            >
              {VIEW_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : null}

          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as TicketStatusFilter)}
            className="rounded-lg border border-[#333333] bg-[#161618] px-2 py-1.5 text-[#d1d5db]"
          >
            <option value="all">전체 상태</option>
            {STATUS_OPTIONS.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => void loadTickets(selectedTicketId)}
            className="rounded-lg border border-[#333333] bg-[#232326] px-3 py-1.5 text-[#d1d5db] transition hover:border-[#13ec80]/40 hover:text-white"
          >
            새로고침
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryPill label="열림" value={statusCount.open} tone="open" />
        <SummaryPill label="대기" value={statusCount.pending} tone="pending" />
        <SummaryPill label="해결" value={statusCount.resolved} tone="resolved" />
        <SummaryPill label="종료" value={statusCount.closed} tone="closed" />
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <form
            onSubmit={handleCreateTicket}
            className="space-y-3 rounded-xl border border-[#333333] bg-[#1E1E1E] p-4"
          >
            <h2 className="text-sm font-semibold text-white">새 문의 등록</h2>
            <input
              value={ticketSubject}
              onChange={(event) => setTicketSubject(event.target.value)}
              placeholder="문의 제목"
              className="h-10 w-full rounded-lg border border-[#333333] bg-[#161618] px-3 text-sm text-white placeholder:text-[#6b7280]"
            />
            <textarea
              value={ticketBody}
              onChange={(event) => setTicketBody(event.target.value)}
              placeholder="문의 내용을 입력하세요"
              rows={4}
              className="w-full rounded-lg border border-[#333333] bg-[#161618] px-3 py-2 text-sm text-white placeholder:text-[#6b7280]"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={ticketCategory}
                onChange={(event) => setTicketCategory(event.target.value)}
                placeholder="카테고리 (예: account, server_claim)"
                className="h-10 rounded-lg border border-[#333333] bg-[#161618] px-3 text-xs text-white placeholder:text-[#6b7280]"
              />
              <select
                value={ticketPriority}
                onChange={(event) => setTicketPriority(event.target.value as TicketPriority)}
                className="h-10 rounded-lg border border-[#333333] bg-[#161618] px-3 text-xs text-white"
              >
                {PRIORITY_OPTIONS.map((priority) => (
                  <option key={priority.value} value={priority.value}>
                    우선순위: {priority.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_CATEGORIES.map((category) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => setTicketCategory(category)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                    ticketCategory === category
                      ? 'border-[#13ec80]/40 bg-[#13ec80]/10 text-[#13ec80]'
                      : 'border-[#333333] bg-[#161618] text-[#A0A0A0] hover:text-white'
                  }`}
                >
                  {category}
                </button>
              ))}
            </div>
            <select
              value={ticketServerId}
              onChange={(event) => setTicketServerId(event.target.value)}
              className="h-10 w-full rounded-lg border border-[#333333] bg-[#161618] px-3 text-xs text-white"
            >
              <option value="">연결 서버 선택 안함</option>
              {ticketServerOptions.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name} ({server.joinHost})
                </option>
              ))}
            </select>
            <p className="text-[11px] text-[#6b7280]">
              서버 목록 {serverOptionsLoading ? '불러오는 중...' : `${ticketServerOptions.length}개`}
            </p>
            <button
              type="submit"
              disabled={submittingTicket}
              className="w-full rounded-lg bg-[#13ec80] px-3 py-2 text-sm font-semibold text-black transition hover:bg-[#0fb865] disabled:opacity-60"
            >
              {submittingTicket ? '등록 중...' : '티켓 생성'}
            </button>
          </form>

          <div className="rounded-xl border border-[#333333] bg-[#1E1E1E]">
            <div className="space-y-2 border-b border-[#333333] px-4 py-3">
              <div className="flex items-center justify-between gap-2 text-sm font-semibold text-white">
                <span>티켓 목록</span>
                <span className="text-xs text-[#6b7280]">
                  {filteredTickets.length}/{tickets.length}
                </span>
              </div>
              <input
                value={ticketSearch}
                onChange={(event) => setTicketSearch(event.target.value)}
                placeholder="제목/요청자/내용 검색"
                className="h-9 w-full rounded-lg border border-[#333333] bg-[#161618] px-3 text-xs text-white placeholder:text-[#6b7280]"
              />
            </div>
            <div className="max-h-[500px] overflow-y-auto">
              {listLoading ? (
                <p className="px-4 py-3 text-xs text-[#A0A0A0]">목록을 불러오는 중...</p>
              ) : filteredTickets.length === 0 ? (
                <p className="px-4 py-3 text-xs text-[#A0A0A0]">표시할 티켓이 없습니다.</p>
              ) : (
                filteredTickets.map((ticket) => {
                  const selected = ticket.id === selectedTicketId;
                  return (
                    <button
                      key={ticket.id}
                      type="button"
                      onClick={() => setSelectedTicketId(ticket.id)}
                      className={`w-full border-b border-[#2a2a2d] px-4 py-3 text-left transition ${
                        selected ? 'bg-[#26262a]' : 'hover:bg-[#232326]'
                      }`}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <p className="truncate text-xs font-semibold text-white">{ticket.subject}</p>
                        <span className={statusBadgeClass(ticket.status)}>
                          {statusLabel(ticket.status)}
                        </span>
                      </div>
                      <p className="truncate text-[11px] text-[#A0A0A0]">
                        {ticket.latestMessagePreview ?? '메시지가 없습니다.'}
                      </p>
                      <div className="mt-2 flex items-center justify-between text-[10px] text-[#6b7280]">
                        <span>{ticket.requester.displayName}</span>
                        <span>{formatDateTime(ticket.lastMessageAt)}</span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </aside>

        <section className="rounded-xl border border-[#333333] bg-[#1E1E1E]">
          {!selectedTicketId ? (
            <div className="p-6 text-sm text-[#A0A0A0]">왼쪽 목록에서 티켓을 선택하세요.</div>
          ) : detailLoading || !detail ? (
            <div className="p-6 text-sm text-[#A0A0A0]">티켓 내용을 불러오는 중...</div>
          ) : (
            <>
              <header className="space-y-3 border-b border-[#333333] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-bold text-white">{selectedTicket?.subject}</h2>
                    <p className="mt-1 text-xs text-[#9ca3af]">
                      요청자: {selectedTicket?.requester.displayName}
                      {selectedTicket?.server ? ` · 서버: ${selectedTicket.server.name}` : ''}
                      {selectedTicket?.category ? ` · 분류: ${selectedTicket.category}` : ''}
                    </p>
                    {selectedTicket ? <SupportContextBadges ticket={selectedTicket} /> : null}
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="rounded border border-[#333333] bg-[#161618] px-2 py-1 text-[#9ca3af]">
                      우선순위 {priorityLabel(selectedTicket?.priority ?? 'normal')}
                    </span>
                    <span className={statusBadgeClass(selectedTicket?.status ?? 'open')}>
                      {statusLabel(selectedTicket?.status ?? 'open')}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleCopyTicketLink()}
                      className="rounded border border-[#333333] bg-[#161618] px-2 py-1 text-[#9ca3af] transition hover:border-[#13ec80]/40 hover:text-white"
                    >
                      {copyState === 'copied'
                        ? '복사됨'
                        : copyState === 'failed'
                          ? '복사 실패'
                          : '링크 복사'}
                    </button>
                  </div>
                </div>

                {detail.viewer.canManage ? (
                  <div className="grid grid-cols-1 gap-2 rounded-lg border border-[#333333] bg-[#161618] p-3 text-xs sm:grid-cols-4">
                    <select
                      value={selectedTicket?.status}
                      onChange={(event) =>
                        void handleUpdateTicket({
                          status: event.target.value as SupportTicketStatus,
                        })
                      }
                      disabled={updatingTicket}
                      className="h-9 rounded border border-[#333333] bg-[#111113] px-2 text-[#d1d5db]"
                    >
                      {STATUS_OPTIONS.map((status) => (
                        <option key={status.value} value={status.value}>
                          상태: {status.label}
                        </option>
                      ))}
                    </select>
                    <select
                      value={selectedTicket?.priority}
                      onChange={(event) =>
                        void handleUpdateTicket({
                          priority: event.target.value as TicketPriority,
                        })
                      }
                      disabled={updatingTicket}
                      className="h-9 rounded border border-[#333333] bg-[#111113] px-2 text-[#d1d5db]"
                    >
                      {PRIORITY_OPTIONS.map((priority) => (
                        <option key={priority.value} value={priority.value}>
                          우선순위: {priority.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void handleUpdateTicket({ assigneeAccountId: account.id })}
                      disabled={updatingTicket}
                      className="h-9 rounded border border-[#333333] bg-[#232326] px-2 text-[#d1d5db] transition hover:border-[#13ec80]/40 hover:text-white"
                    >
                      나에게 배정
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleUpdateTicket({ assigneeAccountId: null })}
                      disabled={updatingTicket}
                      className="h-9 rounded border border-[#333333] bg-[#232326] px-2 text-[#d1d5db] transition hover:border-[#13ec80]/40 hover:text-white"
                    >
                      배정 해제
                    </button>
                  </div>
                ) : null}
              </header>

              <div ref={messageListRef} className="max-h-[520px] space-y-3 overflow-y-auto p-4">
                {detail.messages.length === 0 ? (
                  <p className="text-xs text-[#A0A0A0]">표시할 메시지가 없습니다.</p>
                ) : (
                  detail.messages.map((message) => {
                    const mine = message.authorAccountId === account.id;
                    return (
                      <article
                        key={message.id}
                        className={`rounded-lg border px-3 py-2 text-sm ${
                          message.isInternal
                            ? 'border-amber-500/30 bg-amber-500/10'
                            : mine
                              ? 'border-[#13ec80]/30 bg-[#13ec80]/10'
                              : 'border-[#333333] bg-[#161618]'
                        }`}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
                          <span className="font-medium text-[#d1d5db]">
                            {message.authorDisplayName}
                            {message.isInternal ? ' · 내부메모' : ''}
                          </span>
                          <span className="text-[#6b7280]">{formatDateTime(message.createdAt)}</span>
                        </div>
                        <p className="whitespace-pre-wrap text-sm text-white">{message.body}</p>
                      </article>
                    );
                  })
                )}
              </div>

              <form onSubmit={handleSendMessage} className="space-y-2 border-t border-[#333333] p-4">
                {detail.viewer.canManage ? (
                  <div className="flex flex-wrap gap-1.5">
                    {QUICK_AGENT_REPLIES.map((reply) => (
                      <button
                        key={reply}
                        type="button"
                        onClick={() => {
                          setMessageBody((current) =>
                            current.trim() ? `${current.trim()}\n${reply}` : reply,
                          );
                        }}
                        className="rounded-full border border-[#333333] bg-[#161618] px-2.5 py-1 text-[11px] text-[#A0A0A0] transition hover:text-white"
                      >
                        템플릿
                      </button>
                    ))}
                  </div>
                ) : null}
                <textarea
                  value={messageBody}
                  onChange={(event) => setMessageBody(event.target.value)}
                  rows={3}
                  placeholder="메시지를 입력하세요 (Ctrl+Enter 전송)"
                  className="w-full rounded-lg border border-[#333333] bg-[#161618] px-3 py-2 text-sm text-white placeholder:text-[#6b7280]"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {detail.viewer.canManage ? (
                    <label className="inline-flex items-center gap-2 text-xs text-[#9ca3af]">
                      <input
                        type="checkbox"
                        checked={messageInternal}
                        onChange={(event) => setMessageInternal(event.target.checked)}
                        className="h-4 w-4 rounded border border-[#444] bg-[#111113]"
                      />
                      내부 메모
                    </label>
                  ) : (
                    <span className="text-xs text-[#6b7280]">답변은 즉시 티켓에 반영됩니다.</span>
                  )}

                  <button
                    type="submit"
                    disabled={submittingMessage || !messageBody.trim()}
                    className="rounded-lg bg-[#13ec80] px-4 py-2 text-sm font-semibold text-black transition hover:bg-[#0fb865] disabled:opacity-60"
                  >
                    {submittingMessage ? '전송 중...' : '메시지 전송'}
                  </button>
                </div>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function SummaryPill(props: {
  readonly label: string;
  readonly value: number;
  readonly tone: 'open' | 'pending' | 'resolved' | 'closed';
}) {
  const toneClass =
    props.tone === 'open'
      ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
      : props.tone === 'pending'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
        : props.tone === 'resolved'
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          : 'border-[#444] bg-[#1E1E1E] text-[#A0A0A0]';

  return (
    <div className={`rounded-lg border px-3 py-2 ${toneClass}`}>
      <p className="text-[11px]">{props.label}</p>
      <p className="text-base font-semibold">{props.value.toLocaleString('ko-KR')}</p>
    </div>
  );
}

function statusLabel(status: SupportTicketStatus): string {
  return STATUS_OPTIONS.find((item) => item.value === status)?.label ?? status;
}

function statusBadgeClass(status: SupportTicketStatus): string {
  const base = 'shrink-0 rounded border px-1.5 py-0.5 text-[10px]';
  if (status === 'open') {
    return `${base} border-cyan-500/30 bg-cyan-500/10 text-cyan-300`;
  }
  if (status === 'pending') {
    return `${base} border-amber-500/30 bg-amber-500/10 text-amber-300`;
  }
  if (status === 'resolved') {
    return `${base} border-emerald-500/30 bg-emerald-500/10 text-emerald-300`;
  }
  return `${base} border-[#444] bg-[#161618] text-[#A0A0A0]`;
}

function priorityLabel(priority: TicketPriority): string {
  return PRIORITY_OPTIONS.find((item) => item.value === priority)?.label ?? priority;
}

function SupportContextBadges({ ticket }: { readonly ticket: SupportTicket }) {
  const entries = [
    ['pageId', ticket.pageId],
    ['verifySessionId', ticket.verifySessionId],
    ['pluginServerId', ticket.pluginServerId],
    ['fileId', ticket.fileId],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {entries.map(([label, value]) => (
        <span
          key={`${label}-${value}`}
          className="rounded border border-[#333333] bg-[#111113] px-2 py-0.5 text-[10px] text-[#9ca3af]"
        >
          {label}: {value}
        </span>
      ))}
    </div>
  );
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

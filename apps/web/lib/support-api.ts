import {
  createGuestSupportTicketSchema,
  createSupportMessageSchema,
  createSupportTicketSchema,
  guestSupportAccessSchema,
  guestSupportMessageSchema,
  guestSupportRecoveryResultSchema,
  guestSupportRecoverySchema,
  guestSupportTicketResultSchema,
  supportServerOptionsResponseSchema,
  supportTicketDetailSchema,
  supportTicketListResponseSchema,
  updateSupportTicketSchema,
  type CreateGuestSupportTicketPayload,
  type CreateSupportMessagePayload,
  type CreateSupportTicketPayload,
  type SupportServerOption,
  type SupportTicket,
  type SupportTicketDetail,
  type SupportTicketListResponse,
  type SupportTicketStatus,
  type UpdateSupportTicketPayload,
} from '@minewiki/schemas';
import { normalizeApiBaseUrl } from './runtime-config';
import { csrfHeaders } from './csrf';

const API_BASE = normalizeApiBaseUrl();

interface TicketListOptions {
  readonly view?: 'mine' | 'assigned' | 'inbox';
  readonly status?: SupportTicketStatus;
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface GuestSupportTicketResult {
  readonly accepted: true;
  readonly ticketId: string;
  readonly accessCode: string;
  readonly accessExpiresAt: string;
}

export interface GuestSupportRecoveryResult {
  readonly ticketId: string;
  readonly accessCode: string;
  readonly accessExpiresAt: string;
  readonly detail: SupportTicketDetail;
}

async function parseJsonError(response: Response, fallback: string): Promise<never> {
  const payload = await response.json().catch(() => ({}));
  throw new Error(payload?.message ?? fallback);
}

export async function fetchSupportAgentState(): Promise<{ isAgent: boolean }> {
  const response = await fetch(`${API_BASE}/v1/support/agents/me`, {
    credentials: 'include',
  });
  if (response.status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  if (!response.ok) {
    await parseJsonError(response, '상담원 정보를 불러오지 못했습니다.');
  }
  return (await response.json()) as { isAgent: boolean };
}

export async function fetchSupportTickets(
  options: TicketListOptions = {},
): Promise<SupportTicketListResponse> {
  const params = new URLSearchParams();
  if (options.view) {
    params.set('view', options.view);
  }
  if (options.status) {
    params.set('status', options.status);
  }
  if (options.search) {
    params.set('search', options.search);
  }
  if (options.cursor) {
    params.set('cursor', options.cursor);
  }
  if (options.limit) {
    params.set('limit', String(options.limit));
  }

  const response = await fetch(`${API_BASE}/v1/support/tickets?${params.toString()}`, {
    credentials: 'include',
  });
  if (response.status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  if (!response.ok) {
    await parseJsonError(response, '티켓 목록을 불러오지 못했습니다.');
  }

  const payload = await response.json();
  return supportTicketListResponseSchema.parse(payload);
}

export async function fetchSupportTicketDetail(ticketId: string): Promise<SupportTicketDetail> {
  const response = await fetch(`${API_BASE}/v1/support/tickets/${ticketId}`, {
    credentials: 'include',
  });
  if (response.status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  if (!response.ok) {
    await parseJsonError(response, '티켓 상세를 불러오지 못했습니다.');
  }

  const payload = await response.json();
  return supportTicketDetailSchema.parse(payload);
}

export async function createSupportTicket(
  payload: CreateSupportTicketPayload,
): Promise<SupportTicketDetail> {
  const parsed = createSupportTicketSchema.parse(payload);
  const response = await fetch(`${API_BASE}/v1/support/tickets`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(await csrfHeaders()),
    },
    body: JSON.stringify(parsed),
  });
  if (response.status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  if (!response.ok) {
    await parseJsonError(response, '티켓 생성에 실패했습니다.');
  }

  const data = await response.json();
  return supportTicketDetailSchema.parse(data);
}

export async function createSupportGuestTicket(
  payload: CreateGuestSupportTicketPayload,
): Promise<GuestSupportTicketResult> {
  const parsed = createGuestSupportTicketSchema.parse(payload);
  const response = await fetch(`${API_BASE}/v1/support/tickets/guest`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(await csrfHeaders()),
    },
    body: JSON.stringify(parsed),
  });
  if (!response.ok) {
    await parseJsonError(response, '비회원 문의 접수에 실패했습니다.');
  }
  const result = guestSupportTicketResultSchema.parse(await response.json());
  return {
    accepted: true,
    ticketId: result.ticketId,
    accessCode: result.accessCode,
    accessExpiresAt: result.accessExpiresAt,
  };
}

export async function fetchGuestSupportTicket(
  ticketId: string,
  accessCode: string,
): Promise<SupportTicketDetail> {
  const parsed = guestSupportAccessSchema.parse({ ticketId, accessCode });
  const response = await fetch(`${API_BASE}/v1/support/tickets/guest/lookup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await csrfHeaders()),
    },
    body: JSON.stringify(parsed),
  });
  if (!response.ok) {
    await parseJsonError(response, '비회원 문의를 조회하지 못했습니다.');
  }
  return supportTicketDetailSchema.parse(await response.json());
}

export async function recoverGuestSupportTicket(
  ticketId: string,
  email: string,
  captchaToken?: string,
): Promise<GuestSupportRecoveryResult> {
  const parsed = guestSupportRecoverySchema.parse({ ticketId, email, captchaToken });
  const response = await fetch(`${API_BASE}/v1/support/tickets/guest/recover`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await csrfHeaders()),
    },
    body: JSON.stringify(parsed),
  });
  if (!response.ok) {
    await parseJsonError(response, '비회원 문의를 복구하지 못했습니다.');
  }
  const result = guestSupportRecoveryResultSchema.parse(await response.json());
  return {
    ticketId: result.ticketId,
    accessCode: result.accessCode,
    accessExpiresAt: result.accessExpiresAt,
    detail: result.detail,
  };
}

export async function createGuestSupportMessage(
  ticketId: string,
  accessCode: string,
  body: string,
): Promise<SupportTicketDetail> {
  const parsed = guestSupportMessageSchema.parse({ accessCode, body });
  const response = await fetch(`${API_BASE}/v1/support/tickets/guest/${ticketId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await csrfHeaders()),
    },
    body: JSON.stringify(parsed),
  });
  if (!response.ok) {
    await parseJsonError(response, '비회원 문의 답변을 전송하지 못했습니다.');
  }
  return supportTicketDetailSchema.parse(await response.json());
}

export async function createSupportMessage(
  ticketId: string,
  payload: CreateSupportMessagePayload,
): Promise<SupportTicketDetail> {
  const parsed = createSupportMessageSchema.parse(payload);
  const response = await fetch(`${API_BASE}/v1/support/tickets/${ticketId}/messages`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(await csrfHeaders()),
    },
    body: JSON.stringify(parsed),
  });
  if (response.status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  if (!response.ok) {
    await parseJsonError(response, '메시지 전송에 실패했습니다.');
  }

  const data = await response.json();
  return supportTicketDetailSchema.parse(data);
}

export async function updateSupportTicket(
  ticketId: string,
  payload: UpdateSupportTicketPayload,
): Promise<SupportTicketDetail> {
  const parsed = updateSupportTicketSchema.parse(payload);
  const response = await fetch(`${API_BASE}/v1/support/tickets/${ticketId}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(await csrfHeaders()),
    },
    body: JSON.stringify(parsed),
  });
  if (response.status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  if (!response.ok) {
    await parseJsonError(response, '티켓 업데이트에 실패했습니다.');
  }

  const data = await response.json();
  return supportTicketDetailSchema.parse(data);
}

export async function fetchSupportServerOptions(
  search?: string,
): Promise<SupportServerOption[]> {
  const params = new URLSearchParams();
  const keyword = search?.trim();
  if (keyword) {
    params.set('search', keyword);
  }

  const query = params.toString();
  const response = await fetch(
    `${API_BASE}/v1/support/server-options${query ? `?${query}` : ''}`,
    {
      credentials: 'include',
      cache: 'no-store',
    },
  );
  if (!response.ok) {
    await parseJsonError(response, '서버 목록을 불러오지 못했습니다.');
  }

  return supportServerOptionsResponseSchema.parse(await response.json()).items;
}

export type {
  CreateGuestSupportTicketPayload,
  CreateSupportMessagePayload,
  CreateSupportTicketPayload,
  SupportTicket,
  SupportTicketDetail,
  SupportTicketListResponse,
  SupportTicketStatus,
  SupportServerOption,
  UpdateSupportTicketPayload,
};

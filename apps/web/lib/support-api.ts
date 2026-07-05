import {
  createGuestSupportTicketSchema,
  createSupportMessageSchema,
  createSupportTicketSchema,
  serverSummarySchema,
  supportTicketDetailSchema,
  supportTicketListResponseSchema,
  updateSupportTicketSchema,
  type CreateGuestSupportTicketPayload,
  type CreateSupportMessagePayload,
  type CreateSupportTicketPayload,
  type ServerSummary,
  type SupportTicket,
  type SupportTicketDetail,
  type SupportTicketListResponse,
  type SupportTicketStatus,
  type UpdateSupportTicketPayload,
} from '@minewiki/schemas';
import { normalizeApiBaseUrl } from './runtime-config';

const API_BASE = normalizeApiBaseUrl();

interface TicketListOptions {
  readonly view?: 'mine' | 'assigned' | 'inbox';
  readonly status?: SupportTicketStatus;
}

interface GuestTicketResult {
  readonly accepted: true;
  readonly ticketId: string;
}

export interface SupportServerOption {
  readonly id: string;
  readonly name: string;
  readonly joinHost: string;
  readonly edition: ServerSummary['edition'];
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
): Promise<GuestTicketResult> {
  const parsed = createGuestSupportTicketSchema.parse(payload);
  const response = await fetch(`${API_BASE}/v1/support/tickets/guest`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(parsed),
  });
  if (!response.ok) {
    await parseJsonError(response, '비회원 문의 접수에 실패했습니다.');
  }
  return (await response.json()) as GuestTicketResult;
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
  params.set('sort', 'votes24h_desc');
  const keyword = search?.trim();
  if (keyword) {
    params.set('search', keyword);
  }

  const response = await fetch(`${API_BASE}/v1/servers?${params.toString()}`);
  if (!response.ok) {
    await parseJsonError(response, '서버 목록을 불러오지 못했습니다.');
  }

  const payload = await response.json();
  const items = serverSummarySchema.array().parse(payload);
  return items.map((server) => ({
    id: server.id,
    name: server.name,
    joinHost: server.joinHost,
    edition: server.edition,
  }));
}

export type {
  CreateGuestSupportTicketPayload,
  CreateSupportMessagePayload,
  CreateSupportTicketPayload,
  SupportTicket,
  SupportTicketDetail,
  SupportTicketListResponse,
  SupportTicketStatus,
  UpdateSupportTicketPayload,
};

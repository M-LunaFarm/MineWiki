import { getApiBaseUrl } from './runtime-config';

const API_BASE = getApiBaseUrl();

export interface AuditEvent {
  readonly id: string;
  readonly category: string;
  readonly action: string;
  readonly severity: string;
  readonly actorAccountId: string | null;
  readonly actorProfileId: string | null;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly requestId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly metadata: unknown;
  readonly createdAt: string;
}

export interface AuditEventFilters {
  readonly category?: string;
  readonly action?: string;
  readonly severity?: string;
  readonly actorAccountId?: string;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly requestId?: string;
}

export interface AuditEventPage {
  readonly items: AuditEvent[];
  readonly nextCursor: string | null;
}

export async function fetchAuditEvents(input: {
  readonly category?: string;
  readonly action?: string;
  readonly limit?: number;
} = {}): Promise<AuditEvent[]> {
  const params = new URLSearchParams({ limit: String(input.limit ?? 100) });
  if (input.category?.trim()) {
    params.set('category', input.category.trim());
  }
  if (input.action?.trim()) {
    params.set('action', input.action.trim());
  }
  const response = await fetch(`${API_BASE}/v1/admin/audit?${params.toString()}`, {
    credentials: 'include'
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.message ?? '감사 이벤트를 불러오지 못했습니다.');
  }
  return body;
}

export async function fetchAuditEventPage(input: AuditEventFilters & {
  readonly cursor?: string;
  readonly limit?: number;
} = {}): Promise<AuditEventPage> {
  const params = new URLSearchParams({ limit: String(input.limit ?? 50) });
  for (const key of ['category', 'action', 'severity', 'actorAccountId', 'subjectType', 'subjectId', 'requestId', 'cursor'] as const) {
    const value = input[key]?.trim();
    if (value) params.set(key, value);
  }
  const response = await fetch(`${API_BASE}/v1/admin/audit/page?${params.toString()}`, { credentials: 'include' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message ?? '감사 이벤트를 불러오지 못했습니다.');
  return body as AuditEventPage;
}

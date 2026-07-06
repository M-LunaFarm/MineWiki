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

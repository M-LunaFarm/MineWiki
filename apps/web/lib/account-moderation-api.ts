import { csrfHeaders } from './csrf';
import { getApiBaseUrl } from './runtime-config';

const API_BASE = getApiBaseUrl();

export type AccountLifecycleStatus =
  | 'active'
  | 'suspended'
  | 'deletion_pending'
  | 'anonymized';

export type AdminAccountLifecycleStatus = AccountLifecycleStatus | 'mixed';

export interface AdminAccountSummary {
  readonly canonicalAccountId: string;
  readonly confirmationValue: string;
  readonly accountIds: string[];
  readonly linkedAccountCount: number;
  readonly lifecycleStatus: AdminAccountLifecycleStatus;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly providers: Array<'email' | 'discord' | 'naver'>;
  readonly roles: string[];
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
  readonly suspendedAt: string | null;
  readonly suspendedBy: string | null;
  readonly suspensionReason: string | null;
}

export interface AdminAccountMember {
  readonly id: string;
  readonly provider: 'email' | 'discord' | 'naver';
  readonly email: string | null;
  readonly displayName: string | null;
  readonly lifecycleStatus: AccountLifecycleStatus;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

export interface AccountModerationHistoryEntry {
  readonly id: string;
  readonly action: 'account.suspended' | 'account.restored';
  readonly actorAccountId: string | null;
  readonly reason: string | null;
  readonly previousStatus: string | null;
  readonly newStatus: string | null;
  readonly createdAt: string;
}

export interface AdminAccountDetail extends AdminAccountSummary {
  readonly accounts: AdminAccountMember[];
  readonly moderationHistory: AccountModerationHistoryEntry[];
}

export interface AdminAccountListResponse {
  readonly accounts: AdminAccountSummary[];
}

export interface AccountModerationResult {
  readonly account: AdminAccountDetail;
  readonly revokedSessionCount: number;
  readonly revokedWikiApiTokenCount: number;
}

export class AccountModerationApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AccountModerationApiError';
  }
}

export async function fetchAdminAccounts(input: {
  readonly q?: string;
  readonly status?: AccountLifecycleStatus;
  readonly limit?: number;
} = {}): Promise<AdminAccountListResponse> {
  const params = new URLSearchParams({ limit: String(input.limit ?? 50) });
  if (input.q?.trim()) params.set('q', input.q.trim());
  if (input.status) params.set('status', input.status);
  const payload = await accountModerationRequest<AdminAccountListResponse>(
    `/v1/admin/accounts?${params.toString()}`,
  );
  if (!Array.isArray(payload.accounts)) {
    throw new AccountModerationApiError(
      '계정 목록 응답 형식이 올바르지 않습니다.',
      502,
      'invalid_admin_account_list',
    );
  }
  return payload;
}

export function fetchAdminAccountModeration(accountId: string): Promise<AdminAccountDetail> {
  return accountModerationRequest<AdminAccountDetail>(
    `/v1/admin/accounts/${encodeURIComponent(accountId)}`,
  );
}

export function suspendAdminAccount(
  accountId: string,
  input: {
    readonly reason: string;
    readonly confirmation: string;
    readonly expectedStatus: 'active';
  },
): Promise<AccountModerationResult> {
  return accountModerationRequest<AccountModerationResult>(
    `/v1/admin/accounts/${encodeURIComponent(accountId)}/suspend`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function restoreAdminAccount(
  accountId: string,
  input: {
    readonly reason: string;
    readonly confirmation: string;
    readonly expectedStatus: 'suspended';
  },
): Promise<AccountModerationResult> {
  return accountModerationRequest<AccountModerationResult>(
    `/v1/admin/accounts/${encodeURIComponent(accountId)}/restore`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

async function accountModerationRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method?.toUpperCase() ?? 'GET';
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    cache: 'no-store',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' && method !== 'HEAD' ? await csrfHeaders() : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AccountModerationApiError(
      typeof body?.message === 'string' ? body.message : '계정 보안 요청을 처리하지 못했습니다.',
      response.status,
      typeof body?.code === 'string' ? body.code : null,
      body?.details,
    );
  }
  return body as T;
}

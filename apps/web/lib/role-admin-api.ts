import { csrfHeaders } from './csrf';
import { getApiBaseUrl } from './runtime-config';

const API_BASE = getApiBaseUrl();

export interface AdminRole {
  readonly id: string;
  readonly code: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly permissions: string[];
}

export interface AdminAccountRoleSummary {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly provider: string;
  readonly createdAt: string;
  readonly roles: string[];
}

export interface AdminAccountAccess {
  readonly roles: string[];
  readonly permissions: string[];
}

export async function fetchAdminRoles(): Promise<AdminRole[]> {
  return adminRoleRequest<AdminRole[]>('');
}

export async function searchAdminAccounts(
  query?: string,
  limit = 50,
): Promise<AdminAccountRoleSummary[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (query?.trim()) {
    params.set('q', query.trim());
  }
  return adminRoleRequest<AdminAccountRoleSummary[]>(`/accounts?${params.toString()}`);
}

export async function assignAdminRole(
  accountId: string,
  roleCode: string,
): Promise<AdminAccountAccess> {
  return adminRoleRequest<AdminAccountAccess>(`/accounts/${encodeURIComponent(accountId)}`, {
    method: 'POST',
    body: JSON.stringify({ roleCode }),
  });
}

export async function removeAdminRole(
  accountId: string,
  roleCode: string,
): Promise<AdminAccountAccess> {
  return adminRoleRequest<AdminAccountAccess>(
    `/accounts/${encodeURIComponent(accountId)}/${encodeURIComponent(roleCode)}`,
    { method: 'DELETE' },
  );
}

async function adminRoleRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}/v1/admin/roles${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.method && init.method !== 'GET' ? await csrfHeaders() : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.message ?? '역할 관리 요청을 처리하지 못했습니다.');
  }
  return body as T;
}

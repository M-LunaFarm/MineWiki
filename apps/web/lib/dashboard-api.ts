import {
  dashboardOverviewSchema,
  type DashboardOverview,
  type DashboardActivityItem,
  type DashboardServerSummary,
  type DashboardVerificationTask
} from '@minewiki/schemas';
import { normalizeApiBaseUrl } from './runtime-config';
import { csrfHeaders } from './csrf';

const API_BASE = normalizeApiBaseUrl();

export async function fetchDashboardOverview(): Promise<DashboardOverview> {
  const response = await fetch(`${API_BASE}/v1/dashboard/overview`, {
    credentials: 'include'
  });
  if (response.status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load dashboard overview.');
  }
  const payload = await response.json();
  return dashboardOverviewSchema.parse(payload);
}

export async function removeOwnedServer(serverId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/v1/servers/${serverId}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: await csrfHeaders()
  });
  if (response.status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to remove server.');
  }
}

export type {
  DashboardOverview,
  DashboardActivityItem,
  DashboardServerSummary,
  DashboardVerificationTask
};

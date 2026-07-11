import { csrfHeaders } from './csrf';
import { normalizeApiBaseUrl } from './runtime-config';

export interface PluginCredentialSummary {
  readonly id: string;
  readonly serverId: string | null;
  readonly guildId: string;
  readonly pluginServerId: string;
  readonly serverName: string;
  readonly host: string;
  readonly port: number;
  readonly endpointUrl: string | null;
  readonly enabled: boolean;
  readonly lastSeenAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IssuedPluginCredential extends PluginCredentialSummary {
  readonly secret: string;
}

export async function fetchPluginCredentials(
  serverId: string,
  apiBaseUrl?: string,
): Promise<PluginCredentialSummary[]> {
  return pluginCredentialRequest<PluginCredentialSummary[]>(serverId, '', undefined, apiBaseUrl);
}

export async function createPluginCredential(
  serverId: string,
  payload: { guildId: string; endpointUrl?: string | null },
  apiBaseUrl?: string,
): Promise<IssuedPluginCredential> {
  return pluginCredentialRequest<IssuedPluginCredential>(
    serverId,
    '',
    { method: 'POST', body: JSON.stringify(payload) },
    apiBaseUrl,
  );
}

export async function rotatePluginCredential(
  serverId: string,
  credentialId: string,
  apiBaseUrl?: string,
): Promise<IssuedPluginCredential> {
  return pluginCredentialRequest<IssuedPluginCredential>(
    serverId,
    `/${encodeURIComponent(credentialId)}/rotate`,
    { method: 'POST' },
    apiBaseUrl,
  );
}

export async function setPluginCredentialEnabled(
  serverId: string,
  credentialId: string,
  enabled: boolean,
  apiBaseUrl?: string,
): Promise<PluginCredentialSummary> {
  return pluginCredentialRequest<PluginCredentialSummary>(
    serverId,
    `/${encodeURIComponent(credentialId)}`,
    { method: 'PATCH', body: JSON.stringify({ enabled }) },
    apiBaseUrl,
  );
}

async function pluginCredentialRequest<T>(
  serverId: string,
  path: string,
  init: RequestInit = {},
  apiBaseUrl?: string,
): Promise<T> {
  const baseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const response = await fetch(
    `${baseUrl}/v1/servers/${encodeURIComponent(serverId)}/plugin-credentials${path}`,
    {
      ...init,
      credentials: 'include',
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.method && init.method !== 'GET' ? await csrfHeaders() : {}),
        ...init.headers,
      },
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.message ?? '플러그인 자격증명 요청을 처리하지 못했습니다.');
  }
  return body as T;
}

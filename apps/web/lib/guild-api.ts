import { cookies } from 'next/headers';
import { normalizeApiBaseUrl } from './runtime-config';

const API_BASE = normalizeApiBaseUrl(process.env.INTERNAL_API_BASE_URL);

export type GuildSettingsPayload = {
  readonly channelId?: string;
  readonly verifiedRoleId?: string | null;
  readonly logChannelId?: string | null;
  readonly nicknameFormat?: string | null;
  readonly botMessageTemplate?: string | null;
  readonly botMessagePayload?: unknown;
  readonly verifyReplyPayload?: unknown;
  readonly policyJson?: unknown;
};

export type GuildSummary = {
  readonly guildId: string;
  readonly verifiedRoleId: string | null;
  readonly logChannelId: string | null;
  readonly nicknameFormat: string | null;
  readonly botMessageTemplate: string | null;
  readonly botMessagePayload: unknown | null;
  readonly verifyReplyPayload: unknown | null;
  readonly policyJson: unknown | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type GuildChannelSetting = GuildSummary & {
  readonly channelId: string;
};

export type GuildActionProfile = {
  readonly profileId: string;
  readonly channelId: string | null;
  readonly name: string;
  readonly triggerEvent: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
};

export type GuildDetail = GuildSummary & {
  readonly verificationCount: number;
  readonly channels: GuildChannelSetting[];
  readonly actionProfiles: GuildActionProfile[];
};

export class GuildApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GuildApiError';
  }
}

export function isGuildAuthenticationError(error: unknown): boolean {
  return error instanceof GuildApiError && error.status === 401;
}

export function buildDiscordBotInviteUrl(guildId?: string | null): string | null {
  const clientId = process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID ?? process.env.DISCORD_CLIENT_ID;
  if (!clientId) {
    return null;
  }
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', 'bot applications.commands');
  url.searchParams.set('permissions', '268438528');
  if (guildId) {
    url.searchParams.set('guild_id', guildId);
    url.searchParams.set('disable_guild_select', 'true');
  }
  return url.toString();
}

export async function fetchGuilds(): Promise<GuildSummary[]> {
  return fetchGuildApi<GuildSummary[]>('/v1/guilds/me');
}

export async function fetchGuildDetail(guildId: string): Promise<GuildDetail | null> {
  const response = await fetch(`${API_BASE}/v1/guilds/${encodeURIComponent(guildId)}`, {
    headers: await sessionHeaders(),
    cache: 'no-store',
  });
  if (response.status === 404) {
    return null;
  }
  return readGuildResponse<GuildDetail>(response);
}

export async function updateGuildSettings(
  guildId: string,
  payload: GuildSettingsPayload,
): Promise<GuildSummary | GuildChannelSetting> {
  return fetchGuildApi<GuildSummary | GuildChannelSetting>(
    `/v1/guilds/${encodeURIComponent(guildId)}/settings`,
    {
      method: 'PATCH',
      headers: {
        ...(await sessionHeaders()),
        ...(await csrfHeader()),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );
}

async function fetchGuildApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const session = await sessionHeaders();
  if (!headers.has('cookie')) {
    headers.set('cookie', session.cookie);
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  });
  return readGuildResponse<T>(response);
}

async function readGuildResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new GuildApiError(
      response.status,
      body?.message ?? `Guild API request failed. (${response.status})`,
    );
  }
  return (await response.json()) as T;
}

async function sessionHeaders(): Promise<{ cookie: string }> {
  const cookieHeader = (await cookies()).toString();
  if (!cookieHeader) {
    throw new GuildApiError(401, '로그인이 필요합니다.');
  }
  return { cookie: cookieHeader };
}

async function csrfHeader(): Promise<Record<string, string>> {
  const session = await sessionHeaders();
  const response = await fetch(`${API_BASE}/v1/auth/csrf`, {
    headers: session,
    cache: 'no-store'
  });
  const body = await response.json().catch(() => ({}));
  return typeof body.csrfToken === 'string' ? { 'x-csrf-token': body.csrfToken } : {};
}

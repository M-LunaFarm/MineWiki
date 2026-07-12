import {
  authAccountSchema,
  oauthProviderAvailabilitySchema,
  type AuthAccount,
  type OAuthProvider,
  type OAuthStartResponse,
  type OAuthCompleteResponse,
  type EmailRegistrationResult,
  type ResendVerificationResult,
  type SessionListResponse,
  type SessionSummary,
  type OAuthProviderAvailability,
} from '@minewiki/schemas';
import { normalizeApiBaseUrl } from './runtime-config';
import { clearCsrfToken, csrfHeaders } from './csrf';

const API_BASE = normalizeApiBaseUrl();

interface AuthResponse {
  readonly account: AuthAccount;
  readonly sessionId: string;
  readonly expiresAt: string;
}

interface PasswordResetRequestResponse {
  readonly accepted: true;
}

interface PasswordResetConfirmResponse {
  readonly success: true;
}

export interface AccountLinkConflict {
  readonly id: string;
  readonly kind:
    | 'minecraft_identity_duplicate'
    | 'discord_identity_duplicate'
    | 'discord_minecraft_mismatch'
    | 'legacy_wiki_profile';
  readonly message: string;
  readonly minecraftUuid: string | null;
  readonly discordUserId: string | null;
  readonly conflictingAccountId: string | null;
  readonly legacyWikiProfileId: string | null;
}

export interface AccountLinkConflictResponse {
  readonly conflicts: AccountLinkConflict[];
}

export interface AccountMergeRequestResponse {
  readonly ticketId: string;
  readonly status: 'created';
  readonly conflicts: AccountLinkConflict[];
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.message ?? 'Request failed.');
  }
  return (await response.json()) as T;
}

export async function registerEmail(payload: {
  email: string;
  password: string;
  displayName?: string;
  agreeTerms: true;
  agreePrivacy: true;
}): Promise<EmailRegistrationResult> {
  return postJson<EmailRegistrationResult>('/v1/auth/email/register', payload);
}

export async function loginEmail(payload: {
  email: string;
  password: string;
}): Promise<AuthAccount> {
  const result = await postJson<AuthResponse>('/v1/auth/email/login', payload);
  return result.account;
}

export async function verifyEmail(token: string): Promise<AuthAccount> {
  const result = await postJson<AuthResponse>('/v1/auth/email/verify', { token });
  return result.account;
}

export async function resendVerification(email: string): Promise<ResendVerificationResult> {
  return postJson<ResendVerificationResult>('/v1/auth/email/resend', { email });
}

export async function setupEmailLogin(payload: {
  email: string;
  password: string;
}): Promise<ResendVerificationResult> {
  return postJson<ResendVerificationResult>('/v1/auth/email/setup', payload);
}

export async function requestPasswordReset(email: string): Promise<void> {
  await postJson<PasswordResetRequestResponse>('/v1/auth/password/forgot', { email });
}

export async function resetPassword(payload: {
  token: string;
  newPassword: string;
}): Promise<void> {
  await postJson<PasswordResetConfirmResponse>('/v1/auth/password/reset', payload);
}

export async function logout(): Promise<void> {
  await postJson('/v1/auth/logout', {});
  clearCsrfToken();
}

export async function fetchCurrentAccount(): Promise<AuthAccount | null> {
  const response = await fetch(`${API_BASE}/v1/auth/me`, {
    credentials: 'include',
  });
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load session info.');
  }
  const payload = await response.json();
  return authAccountSchema.parse(payload);
}

export async function startOAuthLogin(
  provider: OAuthProvider,
  payload: { redirectUri: string; returnTo?: string; agreeTerms: true; agreePrivacy: true },
): Promise<OAuthStartResponse> {
  return postJson<OAuthStartResponse>('/v1/auth/oauth/start', {
    provider,
    redirectUri: payload.redirectUri,
    returnTo: payload.returnTo,
    agreeTerms: payload.agreeTerms,
    agreePrivacy: payload.agreePrivacy,
  });
}

export async function startOAuthLink(
  provider: OAuthProvider,
  payload: { redirectUri: string; returnTo?: string },
): Promise<OAuthStartResponse> {
  return postJson<OAuthStartResponse>('/v1/auth/oauth/link', {
    provider,
    redirectUri: payload.redirectUri,
    returnTo: payload.returnTo,
  });
}

export async function completeOAuthLogin(payload: {
  provider: OAuthProvider;
  code: string;
  state: string;
  redirectUri?: string;
}): Promise<OAuthCompleteResponse> {
  return postJson<OAuthCompleteResponse>('/v1/auth/oauth/complete', payload);
}

export async function fetchOAuthProviderAvailability(): Promise<OAuthProviderAvailability> {
  const response = await fetch(`${API_BASE}/v1/auth/providers`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load OAuth provider availability.');
  }
  const payload = await response.json();
  return oauthProviderAvailabilitySchema.parse(payload);
}

export async function fetchSessions(): Promise<SessionListResponse> {
  const response = await fetch(`${API_BASE}/v1/sessions`, {
    credentials: 'include',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load sessions.');
  }
  return (await response.json()) as SessionListResponse;
}

export async function revokeSession(sessionId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/v1/sessions/${sessionId}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: await csrfHeaders(),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to revoke session.');
  }
}

export async function revokeOtherSessions(): Promise<void> {
  const response = await fetch(`${API_BASE}/v1/sessions/others`, {
    method: 'DELETE',
    credentials: 'include',
    headers: await csrfHeaders(),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to revoke other sessions.');
  }
}

export async function updateDisplayName(displayName: string): Promise<AuthAccount> {
  const response = await fetch(`${API_BASE}/v1/auth/me`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify({ displayName }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to update display name.');
  }
  const payload = await response.json();
  return authAccountSchema.parse(payload);
}

export async function updateProfileAvatar(payload: {
  data: string;
  filename?: string;
}): Promise<AuthAccount> {
  const response = await fetch(`${API_BASE}/v1/auth/me/avatar`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to update profile image.');
  }
  const body = await response.json();
  return authAccountSchema.parse(body);
}

export async function clearProfileAvatar(): Promise<AuthAccount> {
  const response = await fetch(`${API_BASE}/v1/auth/me/avatar`, {
    method: 'DELETE',
    credentials: 'include',
    headers: await csrfHeaders(),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to clear profile image.');
  }
  const body = await response.json();
  return authAccountSchema.parse(body);
}

export async function fetchAccountLinkConflicts(): Promise<AccountLinkConflictResponse> {
  const response = await fetch(`${API_BASE}/v1/account/link-conflicts`, {
    credentials: 'include',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load account link conflicts.');
  }
  return (await response.json()) as AccountLinkConflictResponse;
}

export async function createAccountMergeRequest(payload: {
  message?: string;
  conflictMessage?: string;
  source?: 'account_center' | 'minecraft_verify' | 'discord_verify' | 'wiki_profile';
}): Promise<AccountMergeRequestResponse> {
  return postJson<AccountMergeRequestResponse>('/v1/account/merge-requests', payload);
}

export async function changePassword(payload: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  const response = await fetch(`${API_BASE}/v1/auth/password`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to update password.');
  }
}

export type {
  AuthAccount,
  EmailRegistrationResult,
  OAuthProvider,
  OAuthProviderAvailability,
  ResendVerificationResult,
  SessionSummary,
};

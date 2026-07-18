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
  type PolicyConsentStatus,
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

export interface AccountEmailChangeState {
  readonly currentEmail: string | null;
  readonly hasPassword: boolean;
  readonly pending: {
    readonly emailMasked: string;
    readonly status: 'pending';
    readonly expiresAt: string;
    readonly nextResendAt: string;
  } | null;
}

export interface AccountEmailChangeRequestResult {
  readonly accepted: true;
  readonly expiresAt: string;
  readonly nextResendAt: string;
}

export interface AccountLinkConflict {
  readonly id: string;
  readonly kind:
    | 'verified_email_duplicate'
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

export interface AccountDeletionBlocker {
  readonly type: string;
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

export interface AccountDeletionStatus {
  readonly id: string;
  readonly status: string;
  readonly requestedAt: string;
  readonly scheduledFor: string;
  readonly cancelledAt: string | null;
  readonly processedAt: string | null;
  readonly adminNote: string | null;
}

export type MfaStepUpPurpose =
  | 'wiki_admin'
  | 'role_admin'
  | 'server_admin'
  | 'review_moderation'
  | 'vote_admin'
  | 'guild_admin'
  | 'file_admin'
  | 'audit_read'
  | 'account_delete_admin'
  | 'account_moderation'
  | 'account_merge_admin'
  | 'mfa_manage'
  | 'account_export';

export interface MfaStatus {
  readonly mfaEnabled: boolean;
  readonly totpEnabled: boolean;
  readonly passkeyCount: number;
  readonly passkeys: readonly PasskeySummary[];
  readonly pendingEnrollment: boolean;
  readonly pendingExpiresAt: string | null;
  readonly recoveryCodesRemaining: number;
  readonly lockedUntil: string | null;
}

export interface PasskeySummary {
  readonly id: string;
  readonly name: string;
  readonly transports: readonly string[];
  readonly deviceType: string;
  readonly backedUp: boolean;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface PasskeyCeremony<TOptions = unknown> {
  readonly ceremonyId: string;
  readonly expiresAt: string;
  readonly options: TOptions;
}

export interface TotpEnrollment {
  readonly secret: string;
  readonly otpauthUri: string;
  readonly expiresAt: string;
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export class AccountDeletionBlockedError extends Error {
  constructor(message: string, readonly blockers: AccountDeletionBlocker[]) { super(message); }
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

async function mfaRequest<T>(
  path: string,
  options: { readonly method?: 'GET' | 'POST' | 'DELETE'; readonly body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: method === 'GET'
      ? undefined
      : { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiClientError(
      typeof payload?.message === 'string' ? payload.message : '다중 인증 요청을 처리하지 못했습니다.',
      typeof payload?.code === 'string' ? payload.code : 'mfa_request_failed',
      response.status,
      payload?.details,
    );
  }
  if (method !== 'GET') clearCsrfToken();
  return payload as T;
}

export function fetchMfaStatus(): Promise<MfaStatus> {
  return mfaRequest<MfaStatus>('/v1/auth/mfa');
}

export function beginTotpEnrollment(): Promise<TotpEnrollment> {
  return mfaRequest<TotpEnrollment>('/v1/auth/mfa/totp/enrollment', { method: 'POST', body: {} });
}

export function confirmTotpEnrollment(code: string): Promise<{
  readonly enabled: true;
  readonly recoveryCodes: readonly string[];
}> {
  return mfaRequest('/v1/auth/mfa/totp/enrollment/confirm', {
    method: 'POST',
    body: { code },
  });
}

export function performMfaStepUp(input: {
  readonly method: 'totp' | 'recovery_code';
  readonly purpose: MfaStepUpPurpose;
  readonly code: string;
}): Promise<{ readonly authLevel: 'aal2'; readonly purpose: MfaStepUpPurpose; readonly expiresAt: string }> {
  return mfaRequest('/v1/auth/mfa/step-up', { method: 'POST', body: input });
}

export function beginPasskeyRegistration(): Promise<PasskeyCeremony> {
  return mfaRequest('/v1/auth/mfa/passkeys/registration/options', { method: 'POST', body: {} });
}

export function finishPasskeyRegistration(input: {
  readonly ceremonyId: string;
  readonly name: string;
  readonly response: unknown;
}): Promise<{ readonly passkey: PasskeySummary }> {
  return mfaRequest('/v1/auth/mfa/passkeys/registration/verify', { method: 'POST', body: input });
}

export function beginPasskeyStepUp(purpose: MfaStepUpPurpose): Promise<PasskeyCeremony> {
  return mfaRequest('/v1/auth/mfa/passkeys/step-up/options', {
    method: 'POST',
    body: { purpose },
  });
}

export function finishPasskeyStepUp(input: {
  readonly ceremonyId: string;
  readonly purpose: MfaStepUpPurpose;
  readonly response: unknown;
}): Promise<{ readonly authLevel: 'aal2'; readonly method: 'webauthn'; readonly purpose: MfaStepUpPurpose; readonly expiresAt: string }> {
  return mfaRequest('/v1/auth/mfa/passkeys/step-up/verify', { method: 'POST', body: input });
}

export function deletePasskey(passkeyId: string): Promise<{ readonly deleted: true }> {
  return mfaRequest(`/v1/auth/mfa/passkeys/${encodeURIComponent(passkeyId)}`, { method: 'DELETE' });
}

export function regenerateMfaRecoveryCodes(): Promise<{ readonly recoveryCodes: readonly string[] }> {
  return mfaRequest('/v1/auth/mfa/recovery-codes/regenerate', { method: 'POST', body: {} });
}

export function disableTotp(): Promise<{ readonly enabled: false }> {
  return mfaRequest('/v1/auth/mfa/totp', { method: 'DELETE' });
}

export async function downloadAccountData(password?: string): Promise<{ readonly blob: Blob; readonly filename: string }> {
  const response = await fetch(`${API_BASE}/v1/auth/account-data-export`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify(password ? { password } : {}),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiClientError(
      typeof payload?.message === 'string' ? payload.message : '계정 데이터를 내보내지 못했습니다.',
      typeof payload?.code === 'string' ? payload.code : 'account_export_failed',
      response.status,
      payload,
    );
  }
  clearCsrfToken();
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="([^"\r\n]+)"/u.exec(disposition);
  return {
    blob: await response.blob(),
    filename: match?.[1] ?? `minewiki-account-data-${new Date().toISOString().slice(0, 10)}.json`,
  };
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

async function accountEmailChangeRequest<T>(
  path: string,
  options: { readonly method?: 'GET' | 'POST'; readonly body?: unknown; readonly csrf?: boolean } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers = method === 'POST'
    ? { 'Content-Type': 'application/json', ...(options.csrf === false ? {} : await csrfHeaders()) }
    : undefined;
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiClientError(
      typeof payload?.message === 'string' ? payload.message : '이메일 변경 요청을 처리하지 못했습니다.',
      typeof payload?.code === 'string' ? payload.code : 'contact_email_change_failed',
      response.status,
      payload?.details,
    );
  }
  return payload as T;
}

export function fetchAccountEmailChangeState(): Promise<AccountEmailChangeState> {
  return accountEmailChangeRequest('/v1/auth/me/email-change');
}

export function requestAccountEmailChange(input: { readonly email: string; readonly password?: string }): Promise<AccountEmailChangeRequestResult> {
  return accountEmailChangeRequest('/v1/auth/me/email-change/request', { method: 'POST', body: input });
}

export function resendAccountEmailChange(): Promise<AccountEmailChangeRequestResult> {
  return accountEmailChangeRequest('/v1/auth/me/email-change/resend', { method: 'POST', body: {} });
}

export async function confirmAccountEmailChange(token: string): Promise<{ readonly success: true; readonly reauthenticationRequired: true }> {
  const result = await accountEmailChangeRequest<{ readonly success: true; readonly reauthenticationRequired: true }>(
    '/v1/auth/email-change/confirm',
    { method: 'POST', body: { token }, csrf: false },
  );
  clearCsrfToken();
  return result;
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

export async function acceptCurrentPolicies(): Promise<PolicyConsentStatus> {
  return postJson<PolicyConsentStatus>('/v1/auth/policies/accept', {
    agreeTerms: true,
    agreePrivacy: true,
  });
}

export async function requestAccountDeletion(password?: string): Promise<AccountDeletionStatus & { cancelToken: string }> {
  const response = await fetch(`${API_BASE}/v1/auth/account-deletion`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify(password ? { password } : {}),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (payload?.code === 'ACCOUNT_DELETION_ASSET_TRANSFER_REQUIRED' && Array.isArray(payload.blockers)) {
      throw new AccountDeletionBlockedError(payload.message ?? '이전할 자산이 있습니다.', payload.blockers);
    }
    throw new Error(payload?.message ?? '계정 종료를 신청하지 못했습니다.');
  }
  return (await response.json()) as AccountDeletionStatus & { cancelToken: string };
}

export async function cancelAccountDeletion(cancelToken: string): Promise<AccountDeletionStatus> {
  const response = await fetch(`${API_BASE}/v1/auth/account-deletion/cancel`, {
    method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cancelToken }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.message ?? '계정 종료 요청을 취소하지 못했습니다.');
  }
  return (await response.json()) as AccountDeletionStatus;
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
  payload: { redirectUri: string; returnTo?: string; agreeTerms?: boolean; agreePrivacy?: boolean },
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

export async function acceptOAuthSignupConsent(): Promise<Exclude<OAuthCompleteResponse, { consentRequired: true }>> {
  return postJson<Exclude<OAuthCompleteResponse, { consentRequired: true }>>('/v1/auth/oauth/signup/consent', {
    agreeTerms: true,
    agreePrivacy: true,
  });
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

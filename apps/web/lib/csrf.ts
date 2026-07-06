import { getApiBaseUrl } from './runtime-config';

let cachedToken: string | null = null;

export async function csrfHeaders(): Promise<Record<string, string>> {
  if (!cachedToken) {
    const response = await fetch(`${getApiBaseUrl()}/v1/auth/csrf`, {
      credentials: 'include'
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.csrfToken !== 'string') {
      return {};
    }
    cachedToken = body.csrfToken;
  }
  return { 'x-csrf-token': cachedToken };
}

export function clearCsrfToken(): void {
  cachedToken = null;
}

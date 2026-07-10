const DEFAULT_API_BASE = 'http://localhost:3000';

function browserFallbackApiBase(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_API_BASE;
  }
  const { hostname, origin } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return DEFAULT_API_BASE;
  }
  return `${origin}/api`;
}

export function normalizeApiBaseUrl(baseUrl?: string): string {
  const envBase = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  const internalBase = process.env.INTERNAL_API_BASE_URL?.trim();
  const fallback =
    typeof window === 'undefined'
      ? internalBase || (envBase?.startsWith('http') ? envBase : DEFAULT_API_BASE)
      : envBase || browserFallbackApiBase();
  const raw = baseUrl?.trim() || fallback;
  return raw.replace(/\/$/, '');
}

export function getApiBaseUrl(): string {
  return normalizeApiBaseUrl();
}

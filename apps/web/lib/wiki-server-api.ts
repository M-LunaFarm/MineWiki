import { cookies } from 'next/headers';
import { normalizeApiBaseUrl } from './runtime-config';
import type {
  WikiPageResponse,
  WikiRecentChangeSummary,
  WikiRevisionDiffResponse,
  WikiRevisionResponse,
  WikiRevisionSummary,
  WikiSearchResult
} from './wiki-api';

const API_BASE = normalizeApiBaseUrl(process.env.INTERNAL_API_BASE_URL);

export async function fetchWikiPageByPath(path: string): Promise<WikiPageResponse | null> {
  const params = new URLSearchParams({ path });
  const response = await wikiFetch(`/v1/wiki/page/by-path?${params.toString()}`);
  if (response.status === 404) return null;
  return readWikiResponse<WikiPageResponse>(response, `Failed to load wiki page (${path}).`);
}

export async function fetchWikiRevision(revisionId: string): Promise<WikiRevisionResponse> {
  const response = await wikiFetch(`/v1/wiki/revisions/${encodeURIComponent(revisionId)}`);
  return readWikiResponse<WikiRevisionResponse>(response, 'Failed to load wiki revision.');
}

export async function fetchWikiRevisions(pageId: string): Promise<WikiRevisionSummary[]> {
  const response = await wikiFetch(`/v1/wiki/pages/${encodeURIComponent(pageId)}/revisions`);
  return readWikiResponse<WikiRevisionSummary[]>(response, 'Failed to load wiki revisions.');
}

export async function fetchWikiRevisionDiff(leftId: string, rightId: string): Promise<WikiRevisionDiffResponse> {
  const response = await wikiFetch(
    `/v1/wiki/revisions/${encodeURIComponent(leftId)}/diff/${encodeURIComponent(rightId)}`
  );
  return readWikiResponse<WikiRevisionDiffResponse>(response, 'Failed to load wiki diff.');
}

export async function fetchWikiRecent(): Promise<WikiRecentChangeSummary[]> {
  const response = await wikiFetch('/v1/wiki/recent');
  return readWikiResponse<WikiRecentChangeSummary[]>(response, 'Failed to load recent wiki changes.');
}

export async function searchWiki(input: {
  readonly q: string;
  readonly namespace?: string;
  readonly limit?: number;
}): Promise<WikiSearchResult[]> {
  const params = new URLSearchParams({ q: input.q, limit: String(input.limit ?? 20) });
  if (input.namespace) params.set('namespace', input.namespace);
  const response = await wikiFetch(`/v1/wiki/search?${params.toString()}`);
  return readWikiResponse<WikiSearchResult[]>(response, 'Failed to search wiki.');
}

async function wikiFetch(path: string): Promise<Response> {
  const cookieHeader = (await cookies()).toString();
  return fetch(`${API_BASE}${path}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
    cache: 'no-store'
  });
}

async function readWikiResponse<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? fallback);
  }
  return response.json() as Promise<T>;
}

import { cookies } from 'next/headers';
import { normalizeApiBaseUrl } from './runtime-config';
import type {
  WikiPageResponse,
  WikiCategoryResponse,
  WikiContributionResponse,
  WikiRecentChangeListResponse,
  WikiRevisionDiffResponse,
  WikiRevisionResponse,
  WikiRenderedRevisionResponse,
  WikiRevisionListResponse,
  WikiSearchResult,
  WikiSearchResponse,
  WikiSpecialDocumentResponse,
  WikiSpecialDocumentType,
  WikiPublicBlockHistoryResponse,
  WikiPublicProfileResponse,
  WikiPublicStatsResponse,
  ServerWikiPresentation,
} from './wiki-api';

const API_BASE = normalizeApiBaseUrl(process.env.INTERNAL_API_BASE_URL);

export async function fetchWikiPublicStats(namespace?: string): Promise<WikiPublicStatsResponse> {
  const params = new URLSearchParams();
  if (namespace) params.set('namespace', namespace);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const response = await wikiFetch(`/v1/wiki/stats${suffix}`);
  return readWikiResponse<WikiPublicStatsResponse>(response, 'Failed to load public wiki stats.');
}

export async function fetchWikiPageByPath(path: string): Promise<WikiPageResponse | null> {
  const params = new URLSearchParams({ path });
  const response = await wikiFetch(`/v1/wiki/page/by-path?${params.toString()}`);
  if (response.status === 404) return null;
  return readWikiResponse<WikiPageResponse>(response, `Failed to load wiki page (${path}).`);
}

export async function fetchServerWikiPresentation(slug: string): Promise<ServerWikiPresentation | null> {
  const response = await wikiFetch(
    `/v1/wiki/server-wikis/${encodeURIComponent(slug)}/presentation`,
  );
  if (response.status === 404) return null;
  return readWikiResponse<ServerWikiPresentation>(
    response,
    'Failed to load server wiki presentation settings.',
  );
}

export async function fetchWikiRevision(revisionId: string): Promise<WikiRevisionResponse> {
  const response = await wikiFetch(`/v1/wiki/revisions/${encodeURIComponent(revisionId)}`);
  return readWikiResponse<WikiRevisionResponse>(response, 'Failed to load wiki revision.');
}

export async function fetchWikiRenderedRevision(revisionId: string): Promise<WikiRenderedRevisionResponse> {
  const response = await wikiFetch(`/v1/wiki/revisions/${encodeURIComponent(revisionId)}/rendered`);
  return readWikiResponse<WikiRenderedRevisionResponse>(response, 'Failed to load rendered wiki revision.');
}

export async function fetchWikiRevisions(pageId: string): Promise<WikiRevisionListResponse> {
  const response = await wikiFetch(`/v1/wiki/pages/${encodeURIComponent(pageId)}/revisions?limit=50`);
  return readWikiResponse<WikiRevisionListResponse>(response, 'Failed to load wiki revisions.');
}

export async function fetchWikiRevisionDiff(leftId: string, rightId: string): Promise<WikiRevisionDiffResponse> {
  const response = await wikiFetch(
    `/v1/wiki/revisions/${encodeURIComponent(leftId)}/diff/${encodeURIComponent(rightId)}`
  );
  return readWikiResponse<WikiRevisionDiffResponse>(response, 'Failed to load wiki diff.');
}

export async function fetchWikiRecent(input: { readonly changeType?: string; readonly namespace?: string; readonly minor?: string } = {}): Promise<WikiRecentChangeListResponse> {
  const params = new URLSearchParams({ limit: '30' });
  if (input.changeType) params.set('changeType', input.changeType);
  if (input.namespace) params.set('namespace', input.namespace);
  if (input.minor) params.set('minor', input.minor);
  const response = await wikiFetch(`/v1/wiki/recent?${params.toString()}`);
  return readWikiResponse<WikiRecentChangeListResponse>(response, 'Failed to load recent wiki changes.');
}

export async function fetchWikiContributions(profileId: string, cursor?: string, activity = 'edits'): Promise<WikiContributionResponse> {
  const params = new URLSearchParams({ limit: '30' });
  if (cursor) params.set('cursor', cursor);
  params.set('activity', activity);
  const response = await wikiFetch(
    `/v1/wiki/contributions/${encodeURIComponent(profileId)}?${params.toString()}`
  );
  return readWikiResponse<WikiContributionResponse>(response, 'Failed to load wiki contributions.');
}

export async function fetchWikiPublicProfile(username: string): Promise<WikiPublicProfileResponse | null> {
  const response = await wikiFetch(`/v1/wiki/profiles/${encodeURIComponent(username)}`);
  if (response.status === 404) return null;
  return readWikiResponse<WikiPublicProfileResponse>(response, 'Failed to load wiki user profile.');
}

export async function searchWiki(input: {
  readonly q: string;
  readonly namespace?: string;
  readonly serverSlug?: string;
  readonly target?: 'all' | 'title' | 'content';
  readonly limit?: number;
  readonly cursor?: string;
}): Promise<WikiSearchResponse> {
  const params = new URLSearchParams({ q: input.q, limit: String(input.limit ?? 20) });
  if (input.namespace) params.set('namespace', input.namespace);
  if (input.serverSlug) params.set('serverSlug', input.serverSlug);
  if (input.target) params.set('target', input.target);
  if (input.cursor) params.set('cursor', input.cursor);
  const response = await wikiFetch(`/v1/wiki/search?${params.toString()}`);
  return readWikiResponse<WikiSearchResponse>(response, 'Failed to search wiki.');
}

export async function fetchWikiSpecial(input: {
  readonly type: WikiSpecialDocumentType;
  readonly namespace?: string;
  readonly limit?: number;
}): Promise<WikiSpecialDocumentResponse> {
  const params = new URLSearchParams({ type: input.type, limit: String(input.limit ?? 50) });
  if (input.namespace) params.set('namespace', input.namespace);
  const response = await wikiFetch(`/v1/wiki/special?${params.toString()}`);
  return readWikiResponse<WikiSpecialDocumentResponse>(response, 'Failed to load special wiki documents.');
}

export async function fetchWikiBlockHistory(input: {
  readonly cursor?: string;
  readonly action?: 'block' | 'unblock';
  readonly query?: string;
  readonly limit?: number;
} = {}): Promise<WikiPublicBlockHistoryResponse> {
  const params = new URLSearchParams({ limit: String(input.limit ?? 50) });
  if (input.cursor) params.set('cursor', input.cursor);
  if (input.action) params.set('action', input.action);
  if (input.query) params.set('q', input.query);
  const response = await wikiFetch(`/v1/wiki/block-history?${params.toString()}`);
  return readWikiResponse<WikiPublicBlockHistoryResponse>(response, 'Failed to load wiki block history.');
}

export async function fetchWikiCategory(input: {
  readonly category: string;
  readonly namespace?: string;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<WikiCategoryResponse> {
  const params = new URLSearchParams({ category: input.category, limit: String(input.limit ?? 30) });
  if (input.namespace) params.set('namespace', input.namespace);
  if (input.cursor) params.set('cursor', input.cursor);
  const response = await wikiFetch(`/v1/wiki/categories?${params.toString()}`);
  return readWikiResponse<WikiCategoryResponse>(response, 'Failed to load wiki category.');
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

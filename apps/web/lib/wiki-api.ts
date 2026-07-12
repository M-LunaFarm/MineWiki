import { normalizeApiBaseUrl } from './runtime-config';
import { csrfHeaders } from './csrf';

function apiBaseUrl(): string {
  return normalizeApiBaseUrl();
}

export interface WikiPageResponse {
  readonly id: string;
  readonly namespace: string;
  readonly spaceId: string;
  readonly slug: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly pageType: string;
  readonly protectionLevel: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly revision: {
    readonly id: string;
    readonly revisionNo: number;
    readonly contentHash: string;
    readonly createdAt: string;
    readonly createdBy: string | null;
  };
  readonly html: string;
  readonly links: string[];
  readonly categories: string[];
  readonly redirectTarget: string | null;
  readonly redirectedFrom?: {
    readonly namespace: string;
    readonly title: string;
    readonly path: string;
  } | null;
  readonly serverDirectoryPath?: string | null;
  readonly serverWiki?: {
    readonly name: string;
    readonly slug: string;
    readonly host: string | null;
    readonly port: number | null;
    readonly edition: string;
    readonly supportedVersions: string | null;
    readonly genres: string | null;
    readonly isOnline: boolean | null;
    readonly playersOnline: number | null;
    readonly playersMax: number | null;
    readonly layout: 'docs' | 'handbook' | 'brand';
    readonly navigation: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly path: string;
      readonly current: boolean;
    }>;
  } | null;
}

export async function fetchWikiPageByPath(path: string): Promise<WikiPageResponse | null> {
  const searchParams = new URLSearchParams({ path });
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/page/by-path?${searchParams.toString()}`, {
    next: { revalidate: 60 }
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? `Failed to load wiki page (${path}).`);
  }
  return response.json();
}

export interface WikiRevisionResponse {
  readonly id: string;
  readonly pageId: string;
  readonly revisionNo: number;
  readonly parentRevisionId: string | null;
  readonly contentRaw: string;
  readonly contentHash: string;
  readonly contentSize: number;
  readonly syntaxVersion: string;
  readonly editSummary: string | null;
  readonly isMinor: boolean;
  readonly createdBy: string | null;
  readonly actorUserId: string | null;
  readonly createdAt: string;
  readonly visibility: string;
}

export interface WikiRevisionSummary {
  readonly id: string;
  readonly revisionNo: number;
  readonly editSummary: string | null;
  readonly isMinor: boolean;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly contentHash: string;
  readonly contentSize: number;
}

export interface WikiRevisionDiffResponse {
  readonly left: WikiRevisionResponse;
  readonly right: WikiRevisionResponse;
  readonly hunks: Array<{
    readonly type: 'context' | 'added' | 'removed';
    readonly line: string;
    readonly leftLine: number | null;
    readonly rightLine: number | null;
  }>;
}

export interface WikiRecentChangeSummary {
  readonly id: string;
  readonly pageId: string | null;
  readonly revisionId: string | null;
  readonly actorId: string | null;
  readonly changeType: string;
  readonly title: string;
  readonly namespaceCode: string;
  readonly summary: string | null;
  readonly isMinor: boolean;
  readonly createdAt: string;
}

export interface WikiSearchResult {
  readonly pageId: string;
  readonly namespace: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly routePath: string;
  readonly snippet: string;
  readonly updatedAt: string;
}

export interface WikiAdminRecentChange {
  readonly id: string;
  readonly pageId: string | null;
  readonly revisionId: string | null;
  readonly actorId: string | null;
  readonly changeType: string;
  readonly title: string;
  readonly namespaceCode: string;
  readonly summary: string | null;
  readonly createdAt: string;
}

export interface WikiAdminPageSummary {
  readonly id: string;
  readonly namespaceId: number;
  readonly spaceId: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly protectionLevel: string;
  readonly status: string;
  readonly currentRevisionId: string | null;
  readonly updatedAt: string;
}

export interface WikiAclRuleSummary {
  readonly id: string;
  readonly targetType: 'site' | 'namespace' | 'space' | 'page';
  readonly targetId: string | null;
  readonly action: string;
  readonly effect: 'allow' | 'deny';
  readonly subjectType: 'perm' | 'user' | 'group' | 'aclgroup' | 'role';
  readonly subjectValue: string;
  readonly sortOrder: number;
  readonly reason: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface WikiAclCatalog {
  readonly namespaces: ReadonlyArray<{ id: string; code: string; name: string }>;
  readonly spaces: ReadonlyArray<{ id: string; name: string; type: string; path: string }>;
  readonly pages: ReadonlyArray<{ id: string; name: string; spaceId: string }>;
  readonly groups: ReadonlyArray<{ code: string; name: string }>;
  readonly aclGroups: ReadonlyArray<{ id: string; key: string; name: string }>;
}

export interface WikiMutationResponse {
  readonly pageId: string;
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly namespace: string;
  readonly title: string;
  readonly slug: string;
}

export interface UploadedFileMetadata {
  readonly id: string;
  readonly ownerAccountId: string | null;
  readonly filename: string;
  readonly originalName: string | null;
  readonly mimeType: string;
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly hash: string;
  readonly publicPath: string;
  readonly usageContext: string;
  readonly visibility: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export async function fetchWikiRevision(revisionId: string): Promise<WikiRevisionResponse> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/revisions/${revisionId}`, {
    credentials: 'include'
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load wiki revision.');
  }
  return response.json();
}

export async function fetchWikiRevisions(pageId: string): Promise<WikiRevisionSummary[]> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/pages/${encodeURIComponent(pageId)}/revisions`, {
    credentials: 'include',
    next: { revalidate: 30 }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load wiki revisions.');
  }
  return response.json();
}

export async function fetchWikiRevisionDiff(leftId: string, rightId: string): Promise<WikiRevisionDiffResponse> {
  const response = await fetch(
    `${apiBaseUrl()}/v1/wiki/revisions/${encodeURIComponent(leftId)}/diff/${encodeURIComponent(rightId)}`,
    {
      credentials: 'include'
    }
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load wiki diff.');
  }
  return response.json();
}

export async function fetchWikiRecent(): Promise<WikiRecentChangeSummary[]> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/recent`, {
    credentials: 'include',
    next: { revalidate: 30 }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load recent wiki changes.');
  }
  return response.json();
}

export async function searchWiki(input: {
  q: string;
  namespace?: string;
  limit?: number;
}): Promise<WikiSearchResult[]> {
  const params = new URLSearchParams({
    q: input.q,
    limit: String(input.limit ?? 20)
  });
  if (input.namespace) {
    params.set('namespace', input.namespace);
  }
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/search?${params.toString()}`, {
    credentials: 'include',
    next: { revalidate: 30 }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to search wiki.');
  }
  return response.json();
}

export async function fetchWikiAdminRecent(): Promise<WikiAdminRecentChange[]> {
  return fetchWikiAdminJson('/recent');
}

export async function fetchWikiAdminPages(status?: string): Promise<WikiAdminPageSummary[]> {
  return fetchWikiAdminJson(`/pages${status ? `?status=${encodeURIComponent(status)}` : ''}`);
}

export async function fetchWikiAclRules(): Promise<WikiAclRuleSummary[]> {
  return fetchWikiAdminJson('/acl');
}

export async function fetchWikiAclCatalog(): Promise<WikiAclCatalog> {
  return fetchWikiAdminJson('/acl/catalog');
}

export async function createWikiAclRule(input: {
  targetType: WikiAclRuleSummary['targetType'];
  targetId: string | null;
  action: string;
  effect: WikiAclRuleSummary['effect'];
  subjectType: WikiAclRuleSummary['subjectType'];
  subjectValue: string;
  reason?: string;
  expiresAt?: string | null;
}): Promise<WikiAclRuleSummary> {
  return fetchWikiAdminJson('/acl', { method: 'POST', body: JSON.stringify(input) });
}

export async function deleteWikiAclRule(ruleId: string, reason?: string): Promise<void> {
  await fetchWikiAdminJson(`/acl/${encodeURIComponent(ruleId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ reason })
  });
}

export async function updateWikiPageProtection(input: {
  pageId: string;
  protectionLevel: string;
  reason?: string;
}): Promise<WikiAdminPageSummary> {
  return fetchWikiAdminJson(`/pages/${encodeURIComponent(input.pageId)}/protection`, {
    method: 'PATCH',
    body: JSON.stringify({
      protectionLevel: input.protectionLevel,
      reason: input.reason
    })
  });
}

export async function setWikiAdminPageDeleted(input: {
  pageId: string;
  deleted: boolean;
  reason?: string;
}): Promise<WikiAdminPageSummary> {
  return fetchWikiAdminJson(`/pages/${encodeURIComponent(input.pageId)}/${input.deleted ? 'delete' : 'restore'}`, {
    method: 'POST',
    body: JSON.stringify({ reason: input.reason })
  });
}

async function fetchWikiAdminJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}/v1/admin/wiki${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.method && init.method !== 'GET' ? await csrfHeaders() : {}),
      ...init?.headers
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load wiki admin data.');
  }
  return response.json();
}

export async function previewWikiMarkup(contentRaw: string): Promise<{ html: string; errors: string[]; blockingErrors: string[] }> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/preview`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify({ contentRaw })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to render preview.');
  }
  return response.json();
}

export async function saveWikiPage(input: {
  pageId?: string;
  namespace: string;
  title: string;
  contentRaw: string;
  editSummary: string;
  isMinor: boolean;
  baseRevisionId?: string;
}): Promise<WikiMutationResponse> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/pages${input.pageId ? `/${input.pageId}` : ''}`, {
    method: input.pageId ? 'PATCH' : 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify({
      namespace: input.namespace,
      title: input.title,
      contentRaw: input.contentRaw,
      editSummary: input.editSummary,
      isMinor: input.isMinor,
      baseRevisionId: input.baseRevisionId
    })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to save wiki page.');
  }
  return response.json();
}

export async function uploadWikiImage(input: {
  data: string;
  filename: string;
}): Promise<{ url: string; publicPath: string; id: string; filename: string }> {
  const response = await fetch(`${apiBaseUrl()}/v1/files/images`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify({
      data: input.data,
      filename: input.filename,
      usageContext: 'wiki_editor'
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.message ?? 'Failed to upload wiki image.');
  }
  return {
    id: String(body.id),
    filename: String(body.filename),
    url: String(body.url ?? body.publicPath),
    publicPath: String(body.publicPath ?? body.url)
  };
}

export async function listWikiFiles(input: {
  search?: string;
  limit?: number;
} = {}): Promise<UploadedFileMetadata[]> {
  const params = new URLSearchParams({
    usageContext: 'wiki_editor',
    limit: String(input.limit ?? 40)
  });
  if (input.search?.trim()) {
    params.set('search', input.search.trim());
  }
  const response = await fetch(`${apiBaseUrl()}/v1/files?${params.toString()}`, {
    credentials: 'include'
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to list wiki files.');
  }
  return response.json();
}

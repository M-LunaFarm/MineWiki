import { normalizeApiBaseUrl } from './runtime-config';

const baseUrl = normalizeApiBaseUrl();

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
  readonly serverDirectoryPath?: string | null;
}

export async function fetchWikiPageByPath(path: string): Promise<WikiPageResponse | null> {
  const searchParams = new URLSearchParams({ path });
  const response = await fetch(`${baseUrl}/v1/wiki/page/by-path?${searchParams.toString()}`, {
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

export interface WikiMutationResponse {
  readonly pageId: string;
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly namespace: string;
  readonly title: string;
  readonly slug: string;
}

export async function fetchWikiRevision(revisionId: string): Promise<WikiRevisionResponse> {
  const response = await fetch(`${baseUrl}/v1/wiki/revisions/${revisionId}`, {
    credentials: 'include'
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load wiki revision.');
  }
  return response.json();
}

export async function fetchWikiRevisions(pageId: string): Promise<WikiRevisionSummary[]> {
  const response = await fetch(`${baseUrl}/v1/wiki/pages/${encodeURIComponent(pageId)}/revisions`, {
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
    `${baseUrl}/v1/wiki/revisions/${encodeURIComponent(leftId)}/diff/${encodeURIComponent(rightId)}`,
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
  const response = await fetch(`${baseUrl}/v1/wiki/recent`, {
    credentials: 'include',
    next: { revalidate: 30 }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load recent wiki changes.');
  }
  return response.json();
}

export async function previewWikiMarkup(contentRaw: string): Promise<{ html: string; errors: string[] }> {
  const response = await fetch(`${baseUrl}/v1/wiki/preview`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
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
  const response = await fetch(`${baseUrl}/v1/wiki/pages${input.pageId ? `/${input.pageId}` : ''}`, {
    method: input.pageId ? 'PATCH' : 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
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

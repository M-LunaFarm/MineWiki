import { normalizeApiBaseUrl } from './runtime-config';
import { csrfHeaders } from './csrf';

function apiBaseUrl(): string {
  return normalizeApiBaseUrl();
}

export interface WikiEditConflictDetails {
  readonly type: 'wiki_edit_conflict';
  readonly scope: 'page' | 'section';
  readonly baseRevisionId: string;
  readonly currentRevisionId: string;
  readonly currentRevisionNo: number;
  readonly mergedContentRaw: string;
  readonly conflictCount: number;
}

export class WikiApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string | null,
    readonly details: unknown
  ) {
    super(message);
    this.name = 'WikiApiError';
  }
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
  readonly headings: ReadonlyArray<{
    readonly level: number;
    readonly title: string;
    readonly anchor: string;
  }>;
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
      readonly depth: number;
      readonly hasChildren: boolean;
    }>;
  } | null;
}

export async function fetchWikiPageByPath(path: string): Promise<WikiPageResponse | null> {
  const searchParams = new URLSearchParams({ path });
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/page/by-path?${searchParams.toString()}`, {
    next: { revalidate: 60 },
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

export interface WikiSectionEditResponse {
  readonly pageId: string;
  readonly anchor: string;
  readonly title: string;
  readonly contentRaw: string;
  readonly baseRevisionId: string;
}

export interface WikiSectionMutationResponse {
  readonly pageId: string;
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly namespace: string;
  readonly title: string;
  readonly slug: string;
  readonly sectionAnchor: string;
  readonly autoMerged?: boolean;
}

export interface WikiRevisionSummary {
  readonly id: string;
  readonly revisionNo: number;
  readonly editSummary: string | null;
  readonly isMinor: boolean;
  readonly createdBy: string | null;
  readonly createdByName: string | null;
  readonly createdAt: string;
  readonly contentHash: string;
  readonly contentSize: number;
}

export interface WikiRevisionListResponse {
  readonly items: WikiRevisionSummary[];
  readonly nextCursor: string | null;
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
  readonly routePath: string;
  readonly summary: string | null;
  readonly isMinor: boolean;
  readonly createdAt: string;
}

export interface WikiRecentChangeListResponse {
  readonly items: WikiRecentChangeSummary[];
  readonly nextCursor: string | null;
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

export interface WikiSearchResponse {
  readonly items: WikiSearchResult[];
  readonly nextCursor: string | null;
}

export interface WikiSearchSuggestionResponse {
  readonly items: WikiSearchResult[];
  readonly exactMatch: WikiSearchResult | null;
}

export type WikiSpecialDocumentType =
  | 'random'
  | 'orphaned'
  | 'orphaned_categories'
  | 'wanted'
  | 'categories'
  | 'uncategorized'
  | 'old'
  | 'long'
  | 'short';

export interface WikiSpecialDocumentResponse {
  readonly type: WikiSpecialDocumentType;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly pageId: string | null;
    readonly namespace: string;
    readonly title: string;
    readonly displayTitle: string;
    readonly routePath: string;
    readonly value: number | null;
    readonly updatedAt: string | null;
  }>;
}

export interface WikiCategoryResponse {
  readonly category: string;
  readonly document: {
    readonly pageId: string;
    readonly routePath: string;
  } | null;
  readonly parents: ReadonlyArray<{
    readonly category: string;
    readonly routePath: string;
  }>;
  readonly subcategories: ReadonlyArray<{
    readonly pageId: string;
    readonly category: string;
    readonly displayTitle: string;
    readonly routePath: string;
  }>;
  readonly isRoot: boolean;
  readonly isOrphan: boolean;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly pageId: string;
    readonly namespace: string;
    readonly title: string;
    readonly displayTitle: string;
    readonly routePath: string;
    readonly updatedAt: string;
  }>;
  readonly nextCursor: string | null;
}

export interface WikiDocumentTemplateSummary {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly scope: string;
  readonly targetArea: string;
  readonly defaultCategory: string | null;
  readonly contentRaw: string;
}

export interface WikiBlameResponse {
  readonly pageId: string;
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly revisionCount: number;
  readonly truncatedHistory: boolean;
  readonly lineCount: number;
  readonly truncatedLines: boolean;
  readonly lines: ReadonlyArray<{
    readonly lineNo: number;
    readonly content: string;
    readonly revisionId: string;
    readonly revisionNo: number;
    readonly createdBy: string | null;
    readonly createdByName: string;
    readonly createdAt: string;
  }>;
}

export interface WikiNotificationItem {
  readonly id: string;
  readonly type: string;
  readonly pageId: string | null;
  readonly actorProfileId: string | null;
  readonly actorName: string | null;
  readonly title: string;
  readonly message: string | null;
  readonly href: string;
  readonly read: boolean;
  readonly createdAt: string;
}

export interface WikiNotificationListResponse {
  readonly items: WikiNotificationItem[];
  readonly unreadCount: number;
  readonly nextCursor: string | null;
}

export interface WikiBacklinkItem {
  readonly id: string;
  readonly sourcePageId: string;
  readonly sourceRevisionId: string;
  readonly namespace: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly routePath: string;
  readonly linkType: string;
  readonly updatedAt: string;
}

export interface WikiBacklinkResponse {
  readonly items: WikiBacklinkItem[];
  readonly nextCursor: string | null;
}

export interface WikiContributionResponse {
  readonly activity: 'edits' | 'discussions' | 'edit-requests' | 'reviews';
  readonly profile: {
    readonly id: string;
    readonly username: string;
    readonly displayName: string;
    readonly status: string;
  };
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly kind: 'document' | 'discussion' | 'edit_request' | 'review';
    readonly pageId: string;
    readonly revisionId: string | null;
    readonly changeType: string;
    readonly title: string;
    readonly namespace: string;
    readonly routePath: string;
    readonly href: string;
    readonly summary: string | null;
    readonly isMinor: boolean;
    readonly status: string | null;
    readonly createdAt: string;
  }>;
  readonly nextCursor: string | null;
}

export interface WikiDeletedPageSummary {
  readonly id: string;
  readonly namespace: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly spaceId: string;
  readonly updatedAt: string;
}

export interface WikiThreadSummary {
  readonly id: string;
  readonly pageId: string;
  readonly title: string;
  readonly status: string;
  readonly createdBy: string;
  readonly createdByName: string;
  readonly commentCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WikiThreadListResponse {
  readonly items: WikiThreadSummary[];
  readonly nextCursor: string | null;
}

export interface WikiRecentThreadSummary extends WikiThreadSummary {
  readonly pageTitle: string;
  readonly namespace: string;
  readonly routePath: string;
  readonly discussionHref: string;
}

export interface WikiRecentThreadListResponse {
  readonly items: WikiRecentThreadSummary[];
  readonly nextCursor: string | null;
}

export interface WikiThreadDetail extends WikiThreadSummary {
  readonly canModerate: boolean;
  readonly canManagePage: boolean;
  readonly canReply: boolean;
  readonly subscribed: boolean;
  readonly pinnedCommentId: string | null;
  readonly olderCommentCursor: string | null;
  readonly newerCommentCursor: string | null;
  readonly nextCommentCursor: string | null;
  readonly comments: ReadonlyArray<{
    readonly id: string;
    readonly content: string | null;
    readonly status: string;
    readonly createdBy: string;
    readonly createdByName: string;
    readonly createdAt: string;
    readonly canDelete: boolean;
    readonly canChangeVisibility: boolean;
    readonly pinned: boolean;
  }>;
}

export interface WikiDiscussionPermissions {
  readonly canCreateThread: boolean;
}

export interface WikiWatchStatus {
  readonly watched: boolean;
  readonly unread: boolean;
}

export interface WikiWatchlistItem extends WikiWatchStatus {
  readonly pageId: string;
  readonly title: string;
  readonly namespace: string;
  readonly routePath: string;
  readonly updatedAt: string;
}

export interface WikiEditRequestSummary {
  readonly id: string;
  readonly pageId: string;
  readonly baseRevisionId: string;
  readonly proposedContent: string;
  readonly editSummary: string;
  readonly isMinor: boolean;
  readonly status: string;
  readonly createdBy: string;
  readonly createdByName: string;
  readonly reviewedBy: string | null;
  readonly reviewedByName: string | null;
  readonly reviewNote: string | null;
  readonly acceptedRevisionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedAt: string | null;
}

export interface WikiEditRequestListResponse {
  readonly items: WikiEditRequestSummary[];
  readonly canReview: boolean;
  readonly viewerProfileId: string | null;
  readonly nextCursor: string | null;
  readonly currentRevisionId: string | null;
}

export interface WikiEditRequestDiffResponse {
  readonly requestId: string;
  readonly baseRevisionId: string;
  readonly hunks: ReadonlyArray<{
    readonly type: 'context' | 'added' | 'removed';
    readonly line: string;
    readonly leftLine: number | null;
    readonly rightLine: number | null;
  }>;
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

export interface WikiAdminUserSummary {
  readonly id: string;
  readonly accountId: string | null;
  readonly username: string;
  readonly displayName: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WikiUserBlockEventSummary {
  readonly id: string;
  readonly targetProfileId: string;
  readonly targetName: string;
  readonly actorProfileId: string;
  readonly actorName: string;
  readonly action: string;
  readonly previousStatus: string;
  readonly newStatus: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface WikiBatchRollbackCandidate {
  readonly pageId: string;
  readonly title: string;
  readonly routePath: string | null;
  readonly expectedCurrentRevisionId: string | null;
  readonly rollbackToRevisionId: string | null;
  readonly affectedRevisionIds: string[];
  readonly action: 'rollback' | 'manual';
  readonly skipReason: string | null;
}

export interface WikiBatchRollbackPreview {
  readonly target: Pick<WikiAdminUserSummary, 'id' | 'username' | 'displayName' | 'status'>;
  readonly sinceMinutes: number;
  readonly candidates: WikiBatchRollbackCandidate[];
}

export interface WikiBatchRollbackExecution {
  readonly targetProfileId: string;
  readonly results: ReadonlyArray<{
    readonly pageId: string;
    readonly status: 'rolled_back' | 'skipped' | 'failed';
    readonly reason: string | null;
    readonly newRevisionId: string | null;
  }>;
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
  readonly namespaces: ReadonlyArray<{
    id: string;
    code: string;
    name: string;
  }>;
  readonly spaces: ReadonlyArray<{
    id: string;
    name: string;
    type: string;
    path: string;
  }>;
  readonly pages: ReadonlyArray<{ id: string; name: string; spaceId: string }>;
  readonly groups: ReadonlyArray<{ code: string; name: string }>;
  readonly aclGroups: ReadonlyArray<{ id: string; key: string; name: string }>;
}

export interface WikiPageAclResponse {
  readonly page: {
    readonly id: string;
    readonly spaceId: string;
    readonly namespaceId: number;
    readonly title: string;
    readonly displayTitle: string;
    readonly protectionLevel: string;
  };
  readonly actions: readonly string[];
  readonly rules: readonly WikiAclRuleSummary[];
  readonly canManage: boolean;
  readonly manageReason: string;
  readonly catalog: {
    readonly groups: ReadonlyArray<{ code: string; name: string }>;
    readonly aclGroups: ReadonlyArray<{ key: string; name: string }>;
    readonly roles: readonly string[];
  };
}

export interface WikiMutationResponse {
  readonly pageId: string;
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly namespace: string;
  readonly title: string;
  readonly slug: string;
  readonly autoMerged?: boolean;
}

export interface WikiMoveResponse extends WikiMutationResponse {
  readonly previousTitle: string;
  readonly redirectPageId: string | null;
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
  readonly license: string | null;
  readonly sourceUrl: string | null;
  readonly sourceText: string | null;
  readonly wikiDocumentPath: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export async function fetchWikiRevision(revisionId: string): Promise<WikiRevisionResponse> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/revisions/${revisionId}`, {
    credentials: 'include',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load wiki revision.');
  }
  return response.json();
}

export async function fetchWikiRaw(pageId: string, revisionId?: string): Promise<WikiRevisionResponse> {
  const params = new URLSearchParams();
  if (revisionId) params.set('revisionId', revisionId);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/pages/${encodeURIComponent(pageId)}/raw${suffix}`, {
    credentials: 'include',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load wiki source.');
  }
  return response.json();
}

export async function fetchWikiSection(pageId: string, anchor: string): Promise<WikiSectionEditResponse> {
  const response = await fetch(
    `${apiBaseUrl()}/v1/wiki/pages/${encodeURIComponent(pageId)}/sections/${encodeURIComponent(anchor)}`,
    { credentials: 'include' }
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load wiki section.');
  }
  return response.json();
}

export async function fetchWikiBacklinks(pageId: string, cursor?: string): Promise<WikiBacklinkResponse> {
  const params = new URLSearchParams({ limit: '30' });
  if (cursor) params.set('cursor', cursor);
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/pages/${encodeURIComponent(pageId)}/backlinks?${params.toString()}`, { credentials: 'include' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load wiki backlinks.');
  }
  return response.json();
}

export async function fetchWikiBlame(pageId: string): Promise<WikiBlameResponse> {
  return readWikiBrowser<WikiBlameResponse>(`/v1/wiki/pages/${encodeURIComponent(pageId)}/blame`);
}

export async function fetchWikiPageAcl(pageId: string): Promise<WikiPageAclResponse> {
  return readWikiBrowser<WikiPageAclResponse>(`/v1/wiki/pages/${encodeURIComponent(pageId)}/acl`);
}

export async function createWikiPageAclRule(
  pageId: string,
  input: {
    readonly action: string;
    readonly effect: WikiAclRuleSummary['effect'];
    readonly subjectType: WikiAclRuleSummary['subjectType'];
    readonly subjectValue: string;
    readonly reason?: string;
    readonly expiresAt?: string | null;
  },
): Promise<WikiAclRuleSummary> {
  return mutateWikiBrowser<WikiAclRuleSummary>(`/v1/wiki/pages/${encodeURIComponent(pageId)}/acl`, 'POST', input);
}

export async function deleteWikiPageAclRule(pageId: string, ruleId: string, reason?: string): Promise<void> {
  await mutateWikiBrowser(`/v1/wiki/pages/${encodeURIComponent(pageId)}/acl/${encodeURIComponent(ruleId)}`, 'DELETE', { reason });
}

export async function reorderWikiPageAclRules(
  pageId: string,
  input: {
    readonly action: string;
    readonly ruleIds: readonly string[];
    readonly reason?: string;
  },
): Promise<WikiAclRuleSummary[]> {
  return mutateWikiBrowser<WikiAclRuleSummary[]>(`/v1/wiki/pages/${encodeURIComponent(pageId)}/acl/order`, 'PATCH', input);
}

export async function fetchWikiNotifications(cursor?: string): Promise<WikiNotificationListResponse> {
  const params = new URLSearchParams({ limit: '30' });
  if (cursor) params.set('cursor', cursor);
  return readWikiBrowser<WikiNotificationListResponse>(`/v1/wiki/notifications?${params.toString()}`);
}

export async function markWikiNotificationRead(notificationId: string): Promise<{ readonly read: true }> {
  return mutateWikiBrowser<{ readonly read: true }>(`/v1/wiki/notifications/${encodeURIComponent(notificationId)}/read`, 'POST', {});
}

export async function markAllWikiNotificationsRead(throughId: string): Promise<{ readonly count: number }> {
  return mutateWikiBrowser<{ readonly count: number }>('/v1/wiki/notifications/read-all', 'POST', { throughId });
}

export async function fetchWikiDeletedPages(): Promise<WikiDeletedPageSummary[]> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/me/deleted-pages`, {
    credentials: 'include',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load deleted wiki pages.');
  }
  return response.json();
}

export async function fetchWikiThreads(pageId: string, cursor?: string): Promise<WikiThreadListResponse> {
  const params = new URLSearchParams({ limit: '30' });
  if (cursor) params.set('cursor', cursor);
  return readWikiBrowser<WikiThreadListResponse>(`/v1/wiki/pages/${encodeURIComponent(pageId)}/discussion-threads?${params.toString()}`);
}

export async function fetchWikiDiscussionPermissions(pageId: string): Promise<WikiDiscussionPermissions> {
  return readWikiBrowser<WikiDiscussionPermissions>(`/v1/wiki/pages/${encodeURIComponent(pageId)}/discussion-permissions`);
}

export async function fetchWikiThread(
  threadId: string,
  commentCursor?: string,
  focusCommentId?: string,
  commentDirection: 'older' | 'newer' = 'older',
): Promise<WikiThreadDetail> {
  const params = new URLSearchParams({ commentLimit: '100' });
  if (commentCursor) params.set('commentCursor', commentCursor);
  if (focusCommentId) params.set('focusCommentId', focusCommentId);
  if (commentCursor && commentDirection === 'newer') params.set('commentDirection', commentDirection);
  return readWikiBrowser<WikiThreadDetail>(`/v1/wiki/discussions/${encodeURIComponent(threadId)}?${params.toString()}`);
}

export async function fetchRecentWikiThreads(cursor?: string): Promise<WikiRecentThreadListResponse> {
  const params = new URLSearchParams({ limit: '30' });
  if (cursor) params.set('cursor', cursor);
  return readWikiBrowser<WikiRecentThreadListResponse>(`/v1/wiki/discussions/recent?${params.toString()}`);
}

export async function createWikiThread(input: { pageId: string; title: string; content: string }): Promise<WikiThreadDetail> {
  return mutateWikiBrowser<WikiThreadDetail>(`/v1/wiki/pages/${encodeURIComponent(input.pageId)}/discussions`, 'POST', {
    title: input.title,
    content: input.content,
  });
}

export async function addWikiThreadComment(input: { threadId: string; content: string }): Promise<WikiThreadDetail> {
  return mutateWikiBrowser<WikiThreadDetail>(`/v1/wiki/discussions/${encodeURIComponent(input.threadId)}/comments`, 'POST', {
    content: input.content,
  });
}

export async function setWikiThreadStatus(input: { threadId: string; status: 'open' | 'closed' }): Promise<WikiThreadDetail> {
  return mutateWikiBrowser<WikiThreadDetail>(`/v1/wiki/discussions/${encodeURIComponent(input.threadId)}/status`, 'PATCH', {
    status: input.status,
  });
}

export async function deleteWikiThreadComment(input: { threadId: string; commentId: string }): Promise<WikiThreadDetail> {
  return mutateWikiBrowser<WikiThreadDetail>(`/v1/wiki/discussions/${encodeURIComponent(input.threadId)}/comments/${encodeURIComponent(input.commentId)}`, 'DELETE', {});
}

export async function setWikiThreadCommentVisibility(input: { threadId: string; commentId: string; status: 'normal' | 'hidden'; reason: string }): Promise<WikiThreadDetail> {
  return mutateWikiBrowser<WikiThreadDetail>(`/v1/wiki/discussions/${encodeURIComponent(input.threadId)}/comments/${encodeURIComponent(input.commentId)}/visibility`, 'PATCH', { status: input.status, reason: input.reason });
}

export async function setWikiThreadSubscription(threadId: string, subscribed: boolean): Promise<{ readonly subscribed: boolean }> {
  return mutateWikiBrowser(`/v1/wiki/discussions/${encodeURIComponent(threadId)}/subscription`, 'POST', { subscribed });
}

export async function updateWikiThreadTopic(threadId: string, title: string): Promise<WikiThreadDetail> {
  return mutateWikiBrowser(`/v1/wiki/discussions/${encodeURIComponent(threadId)}/topic`, 'PATCH', { title });
}

export async function setWikiThreadPinnedComment(threadId: string, commentId: string | null): Promise<WikiThreadDetail> {
  return mutateWikiBrowser(`/v1/wiki/discussions/${encodeURIComponent(threadId)}/pin`, 'PATCH', { commentId });
}

export async function moveWikiThread(input: { threadId: string; pageId: string; reason?: string }): Promise<WikiThreadDetail> {
  return mutateWikiBrowser(`/v1/wiki/discussions/${encodeURIComponent(input.threadId)}/page`, 'PATCH', {
    pageId: input.pageId,
    reason: input.reason,
  });
}

export async function deleteWikiThread(threadId: string, reason?: string): Promise<{ readonly deleted: true; readonly threadId: string }> {
  return mutateWikiBrowser(`/v1/wiki/discussions/${encodeURIComponent(threadId)}`, 'DELETE', { reason });
}

export async function fetchWikiThreadCommentRaw(threadId: string, commentId: string): Promise<string> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/discussions/${encodeURIComponent(threadId)}/comments/${encodeURIComponent(commentId)}/raw`, {
    credentials: 'include',
  });
  const body = await response.text();
  if (!response.ok) {
    let message = body;
    try {
      message = JSON.parse(body)?.message ?? body;
    } catch {
      /* text response */
    }
    throw new Error(message || '댓글 원문을 불러오지 못했습니다.');
  }
  return body;
}

export async function fetchWikiWatchStatus(pageId: string): Promise<WikiWatchStatus> {
  return readWikiBrowser<WikiWatchStatus>(`/v1/wiki/pages/${encodeURIComponent(pageId)}/watch`);
}

export async function setWikiPageWatched(pageId: string, watched: boolean): Promise<WikiWatchStatus> {
  return mutateWikiBrowser<WikiWatchStatus>(`/v1/wiki/pages/${encodeURIComponent(pageId)}/watch`, watched ? 'PUT' : 'DELETE', {});
}

export async function markWikiPageWatchRead(pageId: string): Promise<WikiWatchStatus> {
  return mutateWikiBrowser<WikiWatchStatus>(`/v1/wiki/pages/${encodeURIComponent(pageId)}/watch/read`, 'POST', {});
}

export async function fetchWikiWatchlist(): Promise<WikiWatchlistItem[]> {
  return readWikiBrowser<WikiWatchlistItem[]>('/v1/wiki/watchlist');
}

export async function fetchWikiEditRequests(pageId: string, cursor?: string): Promise<WikiEditRequestListResponse> {
  const params = new URLSearchParams({ limit: '30' });
  if (cursor) params.set('cursor', cursor);
  return readWikiBrowser<WikiEditRequestListResponse>(`/v1/wiki/pages/${encodeURIComponent(pageId)}/edit-requests?${params.toString()}`);
}

export async function fetchWikiEditRequest(requestId: string): Promise<WikiEditRequestSummary> {
  return readWikiBrowser<WikiEditRequestSummary>(`/v1/wiki/edit-requests/${encodeURIComponent(requestId)}`);
}

export async function createWikiEditRequest(input: { pageId: string; baseRevisionId: string; contentRaw: string; editSummary: string; isMinor: boolean }): Promise<WikiEditRequestSummary> {
  return mutateWikiBrowser<WikiEditRequestSummary>(`/v1/wiki/pages/${encodeURIComponent(input.pageId)}/edit-requests`, 'POST', input);
}

export async function reviewWikiEditRequest(input: { requestId: string; action: 'accept' | 'reject'; reviewNote?: string }): Promise<WikiEditRequestSummary> {
  return mutateWikiBrowser<WikiEditRequestSummary>(`/v1/wiki/edit-requests/${encodeURIComponent(input.requestId)}/${input.action}`, 'POST', { reviewNote: input.reviewNote });
}

export async function updateWikiEditRequest(input: { requestId: string; baseRevisionId: string; contentRaw: string; editSummary: string; isMinor: boolean }): Promise<WikiEditRequestSummary> {
  return mutateWikiBrowser<WikiEditRequestSummary>(`/v1/wiki/edit-requests/${encodeURIComponent(input.requestId)}`, 'PATCH', input);
}

export async function rebaseWikiEditRequest(
  requestId: string,
  resolution?: {
    readonly contentRaw: string;
    readonly currentRevisionId: string;
    readonly editSummary: string;
    readonly isMinor: boolean;
  }
): Promise<WikiEditRequestSummary> {
  return mutateWikiBrowser<WikiEditRequestSummary>(
    `/v1/wiki/edit-requests/${encodeURIComponent(requestId)}/rebase`,
    'POST',
    resolution ?? {}
  );
}

export async function changeWikiEditRequestState(requestId: string, action: 'close' | 'reopen'): Promise<WikiEditRequestSummary> {
  return mutateWikiBrowser<WikiEditRequestSummary>(`/v1/wiki/edit-requests/${encodeURIComponent(requestId)}/${action}`, 'POST', {});
}

export async function fetchWikiEditRequestDiff(requestId: string): Promise<WikiEditRequestDiffResponse> {
  return readWikiBrowser<WikiEditRequestDiffResponse>(`/v1/wiki/edit-requests/${encodeURIComponent(requestId)}/diff`);
}

async function readWikiBrowser<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    credentials: 'include',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message ?? 'Wiki request failed.');
  return body as T;
}

async function mutateWikiBrowser<T>(path: string, method: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw wikiApiError(response, body, 'Wiki mutation failed.');
  return body as T;
}

export async function fetchWikiRevisions(pageId: string, cursor?: string): Promise<WikiRevisionListResponse> {
  const params = new URLSearchParams({ limit: '50' });
  if (cursor) params.set('cursor', cursor);
  return readWikiBrowser(`/v1/wiki/pages/${encodeURIComponent(pageId)}/revisions?${params.toString()}`);
}

export async function fetchWikiRevisionDiff(leftId: string, rightId: string): Promise<WikiRevisionDiffResponse> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/revisions/${encodeURIComponent(leftId)}/diff/${encodeURIComponent(rightId)}`, {
    credentials: 'include',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load wiki diff.');
  }
  return response.json();
}

export async function fetchWikiRecent(
  input: {
    cursor?: string;
    changeType?: string;
    namespace?: string;
    minor?: string;
  } = {},
): Promise<WikiRecentChangeListResponse> {
  const params = new URLSearchParams({ limit: '30' });
  if (input.cursor) params.set('cursor', input.cursor);
  if (input.changeType) params.set('changeType', input.changeType);
  if (input.namespace) params.set('namespace', input.namespace);
  if (input.minor) params.set('minor', input.minor);
  return readWikiBrowser(`/v1/wiki/recent?${params.toString()}`);
}

export async function searchWiki(input: { q: string; namespace?: string; limit?: number; cursor?: string }): Promise<WikiSearchResponse> {
  const params = new URLSearchParams({
    q: input.q,
    limit: String(input.limit ?? 20),
  });
  if (input.namespace) {
    params.set('namespace', input.namespace);
  }
  if (input.cursor) params.set('cursor', input.cursor);
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/search?${params.toString()}`, {
    credentials: 'include',
    next: { revalidate: 30 },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to search wiki.');
  }
  return response.json();
}

export async function fetchWikiSuggestions(query: string, limit = 8): Promise<WikiSearchSuggestionResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return readWikiBrowser<WikiSearchSuggestionResponse>(`/v1/wiki/search/suggest?${params.toString()}`);
}

export async function fetchWikiAdminRecent(): Promise<WikiAdminRecentChange[]> {
  return fetchWikiAdminJson('/recent');
}

export async function fetchWikiAdminPages(status?: string): Promise<WikiAdminPageSummary[]> {
  return fetchWikiAdminJson(`/pages${status ? `?status=${encodeURIComponent(status)}` : ''}`);
}

export async function fetchWikiAdminUsers(query?: string): Promise<WikiAdminUserSummary[]> {
  return fetchWikiAdminJson(`/users${query ? `?q=${encodeURIComponent(query)}` : ''}`);
}

export async function fetchWikiUserBlockEvents(targetProfileId?: string): Promise<WikiUserBlockEventSummary[]> {
  return fetchWikiAdminJson(`/user-block-events${targetProfileId ? `?targetProfileId=${encodeURIComponent(targetProfileId)}` : ''}`);
}

export async function setWikiAdminUserBlocked(input: { profileId: string; blocked: boolean; reason: string }): Promise<WikiAdminUserSummary> {
  return fetchWikiAdminJson(`/users/${encodeURIComponent(input.profileId)}/${input.blocked ? 'block' : 'unblock'}`, {
    method: 'POST',
    body: JSON.stringify({ reason: input.reason }),
  });
}

export async function previewWikiBatchRollback(input: {
  targetProfileId: string;
  sinceMinutes: number;
  limit?: number;
}): Promise<WikiBatchRollbackPreview> {
  return fetchWikiAdminJson('/batch-rollback/preview', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function executeWikiBatchRollback(input: {
  targetProfileId: string;
  sinceMinutes: number;
  reason: string;
  confirmUsername: string;
  candidates: ReadonlyArray<{ pageId: string; expectedCurrentRevisionId: string }>;
}): Promise<WikiBatchRollbackExecution> {
  return fetchWikiAdminJson('/batch-rollback/execute', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function fetchWikiAclRules(): Promise<WikiAclRuleSummary[]> {
  return fetchWikiAdminJson('/acl');
}

export async function fetchWikiAclCatalog(): Promise<WikiAclCatalog> {
  return fetchWikiAdminJson('/acl/catalog');
}

export async function createWikiAclRule(input: { targetType: WikiAclRuleSummary['targetType']; targetId: string | null; action: string; effect: WikiAclRuleSummary['effect']; subjectType: WikiAclRuleSummary['subjectType']; subjectValue: string; reason?: string; expiresAt?: string | null }): Promise<WikiAclRuleSummary> {
  return fetchWikiAdminJson('/acl', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function deleteWikiAclRule(ruleId: string, reason?: string): Promise<void> {
  await fetchWikiAdminJson(`/acl/${encodeURIComponent(ruleId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ reason }),
  });
}

export async function updateWikiPageProtection(input: { pageId: string; protectionLevel: string; reason?: string }): Promise<WikiAdminPageSummary> {
  return fetchWikiAdminJson(`/pages/${encodeURIComponent(input.pageId)}/protection`, {
    method: 'PATCH',
    body: JSON.stringify({
      protectionLevel: input.protectionLevel,
      reason: input.reason,
    }),
  });
}

export async function setWikiAdminPageDeleted(input: { pageId: string; deleted: boolean; reason?: string }): Promise<WikiAdminPageSummary> {
  return fetchWikiAdminJson(`/pages/${encodeURIComponent(input.pageId)}/${input.deleted ? 'delete' : 'restore'}`, {
    method: 'POST',
    body: JSON.stringify({ reason: input.reason }),
  });
}

async function fetchWikiAdminJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}/v1/admin/wiki${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.method && init.method !== 'GET' ? await csrfHeaders() : {}),
      ...init?.headers,
    },
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
    body: JSON.stringify({ contentRaw }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to render preview.');
  }
  return response.json();
}

export async function saveWikiPage(input: { pageId?: string; namespace: string; title: string; contentRaw: string; editSummary: string; isMinor: boolean; baseRevisionId?: string }): Promise<WikiMutationResponse> {
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
      baseRevisionId: input.baseRevisionId,
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw wikiApiError(response, body, 'Failed to save wiki page.');
  }
  return response.json();
}

export async function saveWikiSection(input: {
  pageId: string;
  anchor: string;
  contentRaw: string;
  editSummary: string;
  isMinor: boolean;
  baseRevisionId: string;
}): Promise<WikiSectionMutationResponse> {
  const response = await fetch(
    `${apiBaseUrl()}/v1/wiki/pages/${encodeURIComponent(input.pageId)}/sections/${encodeURIComponent(input.anchor)}`,
    {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
      body: JSON.stringify({
        contentRaw: input.contentRaw,
        editSummary: input.editSummary,
        isMinor: input.isMinor,
        baseRevisionId: input.baseRevisionId
      })
    }
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw wikiApiError(response, body, 'Failed to save wiki section.');
  }
  return response.json();
}

function wikiApiError(response: Response, body: unknown, fallback: string): WikiApiError {
  const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  return new WikiApiError(
    typeof payload.message === 'string' ? payload.message : fallback,
    response.status,
    typeof payload.code === 'string' ? payload.code : null,
    payload.details ?? null
  );
}

export async function moveWikiPage(input: { pageId: string; title: string; displayTitle?: string; reason: string; leaveRedirect: boolean }): Promise<WikiMoveResponse> {
  return mutateWikiPage(input.pageId, 'move', {
    title: input.title,
    displayTitle: input.displayTitle,
    reason: input.reason,
    leaveRedirect: input.leaveRedirect,
  });
}

export async function deleteWikiPage(input: { pageId: string; reason: string }): Promise<{ pageId: string; status: string }> {
  return mutateWikiPage(input.pageId, 'delete', { reason: input.reason });
}

export async function restoreWikiPage(input: { pageId: string; reason: string }): Promise<{ pageId: string; status: string }> {
  return mutateWikiPage(input.pageId, 'restore', { reason: input.reason });
}

export async function revertWikiPage(input: { pageId: string; revisionId: string; baseRevisionId: string; reason: string }): Promise<WikiMutationResponse> {
  return mutateWikiPage(input.pageId, 'revert', {
    revisionId: input.revisionId,
    baseRevisionId: input.baseRevisionId,
    reason: input.reason,
  });
}

async function mutateWikiPage<T>(pageId: string, action: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/pages/${encodeURIComponent(pageId)}/${action}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(responseBody?.message ?? `Failed to ${action} wiki page.`);
  }
  return responseBody as T;
}

export async function uploadWikiImage(input: {
  data: string;
  filename: string;
  pageId: string;
  license: string;
  sourceUrl?: string;
  sourceText?: string;
}): Promise<{ url: string; publicPath: string; id: string; filename: string; wikiDocumentPath: string | null }> {
  const response = await fetch(`${apiBaseUrl()}/v1/files/images`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify({
      data: input.data,
      filename: input.filename,
      usageContext: 'wiki_editor',
      visibility: 'restricted',
      license: input.license,
      sourceUrl: input.sourceUrl,
      sourceText: input.sourceText,
      linkedResourceType: 'wiki_page',
      linkedResourceId: input.pageId,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.message ?? 'Failed to upload wiki image.');
  }
  return {
    id: String(body.id),
    filename: String(body.filename),
    url: String(body.url ?? body.publicPath),
    publicPath: String(body.publicPath ?? body.url),
    wikiDocumentPath: typeof body.wikiDocumentPath === 'string' ? body.wikiDocumentPath : null,
  };
}

export async function listWikiFiles(
  input: {
    search?: string;
    limit?: number;
  } = {},
): Promise<UploadedFileMetadata[]> {
  const params = new URLSearchParams({
    usageContext: 'wiki_editor',
    limit: String(input.limit ?? 40),
  });
  if (input.search?.trim()) {
    params.set('search', input.search.trim());
  }
  const response = await fetch(`${apiBaseUrl()}/v1/files?${params.toString()}`, {
    credentials: 'include',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to list wiki files.');
  }
  return response.json();
}

export async function listWikiDocumentTemplates(pageId?: string): Promise<WikiDocumentTemplateSummary[]> {
  const params = new URLSearchParams();
  if (pageId) params.set('pageId', pageId);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return readWikiBrowser<WikiDocumentTemplateSummary[]>(`/v1/wiki/templates${suffix}`);
}

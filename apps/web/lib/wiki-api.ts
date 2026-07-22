import { normalizeApiBaseUrl } from './runtime-config';
import { csrfHeaders } from './csrf';
import { wikiRecentDiscussionQuery } from './wiki-discussion-status.mjs';

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

export interface WikiSwapCandidate {
  readonly pageId: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly currentRevisionId: string;
}

export interface WikiSwapResponsePage {
  readonly pageId: string;
  readonly namespace: string;
  readonly spaceId: string;
  readonly title: string;
  readonly slug: string;
  readonly revisionId: string;
  readonly revisionNo: number;
}

export interface WikiSwapResponse {
  readonly source: WikiSwapResponsePage;
  readonly target: WikiSwapResponsePage;
}

export interface WikiUsernameState {
  readonly username: string;
  readonly changedAt: string | null;
  readonly nextChangeAt: string | null;
  readonly canChange: boolean;
  readonly cooldownDays: number;
  readonly documentCount: number;
}

export interface WikiUsernameChangeResponse extends WikiUsernameState {
  readonly previousUsername: string;
  readonly movedDocumentCount: number;
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
  readonly categoryTags: ReadonlyArray<{
    readonly title: string;
    readonly label: string | null;
    readonly blurred: boolean;
  }>;
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
    readonly spaceId: string;
    readonly name: string;
    readonly slug: string;
    readonly contentSlug: string;
    readonly host: string | null;
    readonly port: number | null;
    readonly edition: string;
    readonly supportedVersions: string | null;
    readonly genres: string | null;
    readonly isOnline: boolean | null;
    readonly playersOnline: number | null;
    readonly playersMax: number | null;
    readonly directoryOverview: {
      readonly path: string;
      readonly shortDescription: string;
      readonly tags: readonly string[];
      readonly verificationGrade: 'Verified' | 'Unverified';
      readonly rank: {
        readonly current: number;
        readonly delta24h: number;
        readonly best: number;
        readonly updatedAt: string;
      } | null;
      readonly votes24h: number;
      readonly votesMonthly: number | null;
      readonly reviewsCount: number;
      readonly live: {
        readonly isOnline: boolean | null;
        readonly playersOnline: number | null;
        readonly playersMax: number | null;
        readonly updatedAt: string | null;
      };
      readonly websiteUrl: string | null;
      readonly discordUrl: string | null;
    } | null;
    readonly publicationStatus: 'draft' | 'published' | 'unpublished';
    readonly layout: 'docs' | 'handbook' | 'brand';
    readonly navigationKey: string;
    readonly previousDocument: ServerWikiNavigationDocumentLink | null;
    readonly nextDocument: ServerWikiNavigationDocumentLink | null;
    readonly navigation: ReadonlyArray<{
      readonly kind: 'group' | 'page';
      readonly id: string;
      readonly title: string;
      readonly path: string | null;
      readonly current: boolean;
      readonly depth: number;
      readonly hasChildren: boolean;
    }>;
  } | null;
}

export interface ServerWikiNavigationDocumentLink {
  readonly id: string;
  readonly title: string;
  readonly path: string;
}

export interface ServerWikiNavigationResponse {
  readonly key: string;
  readonly cacheable: boolean;
  readonly items: ReadonlyArray<{
    readonly kind: 'group' | 'page';
    readonly id: string;
    readonly title: string;
    readonly path: string | null;
    readonly depth: number;
    readonly hasChildren: boolean;
  }>;
}

export interface WikiRenderedRevisionResponse extends WikiPageResponse {
  readonly routePath: string;
  readonly currentRevisionId: string | null;
  readonly render: {
    readonly rendererVersion: string;
    readonly dependencyMode: 'live-current' | 'release-snapshot';
    readonly releaseId: string | null;
  };
  readonly revision: WikiPageResponse['revision'] & {
    readonly parentRevisionId: string | null;
    readonly editSummary: string | null;
    readonly editSummaryHidden: boolean;
    readonly isMinor: boolean;
    readonly contentSize: number;
    readonly syntaxVersion: string;
    readonly visibility: 'public';
    readonly isCurrent: boolean;
  };
}

export interface ServerWikiPresentation {
  readonly slug: string;
  readonly settingsVersion: number;
  readonly policy: {
    readonly html: string | null;
    readonly version: number;
    readonly required: boolean;
  };
  readonly editHelpHtml: string | null;
  readonly topNoticeHtml: string | null;
  readonly bottomNoticeHtml: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  readonly seoIndexingEnabled: boolean;
  readonly branding?: {
    readonly name: string | null;
    readonly logoUrl: string | null;
    readonly faviconUrl: string | null;
    readonly accentColor: string | null;
  } | null;
}

export interface WikiPolicyAcceptance {
  readonly version: number;
  readonly accepted: true;
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
  readonly editSummaryHidden: boolean;
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
  readonly editSummaryHidden: boolean;
  readonly isMinor: boolean;
  readonly createdBy: string | null;
  readonly createdByName: string | null;
  readonly createdByUsername: string | null;
  readonly createdAt: string;
  readonly contentHash: string;
  readonly contentSize: number;
  readonly previousPublicRevisionId: string | null;
  readonly sizeDelta: number | null;
}

export interface WikiPublicProfileResponse {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly status: 'active' | 'blocked';
  readonly createdAt: string;
  readonly documentPath: string;
  readonly documentExists: boolean;
  readonly contributionsPath: string;
  readonly isOwner: boolean;
  readonly canEditDocument: boolean;
  readonly requestedUsername: string;
  readonly canonicalUsername: string;
  readonly isAlias: boolean;
}

export interface WikiRevisionListResponse {
  readonly items: WikiRevisionSummary[];
  readonly nextCursor: string | null;
}

export interface WikiLifecycleIdentity {
  readonly namespace: string;
  readonly spaceId: string;
  readonly title: string;
  readonly path: string;
}

export interface WikiPageLifecycleEventSummary {
  readonly id: string;
  readonly eventType: 'move' | 'delete' | 'restore';
  readonly sourceRevisionId: string | null;
  readonly actorProfileId: string | null;
  readonly actorName: string | null;
  readonly actorUsername: string | null;
  readonly reason: string | null;
  readonly source: WikiLifecycleIdentity | null;
  readonly destination: WikiLifecycleIdentity | null;
  readonly identityRedacted: boolean;
  readonly createdAt: string;
}

export interface WikiPageLifecycleEventListResponse {
  readonly items: WikiPageLifecycleEventSummary[];
  readonly nextCursor: string | null;
}

export interface WikiPageAclHistoryEventSummary {
  readonly id: string;
  readonly actionType: string;
  readonly actorProfileId: string | null;
  readonly actorName: string | null;
  readonly actorUsername: string | null;
  readonly reason: string | null;
  readonly oldRules: unknown | null;
  readonly newRules: unknown | null;
  readonly detailsVisible: boolean;
  readonly createdAt: string;
}

export interface WikiPageAclHistoryEventListResponse {
  readonly items: WikiPageAclHistoryEventSummary[];
  readonly nextCursor: string | null;
  readonly detailsVisible: boolean;
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
  readonly previousPublicRevisionId: string | null;
  readonly actorId: string | null;
  readonly actorName: string;
  readonly actorUsername: string | null;
  readonly changeType: string;
  readonly title: string;
  readonly namespaceCode: string;
  readonly spaceId: string | null;
  readonly routePath: string;
  readonly summary: string | null;
  readonly summaryHidden: boolean;
  readonly sizeDelta: number | null;
  readonly canViewDiff: boolean;
  readonly isMinor: boolean;
  readonly createdAt: string;
}

export interface WikiRecentChangeListResponse {
  readonly items: WikiRecentChangeSummary[];
  readonly nextCursor: string | null;
}

export interface WikiPublicStatsResponse {
  readonly pageCount: number;
  readonly namespace: string | null;
  readonly generatedAt: string;
}

export interface WikiSearchResult {
  readonly pageId: string;
  readonly namespace: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly routePath: string;
  readonly snippet: string;
  readonly highlights?: {
    readonly title: ReadonlyArray<readonly [start: number, length: number]>;
    readonly snippet: ReadonlyArray<readonly [start: number, length: number]>;
  };
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
  readonly nextCursor: string | null;
  readonly generation?: string | null;
  readonly generatedAt?: string | null;
  readonly isRebuilding?: boolean;
  readonly isStale?: boolean;
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
    readonly pageId: string | null;
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

export interface WikiCreateContext {
  readonly namespace: string;
  readonly namespaceId: number;
  readonly spaceId: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly pageType: string;
  readonly canCreate: boolean;
  readonly canRequest: boolean;
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
export type WikiNotificationState = 'all' | 'unread' | 'read';

export type WikiReportTargetType = 'page' | 'revision' | 'discussion' | 'comment';
export type WikiReportStatus = 'open' | 'in_review' | 'resolved' | 'dismissed';

export interface WikiReportCase {
  readonly id: string;
  readonly targetType: WikiReportTargetType;
  readonly targetId: string;
  readonly pageId: string;
  readonly status: WikiReportStatus;
  readonly reportCount: number;
  readonly evidenceSnapshot: unknown;
  readonly assigneeProfileId: string | null;
  readonly assignedAt: string | null;
  readonly resolution: string | null;
  readonly version: number;
  readonly statusUpdatedAt: string;
  readonly createdAt: string;
  readonly recentSubmissions: ReadonlyArray<{ readonly id: string; readonly reporterProfileId: string | null; readonly reason: string; readonly createdAt: string }>;
}

export interface WikiReportQueueResponse {
  readonly items: WikiReportCase[];
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly snapshotAt: string;
}

export interface WikiPushStatus {
  readonly enabled: boolean;
  readonly subscribed: boolean;
  readonly publicKey: string | null;
  readonly publicKeyFingerprint: string | null;
  readonly endpointFingerprint: string | null;
  readonly expirationTime: string | null;
  readonly maxDevices: number;
}

export interface WikiPushSubscriptionInput {
  readonly endpoint: string;
  readonly expirationTime?: number | null;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

export interface WikiBacklinkItem {
  readonly id: string;
  readonly sourcePageId: string;
  readonly sourceRevisionId: string;
  readonly namespace: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly routePath: string;
  readonly linkTypes: WikiBacklinkType[];
  readonly updatedAt: string;
}

export type WikiBacklinkType = 'link' | 'file' | 'include' | 'redirect';

export interface WikiBacklinkResponse {
  readonly items: WikiBacklinkItem[];
  readonly prevCursor: string | null;
  readonly nextCursor: string | null;
  readonly summary: {
    readonly total: number;
    readonly complete: boolean;
    readonly namespaceCounts: ReadonlyArray<{ readonly namespace: string; readonly count: number }>;
    readonly typeCounts: ReadonlyArray<{ readonly type: WikiBacklinkType; readonly count: number }>;
  };
  readonly filters: {
    readonly types: WikiBacklinkType[];
    readonly namespace: string | null;
  };
}

export interface WikiContributionResponse {
  readonly activity: 'edits' | 'discussions' | 'edit-requests' | 'reviews';
  readonly profile: {
    readonly id: string;
    readonly username: string;
    readonly displayName: string;
    readonly status: string;
  };
  readonly requestedProfileId: string;
  readonly mergedProfileIds: string[];
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
    readonly summaryHidden: boolean;
    readonly isMinor: boolean;
    readonly status: string | null;
    readonly createdAt: string;
  }>;
  readonly nextCursor: string | null;
}

export interface WikiProfileMergeCounts {
  readonly historical: {
    readonly revisions: number;
    readonly recentChanges: number;
    readonly discussionThreads: number;
    readonly discussionComments: number;
    readonly editRequests: number;
  };
  readonly current: {
    readonly ownedPages: number;
    readonly ownedSpaces: number;
    readonly pendingUserDocuments: number;
    readonly watches: number;
    readonly discussionSubscriptions: number;
    readonly pollVotes: number;
    readonly notifications: number;
    readonly pushSubscriptions: number;
    readonly subwikiRoles: number;
    readonly aclMemberships: number;
    readonly directAclRules: number;
    readonly wikiGroups: number;
  };
}

export interface WikiProfileMergePreview {
  readonly target: { readonly id: string; readonly username: string; readonly displayName: string; readonly status: string };
  readonly candidates: ReadonlyArray<{
    readonly profile: { readonly id: string; readonly username: string; readonly displayName: string; readonly status: string };
    readonly counts: WikiProfileMergeCounts;
    readonly requiresBlockedStatus: boolean;
  }>;
  readonly pendingRequests: ReadonlyArray<{
    readonly request: WikiProfileMergeRequestResponse;
    readonly source: { readonly id: string; readonly username: string; readonly displayName: string; readonly status: string };
  }>;
  readonly policy: {
    readonly historicalActorsPreserved: true;
    readonly currentStateTransferred: true;
    readonly userDocumentsOverwritten: false;
    readonly adminApprovalRequired: true;
  };
}

export interface WikiProfileMergeRequestResponse {
  readonly id: string;
  readonly sourceProfileId: string;
  readonly targetProfileId: string;
  readonly status: string;
  readonly requestedAt: string;
}

export interface WikiProfileMergeAdminRequest extends WikiProfileMergeRequestResponse {
  readonly reason: string | null;
  readonly preview: {
    readonly profile: { readonly id: string; readonly username: string; readonly displayName: string; readonly status: string };
    readonly counts: WikiProfileMergeCounts;
    readonly requiresBlockedStatus: boolean;
  };
  readonly source: { readonly id: string; readonly username: string; readonly displayName: string; readonly status: string } | null;
  readonly target: { readonly id: string; readonly username: string; readonly displayName: string; readonly status: string } | null;
}

export function fetchWikiProfileMergePreview(): Promise<WikiProfileMergePreview> {
  return readWikiBrowser<WikiProfileMergePreview>('/v1/wiki/profile-merges/preview');
}

export async function requestWikiProfileMerge(input: {
  readonly sourceProfileId: string;
  readonly sourceUsername: string;
  readonly targetUsername: string;
  readonly reason?: string;
}): Promise<WikiProfileMergeRequestResponse> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/profile-merges`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify(input)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message ?? '위키 프로필 병합 요청을 접수하지 못했습니다.');
  return body as WikiProfileMergeRequestResponse;
}

export function fetchWikiProfileMergeRequests(status = 'pending'): Promise<WikiProfileMergeAdminRequest[]> {
  return fetchWikiAdminJson(`/profile-merges?status=${encodeURIComponent(status)}`);
}

export function approveWikiProfileMerge(input: {
  readonly requestId: string;
  readonly sourceUsername: string;
  readonly targetUsername: string;
  readonly reason: string;
}): Promise<WikiProfileMergeRequestResponse> {
  return fetchWikiAdminJson(`/profile-merges/${encodeURIComponent(input.requestId)}/approve`, {
    method: 'POST',
    body: JSON.stringify({
      sourceUsername: input.sourceUsername,
      targetUsername: input.targetUsername,
      reason: input.reason
    })
  });
}

export function rejectWikiProfileMerge(input: {
  readonly requestId: string;
  readonly reason: string;
}): Promise<WikiProfileMergeRequestResponse> {
  return fetchWikiAdminJson(`/profile-merges/${encodeURIComponent(input.requestId)}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason: input.reason })
  });
}

export interface WikiDeletedPageSummary {
  readonly id: string;
  readonly namespace: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly spaceId: string;
  readonly updatedAt: string;
}

export interface WikiDeletedPageListResponse {
  readonly items: WikiDeletedPageSummary[];
  readonly nextCursor: string | null;
}

export interface WikiDeletedPageRecoveryResponse {
  readonly page: WikiDeletedPageSummary & {
    readonly pageType: string;
    readonly latestPublicRevisionId: string;
    readonly canSelectHistoricalRevision: boolean;
  };
  readonly revisions: WikiRevisionListResponse;
  readonly lifecycle: WikiPageLifecycleEventListResponse;
  readonly selectedRevision: WikiRevisionSummary & {
    readonly html: string;
    readonly headings: WikiPageResponse['headings'];
  };
}

export interface WikiThreadSummary {
  readonly id: string;
  readonly pageId: string;
  readonly title: string;
  readonly status: string;
  readonly createdBy: string | null;
  readonly createdByName: string;
  readonly anonymous: boolean;
  readonly viewerOwns: boolean;
  readonly commentCount: number;
  /** Optional while API and web instances roll independently. */
  readonly preview?: WikiThreadPreview;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WikiThreadCommentPreview {
  readonly id: string;
  readonly status: string;
  readonly contentPreview: string | null;
  readonly truncated: boolean;
  readonly createdBy: string | null;
  readonly createdByName: string;
  readonly createdAt: string;
}

export interface WikiThreadPreview {
  readonly firstComment: WikiThreadCommentPreview | null;
  readonly recentComments: readonly WikiThreadCommentPreview[];
  readonly omittedCommentCount: number;
}

export interface WikiThreadListResponse {
  readonly items: WikiThreadSummary[];
  readonly nextCursor: string | null;
  /** Optional during rolling API deployments. */
  readonly statusCounts?: WikiDiscussionStatusCounts;
  readonly statusCountsComplete?: boolean;
}

export type WikiDiscussionStatus = 'open' | 'paused' | 'closed';
export type WikiDiscussionStatusFilter = 'all' | 'active' | WikiDiscussionStatus;

export interface WikiDiscussionStatusCounts {
  readonly total: number;
  readonly open: number;
  readonly paused: number;
  readonly closed: number;
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
  readonly canManageAcl: boolean;
  readonly canReply: boolean;
  readonly subscribed: boolean;
  readonly pinnedCommentId: string | null;
  readonly olderCommentCursor: string | null;
  readonly newerCommentCursor: string | null;
  readonly moderationHistoryTruncated: boolean;
  readonly nextCommentCursor: string | null;
  readonly comments: ReadonlyArray<{
    readonly id: string;
    readonly entryType?: 'comment' | 'system';
    readonly systemEvent?: {
      readonly type: 'status_change' | 'topic_change' | 'page_move' | 'pin_change';
      readonly before: string | null;
      readonly after: string | null;
      readonly beforeRedacted: boolean;
      readonly afterRedacted: boolean;
    } | null;
    readonly content: string | null;
    /** Sanitized restricted NamuMark from the API; optional during rolling deploys. */
    readonly contentHtml?: string | null;
    readonly status: string;
    readonly createdBy: string | null;
    readonly createdByName: string;
    readonly createdByUsername: string | null;
    readonly mentions: ReadonlyArray<{
      readonly username: string;
      readonly profileId: string;
      readonly start: number;
      readonly end: number;
    }>;
    readonly createdAt: string | null;
    readonly canDelete: boolean;
    readonly viewerOwns: boolean;
    readonly canChangeVisibility: boolean;
    readonly pinned: boolean;
    readonly poll: WikiDiscussionPollDetail | null;
    readonly moderationHistory: ReadonlyArray<{
      readonly id: string;
      readonly action: 'hide' | 'restore';
      readonly reason: string;
      readonly actorProfileId: string;
      readonly actorProfileName: string;
      readonly createdAt: string;
    }>;
  }>;
}

export type WikiDiscussionPollResultsVisibility = 'always' | 'after_vote' | 'closed';

export interface WikiDiscussionPollInput {
  readonly question: string;
  readonly options: readonly string[];
  readonly resultsVisibility: WikiDiscussionPollResultsVisibility;
  readonly closesAt?: string | null;
}

export interface WikiDiscussionPollDetail {
  readonly id: string;
  readonly question: string;
  readonly status: 'open' | 'closed';
  readonly resultsVisibility: WikiDiscussionPollResultsVisibility;
  readonly closesAt: string | null;
  readonly closedAt: string | null;
  readonly totalVoteCount: number | null;
  readonly selectedOptionId: string | null;
  readonly resultsVisible: boolean;
  readonly privilegedResults: boolean;
  readonly canVote: boolean;
  readonly canClose: boolean;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly position: number;
    readonly voteCount: number | null;
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

export interface WikiWatchlistResponse {
  readonly items: WikiWatchlistItem[];
  readonly nextCursor: string | null;
}

export interface WikiEditRequestSummary {
  readonly id: string;
  readonly requestKind: 'edit' | 'create';
  readonly pageId: string | null;
  readonly baseRevisionId: string | null;
  readonly targetNamespace: string | null;
  readonly targetSpaceId: string | null;
  readonly targetTitle: string | null;
  readonly targetDisplayTitle: string | null;
  readonly proposedContent: string;
  readonly editSummary: string | null;
  readonly editSummaryHidden: boolean;
  readonly isMinor: boolean;
  readonly status: string;
  readonly createdBy: string | null;
  readonly createdByName: string;
  readonly reviewedBy: string | null;
  readonly reviewedByName: string | null;
  readonly reviewNote: string | null;
  readonly acceptedRevisionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedAt: string | null;
  readonly viewerOwns: boolean;
}

export interface WikiEditRequestListResponse {
  readonly items: WikiEditRequestSummary[];
  readonly canReview: boolean;
  readonly viewerProfileId: string | null;
  readonly nextCursor: string | null;
  readonly currentRevisionId: string | null;
}

export interface WikiEditRequestQueueItem extends WikiEditRequestSummary {
  readonly pageTitle: string;
  readonly pageDisplayTitle: string;
  readonly namespace: string;
  readonly routePath: string;
  readonly detailPath: string;
  readonly currentRevisionId: string | null;
  readonly canReview: boolean;
  readonly isStale: boolean;
}

export interface WikiEditRequestQueueResponse {
  readonly items: WikiEditRequestQueueItem[];
  readonly viewerProfileId: string | null;
  readonly nextCursor: string | null;
}

export interface WikiEditRequestReviewableSummary {
  readonly count: number;
  readonly capped: boolean;
}

export interface ServerWikiReleaseReviewSummary {
  readonly count: number;
  readonly capped: boolean;
}

export interface WikiEditRequestDiffResponse {
  readonly requestId: string;
  readonly baseRevisionId: string | null;
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
  readonly namespaceCode?: string;
  readonly routePath?: string;
}

export interface WikiAdminRevisionSummary {
  readonly id: string;
  readonly pageId: string;
  readonly revisionNo: number;
  readonly parentRevisionId: string | null;
  readonly contentSize: number;
  readonly editSummary: string | null;
  readonly editSummaryHidden: boolean;
  readonly editSummaryModerationVersion: number;
  readonly isMinor: boolean;
  readonly createdBy: string | null;
  readonly createdByName: string;
  readonly createdAt: string;
  readonly visibility: string;
  readonly isCurrent: boolean;
}

export interface WikiAdminRevisionPage {
  readonly page: WikiAdminPageSummary;
  readonly items: WikiAdminRevisionSummary[];
  readonly nextCursor: string | null;
}

export interface WikiAdminRevisionDetail extends WikiAdminRevisionSummary {
  readonly contentRaw: string;
  readonly contentHash: string;
  readonly syntaxVersion: string;
  readonly page: WikiAdminPageSummary;
  readonly editSummaryModeration: {
    readonly action: 'hidden' | 'restored';
    readonly moderatorProfileId: string;
    readonly moderatorName: string;
    readonly moderatedAt: string;
    readonly reason: string;
  } | null;
}

export interface WikiAdminUserSummary {
  readonly id: string;
  readonly accountId: string | null;
  readonly username: string;
  readonly displayName: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly canonicalAccountId: string | null;
  readonly linkedProfileIds: string[];
  readonly linkedProfileCount: number;
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
  readonly publicReason: string | null;
  readonly createdAt: string;
}

export interface WikiPublicBlockEvent {
  readonly id: string;
  readonly target: { readonly profileId: string; readonly username: string | null; readonly displayName: string };
  readonly actor: { readonly profileId: string; readonly username: string | null; readonly displayName: string };
  readonly action: 'block' | 'unblock';
  readonly publicReason: string | null;
  readonly createdAt: string;
}

export interface WikiPublicBlockHistoryResponse {
  readonly items: WikiPublicBlockEvent[];
  readonly nextCursor: string | null;
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
  readonly targetType: 'site' | 'namespace' | 'space' | 'page' | 'thread';
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
  readonly aclGroups: ReadonlyArray<{
    id: string;
    key: string;
    name: string;
    status: string;
    scopeType: 'site' | 'space';
    spaceId: string | null;
  }>;
}

export type WikiApiTokenScope = 'wiki:read' | 'wiki:create' | 'wiki:edit';

export interface WikiApiTokenSummary {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly scopes: readonly WikiApiTokenScope[];
  readonly space: { readonly id: string; readonly name: string; readonly path: string } | null;
  readonly status: 'active' | 'expired' | 'revoked' | string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

export interface WikiApiTokenCreated extends WikiApiTokenSummary {
  readonly token: string;
}

export interface WikiApiTokenSpace {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly type: string;
}

export interface WikiAclGroupSummary {
  readonly id: string;
  readonly key: string;
  readonly scopeType: 'site' | 'space';
  readonly spaceId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly selfRemovable: boolean;
  readonly activeMemberCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WikiAclGroupMemberSummary {
  readonly id: string;
  readonly groupId: string;
  readonly memberType: 'user' | 'ip' | 'cidr';
  readonly userId: string | null;
  readonly userName: string | null;
  readonly cidr: string | null;
  readonly reason: string | null;
  readonly expiresAt: string | null;
  readonly addedBy: string | null;
  readonly addedAt: string;
  readonly removedAt: string | null;
}

export interface WikiAclGroupPage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
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
  readonly layers: ReadonlyArray<{
    readonly scope: 'page' | 'space' | 'namespace' | 'site';
    readonly targetId: string | null;
    readonly label: string;
    readonly editableHere: boolean;
    readonly rules: readonly WikiAclRuleSummary[];
  }>;
  readonly viewerTrace: ReadonlyArray<{
    readonly action: string;
    readonly matched: boolean;
    readonly allowed: boolean;
    readonly matchedScope: 'page' | 'space' | 'namespace' | 'site' | null;
    readonly matchedRuleId: string | null;
    readonly reason: string;
  }>;
  readonly evaluatedAt: string | null;
  readonly canManage: boolean;
  readonly manageReason: string;
  readonly catalog: {
    readonly groups: ReadonlyArray<{ code: string; name: string }>;
    readonly aclGroups: ReadonlyArray<{ key: string; name: string }>;
    readonly roles: readonly string[];
  };
}

export interface WikiThreadAclResponse {
  readonly thread: {
    readonly id: string;
    readonly pageId: string;
    readonly title: string;
    readonly status: string;
  };
  readonly page: {
    readonly id: string;
    readonly spaceId: string;
    readonly namespaceId: number;
    readonly title: string;
    readonly displayTitle: string;
  };
  readonly actions: readonly ['read', 'write_thread_comment'];
  readonly rules: readonly WikiAclRuleSummary[];
  readonly ruleSetHash: string | null;
  readonly canManage: boolean;
  readonly manageReason: string;
  readonly inheritance: {
    readonly read: 'page-boundary';
    readonly writeThreadComment: 'page' | 'thread-closed';
  };
  readonly catalog: WikiPageAclResponse['catalog'];
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
  readonly previousNamespace: string;
  readonly previousSpaceId: string;
  readonly spaceId: string;
  readonly movedPageCount: number;
  readonly redirectPageId: string | null;
}

export interface UploadedFileMetadata {
  readonly id: string;
  readonly ownerAccountId: string | null;
  readonly filename: string;
  readonly storageFilename: string;
  readonly wikiFilename: string | null;
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
  readonly linkedResourceType: string | null;
  readonly linkedResourceId: string | null;
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

export async function fetchWikiBacklinks(pageId: string, input: { readonly cursor?: string; readonly types?: readonly WikiBacklinkType[]; readonly namespace?: string | null; readonly limit?: number } = {}): Promise<WikiBacklinkResponse> {
  const params = new URLSearchParams({ limit: String(input.limit ?? 50) });
  if (input.cursor) params.set('cursor', input.cursor);
  if (input.types?.length) params.set('types', input.types.join(','));
  if (input.namespace) params.set('namespace', input.namespace);
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/pages/${encodeURIComponent(pageId)}/backlinks?${params.toString()}`, { credentials: 'include' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load wiki backlinks.');
  }
  return response.json();
}

export async function fetchWikiBlame(pageId: string, revisionId?: string): Promise<WikiBlameResponse> {
  const params = new URLSearchParams();
  if (revisionId) params.set('revisionId', revisionId);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return readWikiBrowser<WikiBlameResponse>(`/v1/wiki/pages/${encodeURIComponent(pageId)}/blame${suffix}`);
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

export async function fetchWikiThreadAcl(threadId: string): Promise<WikiThreadAclResponse> {
  return readWikiBrowser<WikiThreadAclResponse>(`/v1/wiki/discussions/${encodeURIComponent(threadId)}/acl`);
}

export async function createWikiThreadAclRule(
  threadId: string,
  input: {
    readonly action: 'read' | 'write_thread_comment';
    readonly effect: WikiAclRuleSummary['effect'];
    readonly subjectType: WikiAclRuleSummary['subjectType'];
    readonly subjectValue: string;
    readonly reason?: string;
    readonly expiresAt?: string | null;
  },
): Promise<{ readonly rule: WikiAclRuleSummary; readonly ruleSetHash: string }> {
  return mutateWikiBrowser(`/v1/wiki/discussions/${encodeURIComponent(threadId)}/acl`, 'POST', input);
}

export async function deleteWikiThreadAclRule(threadId: string, ruleId: string, reason?: string): Promise<{
  readonly deleted: true;
  readonly ruleId: string;
  readonly ruleSetHash: string;
}> {
  return mutateWikiBrowser(`/v1/wiki/discussions/${encodeURIComponent(threadId)}/acl/${encodeURIComponent(ruleId)}`, 'DELETE', { reason });
}

export async function reorderWikiThreadAclRules(
  threadId: string,
  input: {
    readonly action: 'read' | 'write_thread_comment';
    readonly ruleIds: readonly string[];
    readonly expectedRuleSetHash: string;
    readonly reason?: string;
  },
): Promise<{ readonly rules: WikiAclRuleSummary[]; readonly ruleSetHash: string }> {
  return mutateWikiBrowser(`/v1/wiki/discussions/${encodeURIComponent(threadId)}/acl/order`, 'PATCH', input);
}

export async function fetchWikiNotifications(cursor?: string, state: WikiNotificationState = 'all'): Promise<WikiNotificationListResponse> {
  const params = new URLSearchParams({ limit: '30', state });
  if (cursor) params.set('cursor', cursor);
  return readWikiBrowser<WikiNotificationListResponse>(`/v1/wiki/notifications?${params.toString()}`);
}

export async function markWikiNotificationRead(notificationId: string): Promise<{ readonly read: true }> {
  return mutateWikiBrowser<{ readonly read: true }>(`/v1/wiki/notifications/${encodeURIComponent(notificationId)}/read`, 'POST', {}, { keepalive: true });
}

export async function markWikiNotificationUnread(notificationId: string): Promise<{ readonly read: false }> {
  return mutateWikiBrowser<{ readonly read: false }>(`/v1/wiki/notifications/${encodeURIComponent(notificationId)}/unread`, 'POST', {});
}

export async function createWikiReport(input: { readonly targetType: WikiReportTargetType; readonly targetId: string; readonly reason: string }): Promise<{ readonly caseId: string; readonly deduplicated: boolean; readonly reportCount: 1 }> {
  return mutateWikiBrowser('/v1/wiki/reports', 'POST', input);
}

export async function fetchWikiReportQueue(input: { readonly status?: WikiReportStatus; readonly targetType?: WikiReportTargetType; readonly assignee?: 'me' | 'unassigned'; readonly cursor?: string } = {}): Promise<WikiReportQueueResponse> {
  const params = new URLSearchParams({ limit: '20' });
  if (input.status) params.set('status', input.status);
  if (input.targetType) params.set('targetType', input.targetType);
  if (input.assignee) params.set('assignee', input.assignee);
  if (input.cursor) params.set('cursor', input.cursor);
  return readWikiBrowser(`/v1/admin/wiki/reports?${params.toString()}`);
}

export async function assignWikiReport(caseId: string, expectedVersion: number, assigneeProfileId?: string | null): Promise<WikiReportCase> {
  return mutateWikiBrowser(`/v1/admin/wiki/reports/${encodeURIComponent(caseId)}/assignment`, 'PATCH', { expectedVersion, assigneeProfileId });
}

export async function transitionWikiReport(caseId: string, expectedVersion: number, status: WikiReportStatus, resolution?: string): Promise<WikiReportCase> {
  return mutateWikiBrowser(`/v1/admin/wiki/reports/${encodeURIComponent(caseId)}/status`, 'PATCH', { expectedVersion, status, resolution });
}

export async function markAllWikiNotificationsRead(throughId: string): Promise<{ readonly count: number }> {
  return mutateWikiBrowser<{ readonly count: number }>('/v1/wiki/notifications/read-all', 'POST', { throughId });
}

export async function fetchWikiPushStatus(): Promise<WikiPushStatus> {
  return readWikiBrowser<WikiPushStatus>('/v1/wiki/notifications/push');
}

export async function registerWikiPushSubscription(input: WikiPushSubscriptionInput): Promise<WikiPushStatus> {
  return mutateWikiBrowser<WikiPushStatus>('/v1/wiki/notifications/push/subscription', 'PUT', { ...input });
}

export async function unregisterWikiPushSubscription(): Promise<{ readonly removed: boolean }> {
  return mutateWikiBrowser<{ readonly removed: boolean }>('/v1/wiki/notifications/push/subscription', 'DELETE', {});
}

export async function fetchWikiDeletedPages(input: { readonly cursor?: string; readonly spaceId?: string } = {}): Promise<WikiDeletedPageListResponse> {
  const params = new URLSearchParams({ limit: '50' });
  if (input.cursor) params.set('cursor', input.cursor);
  if (input.spaceId) params.set('spaceId', input.spaceId);
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/me/deleted-pages?${params.toString()}`, {
    credentials: 'include',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to load deleted wiki pages.');
  }
  return response.json();
}

export async function fetchWikiDeletedPageRecovery(input: {
  readonly pageId: string;
  readonly revisionId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<WikiDeletedPageRecoveryResponse> {
  const params = new URLSearchParams();
  if (input.revisionId) params.set('revisionId', input.revisionId);
  if (input.cursor) params.set('cursor', input.cursor);
  if (input.limit) params.set('limit', input.limit.toString());
  const query = params.size > 0 ? `?${params.toString()}` : '';
  return readWikiBrowser(`/v1/wiki/me/deleted-pages/${encodeURIComponent(input.pageId)}/recovery${query}`);
}

export async function fetchWikiThreads(pageId: string, cursor?: string, status: WikiDiscussionStatusFilter = 'all'): Promise<WikiThreadListResponse> {
  const params = new URLSearchParams({ limit: '30', preview: 'first-latest' });
  if (cursor) params.set('cursor', cursor);
  if (status !== 'all') params.set('status', status);
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
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/discussions/${encodeURIComponent(threadId)}?${params.toString()}`, {
    credentials: 'include',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw wikiApiError(response, body, 'Failed to load wiki discussion.');
  return body as WikiThreadDetail;
}

export function wikiDiscussionEventsUrl(threadId: string): string {
  return `${apiBaseUrl()}/v1/wiki/discussions/${encodeURIComponent(threadId)}/events`;
}

export async function fetchRecentWikiThreads(input: {
  readonly cursor?: string;
  readonly status?: 'all' | 'active' | 'open' | 'paused' | 'closed';
  readonly sort?: 'newest' | 'oldest';
  readonly serverSlug?: string;
  readonly signal?: AbortSignal;
} = {}): Promise<WikiRecentThreadListResponse> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/discussions/recent?${wikiRecentDiscussionQuery(input)}`, {
    credentials: 'include', signal: input.signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message ?? 'Failed to load recent wiki discussions.');
  return body as WikiRecentThreadListResponse;
}

export async function createWikiThread(input: { pageId: string; title: string; content: string; poll?: WikiDiscussionPollInput; captchaToken?: string }): Promise<WikiThreadDetail> {
  return mutateWikiBrowser<WikiThreadDetail>(`/v1/wiki/pages/${encodeURIComponent(input.pageId)}/discussions`, 'POST', {
    title: input.title,
    content: input.content,
    poll: input.poll,
    captchaToken: input.captchaToken,
  });
}

export async function addWikiThreadComment(input: { threadId: string; content: string; poll?: WikiDiscussionPollInput; captchaToken?: string }): Promise<WikiThreadDetail> {
  return mutateWikiBrowser<WikiThreadDetail>(`/v1/wiki/discussions/${encodeURIComponent(input.threadId)}/comments`, 'POST', {
    content: input.content,
    poll: input.poll,
    captchaToken: input.captchaToken,
  });
}

export async function voteWikiDiscussionPoll(input: { threadId: string; pollId: string; optionId: string }): Promise<WikiThreadDetail> {
  return mutateWikiBrowser<WikiThreadDetail>(`/v1/wiki/discussions/${encodeURIComponent(input.threadId)}/polls/${encodeURIComponent(input.pollId)}/vote`, 'POST', {
    optionId: input.optionId,
  });
}

export async function closeWikiDiscussionPoll(input: { threadId: string; pollId: string }): Promise<WikiThreadDetail> {
  return mutateWikiBrowser<WikiThreadDetail>(`/v1/wiki/discussions/${encodeURIComponent(input.threadId)}/polls/${encodeURIComponent(input.pollId)}/close`, 'POST', {});
}

export async function setWikiThreadStatus(input: { threadId: string; status: WikiDiscussionStatus }): Promise<WikiThreadDetail> {
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

export async function fetchWikiWatchlist(cursor?: string, serverSlug?: string): Promise<WikiWatchlistResponse> {
  const params = new URLSearchParams({ limit: '50' });
  if (cursor) params.set('cursor', cursor);
  if (serverSlug) params.set('serverSlug', serverSlug);
  return readWikiBrowser<WikiWatchlistResponse>(`/v1/wiki/watchlist?${params.toString()}`);
}

export async function fetchWikiEditRequests(pageId: string, cursor?: string): Promise<WikiEditRequestListResponse> {
  const params = new URLSearchParams({ limit: '30' });
  if (cursor) params.set('cursor', cursor);
  return readWikiBrowser<WikiEditRequestListResponse>(`/v1/wiki/pages/${encodeURIComponent(pageId)}/edit-requests?${params.toString()}`);
}

export async function fetchWikiEditRequestQueue(input: {
  readonly status?: string;
  readonly scope?: string;
  readonly namespace?: string;
  readonly cursor?: string;
} = {}): Promise<WikiEditRequestQueueResponse> {
  const params = new URLSearchParams({ limit: '30' });
  if (input.status) params.set('status', input.status);
  if (input.scope) params.set('scope', input.scope);
  if (input.namespace) params.set('namespace', input.namespace);
  if (input.cursor) params.set('cursor', input.cursor);
  return readWikiBrowser<WikiEditRequestQueueResponse>(`/v1/wiki/edit-requests?${params.toString()}`);
}

export async function fetchWikiEditRequestReviewableSummary(): Promise<WikiEditRequestReviewableSummary> {
  return readWikiBrowser<WikiEditRequestReviewableSummary>('/v1/wiki/edit-requests/reviewable-summary');
}

export async function fetchServerWikiReleaseReviewSummary(): Promise<ServerWikiReleaseReviewSummary> {
  return readWikiBrowser<ServerWikiReleaseReviewSummary>('/v1/wiki/release-reviews/summary');
}

export async function fetchWikiEditRequest(requestId: string): Promise<WikiEditRequestSummary> {
  return readWikiBrowser<WikiEditRequestSummary>(`/v1/wiki/edit-requests/${encodeURIComponent(requestId)}`);
}

export async function fetchWikiEditRequestContext(requestId: string): Promise<WikiEditRequestListResponse> {
  return readWikiBrowser<WikiEditRequestListResponse>(`/v1/wiki/edit-requests/${encodeURIComponent(requestId)}/context`);
}

export async function createWikiEditRequest(input: { pageId: string; baseRevisionId: string; contentRaw: string; editSummary: string; isMinor: boolean; captchaToken?: string; policyAcceptance?: WikiPolicyAcceptance }): Promise<WikiEditRequestSummary> {
  return mutateWikiBrowser<WikiEditRequestSummary>(`/v1/wiki/pages/${encodeURIComponent(input.pageId)}/edit-requests`, 'POST', input);
}

export async function createWikiPageRequest(input: { namespace: string; title: string; spaceId?: string; contentRaw: string; editSummary: string; isMinor: boolean; captchaToken?: string; policyAcceptance?: WikiPolicyAcceptance }): Promise<WikiEditRequestSummary> {
  return mutateWikiBrowser<WikiEditRequestSummary>('/v1/wiki/edit-requests', 'POST', input);
}

export async function reviewWikiEditRequest(input: { requestId: string; action: 'accept' | 'reject'; reviewNote?: string }): Promise<WikiEditRequestSummary> {
  return mutateWikiBrowser<WikiEditRequestSummary>(`/v1/wiki/edit-requests/${encodeURIComponent(input.requestId)}/${input.action}`, 'POST', { reviewNote: input.reviewNote });
}

export async function updateWikiEditRequest(input: { requestId: string; baseRevisionId?: string; contentRaw: string; editSummary: string; isMinor: boolean }): Promise<WikiEditRequestSummary> {
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

export async function claimWikiEditRequest(requestId: string): Promise<WikiEditRequestSummary> {
  return mutateWikiBrowser<WikiEditRequestSummary>(`/v1/wiki/edit-requests/${encodeURIComponent(requestId)}/claim`, 'POST', {});
}

export async function fetchWikiEditRequestDiff(requestId: string): Promise<WikiEditRequestDiffResponse> {
  return readWikiBrowser<WikiEditRequestDiffResponse>(`/v1/wiki/edit-requests/${encodeURIComponent(requestId)}/diff`);
}

export async function listWikiApiTokens(): Promise<WikiApiTokenSummary[]> {
  return readWikiBrowser<WikiApiTokenSummary[]>('/v1/wiki/api-tokens');
}

export async function listWikiApiTokenSpaces(): Promise<WikiApiTokenSpace[]> {
  return readWikiBrowser<WikiApiTokenSpace[]>('/v1/wiki/api-tokens/spaces');
}

export async function createWikiApiToken(input: {
  readonly name: string;
  readonly scopes: readonly WikiApiTokenScope[];
  readonly spaceId?: string;
  readonly expiresInDays: number;
}): Promise<WikiApiTokenCreated> {
  return mutateWikiBrowser<WikiApiTokenCreated>('/v1/wiki/api-tokens', 'POST', {
    name: input.name,
    scopes: [...input.scopes],
    spaceId: input.spaceId || null,
    expiresInDays: input.expiresInDays,
  });
}

export async function revokeWikiApiToken(tokenId: string): Promise<{ readonly revoked: true }> {
  return mutateWikiBrowser<{ readonly revoked: true }>(
    `/v1/wiki/api-tokens/${encodeURIComponent(tokenId)}`,
    'DELETE',
    {},
  );
}

async function readWikiBrowser<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    credentials: 'include',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message ?? 'Wiki request failed.');
  return body as T;
}

async function mutateWikiBrowser<T>(path: string, method: string, payload: Record<string, unknown>, options: { readonly keepalive?: boolean } = {}): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify(payload),
    keepalive: options.keepalive,
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

export async function fetchWikiPageLifecycleEvents(pageId: string, cursor?: string): Promise<WikiPageLifecycleEventListResponse> {
  const params = new URLSearchParams({ limit: '50' });
  if (cursor) params.set('cursor', cursor);
  return readWikiBrowser(`/v1/wiki/pages/${encodeURIComponent(pageId)}/lifecycle?${params.toString()}`);
}

export async function fetchWikiPageAclHistoryEvents(pageId: string, cursor?: string): Promise<WikiPageAclHistoryEventListResponse> {
  const params = new URLSearchParams({ limit: '50' });
  if (cursor) params.set('cursor', cursor);
  return readWikiBrowser(`/v1/wiki/pages/${encodeURIComponent(pageId)}/acl-history?${params.toString()}`);
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
    spaceId?: string;
    minor?: string;
  } = {},
): Promise<WikiRecentChangeListResponse> {
  const params = new URLSearchParams({ limit: '30' });
  if (input.cursor) params.set('cursor', input.cursor);
  if (input.changeType) params.set('changeType', input.changeType);
  if (input.namespace) params.set('namespace', input.namespace);
  if (input.spaceId) params.set('spaceId', input.spaceId);
  if (input.minor) params.set('minor', input.minor);
  return readWikiBrowser(`/v1/wiki/recent?${params.toString()}`);
}

export async function searchWiki(input: { q: string; namespace?: string; target?: 'all' | 'title' | 'content'; limit?: number; cursor?: string }): Promise<WikiSearchResponse> {
  const params = new URLSearchParams({
    q: input.q,
    limit: String(input.limit ?? 20),
  });
  if (input.namespace) {
    params.set('namespace', input.namespace);
  }
  if (input.target) params.set('target', input.target);
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

export async function fetchWikiAdminPageRevisions(
  pageId: string,
  input: { cursor?: string; limit?: number } = {}
): Promise<WikiAdminRevisionPage> {
  const params = new URLSearchParams({ limit: String(input.limit ?? 50) });
  if (input.cursor) params.set('cursor', input.cursor);
  return fetchWikiAdminJson(`/pages/${encodeURIComponent(pageId)}/revisions?${params.toString()}`);
}

export async function fetchWikiAdminRevision(revisionId: string): Promise<WikiAdminRevisionDetail> {
  return fetchWikiAdminJson(`/revisions/${encodeURIComponent(revisionId)}`);
}

export async function updateWikiAdminRevisionVisibility(input: {
  revisionId: string;
  visibility: 'public' | 'hidden' | 'deleted' | 'private';
  reason: string;
}): Promise<{ revisionId: string; visibility: string }> {
  return fetchWikiAdminJson(`/revisions/${encodeURIComponent(input.revisionId)}/visibility`, {
    method: 'PATCH',
    body: JSON.stringify({ visibility: input.visibility, reason: input.reason })
  });
}

export async function updateWikiAdminRevisionEditSummary(input: {
  revisionId: string;
  hidden: boolean;
  expectedVersion: number;
  reason: string;
}): Promise<{
  revisionId: string;
  editSummaryHidden: boolean;
  editSummaryModerationVersion: number;
  moderatedBy: string;
  moderatedAt: string;
  reason: string;
}> {
  return fetchWikiAdminJson(`/revisions/${encodeURIComponent(input.revisionId)}/edit-summary`, {
    method: 'PATCH',
    body: JSON.stringify({
      hidden: input.hidden,
      expectedVersion: input.expectedVersion,
      reason: input.reason
    })
  });
}

export async function rollbackWikiAdminPage(input: {
  pageId: string;
  revisionId: string;
  reason: string;
}): Promise<{ pageId: string; revisionId: string; revisionNo: number }> {
  return fetchWikiAdminJson(`/pages/${encodeURIComponent(input.pageId)}/rollback`, {
    method: 'POST',
    body: JSON.stringify({ revisionId: input.revisionId, reason: input.reason })
  });
}

export async function fetchWikiAdminUsers(query?: string): Promise<WikiAdminUserSummary[]> {
  return fetchWikiAdminJson(`/users${query ? `?q=${encodeURIComponent(query)}` : ''}`);
}

export async function fetchWikiUserBlockEvents(targetProfileId?: string): Promise<WikiUserBlockEventSummary[]> {
  return fetchWikiAdminJson(`/user-block-events${targetProfileId ? `?targetProfileId=${encodeURIComponent(targetProfileId)}` : ''}`);
}

export async function setWikiAdminUserBlocked(input: { profileId: string; blocked: boolean; reason: string; publicReason?: string }): Promise<WikiAdminUserSummary> {
  return fetchWikiAdminJson(`/users/${encodeURIComponent(input.profileId)}/${input.blocked ? 'block' : 'unblock'}`, {
    method: 'POST',
    body: JSON.stringify({ reason: input.reason, publicReason: input.publicReason }),
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

export async function fetchWikiAclGroups(input: {
  cursor?: string;
  status?: string;
  scopeType?: 'site' | 'space';
  spaceId?: string;
} = {}): Promise<WikiAclGroupPage<WikiAclGroupSummary>> {
  const params = new URLSearchParams({ limit: '50' });
  if (input.cursor) params.set('cursor', input.cursor);
  if (input.status) params.set('status', input.status);
  if (input.scopeType) params.set('scopeType', input.scopeType);
  if (input.spaceId) params.set('spaceId', input.spaceId);
  return fetchWikiAdminJson(`/acl-groups?${params.toString()}`);
}

export async function createWikiAclGroup(input: {
  key: string;
  title: string;
  description?: string;
  selfRemovable: boolean;
  scopeType: 'site' | 'space';
  spaceId?: string;
}): Promise<WikiAclGroupSummary> {
  return fetchWikiAdminJson('/acl-groups', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateWikiAclGroup(groupId: string, input: { title?: string; description?: string | null; status?: string; selfRemovable?: boolean; reason?: string }): Promise<WikiAclGroupSummary> {
  return fetchWikiAdminJson(`/acl-groups/${encodeURIComponent(groupId)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export async function deleteWikiAclGroup(groupId: string, reason: string): Promise<void> {
  await fetchWikiAdminJson(`/acl-groups/${encodeURIComponent(groupId)}`, { method: 'DELETE', body: JSON.stringify({ reason }) });
}

export async function fetchWikiAclGroupMembers(groupId: string, input: { cursor?: string; includeRemoved?: boolean } = {}): Promise<WikiAclGroupPage<WikiAclGroupMemberSummary>> {
  const params = new URLSearchParams({ limit: '50' });
  if (input.cursor) params.set('cursor', input.cursor);
  if (input.includeRemoved) params.set('includeRemoved', 'true');
  return fetchWikiAdminJson(`/acl-groups/${encodeURIComponent(groupId)}/members?${params.toString()}`);
}

export async function addWikiAclGroupMember(groupId: string, input: { memberType: 'user' | 'ip' | 'cidr'; userId?: string; address?: string; expiresAt?: string | null; reason: string }): Promise<WikiAclGroupMemberSummary> {
  return fetchWikiAdminJson(`/acl-groups/${encodeURIComponent(groupId)}/members`, { method: 'POST', body: JSON.stringify(input) });
}

export async function updateWikiAclGroupMemberExpiry(groupId: string, memberId: string, expiresAt: string | null, reason: string): Promise<WikiAclGroupMemberSummary> {
  return fetchWikiAdminJson(`/acl-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberId)}/expiry`, {
    method: 'PATCH', body: JSON.stringify({ expiresAt, reason })
  });
}

export async function removeWikiAclGroupMember(groupId: string, memberId: string, reason: string): Promise<void> {
  await fetchWikiAdminJson(`/acl-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberId)}`, {
    method: 'DELETE', body: JSON.stringify({ reason })
  });
}

export async function selfRemoveFromWikiAclGroup(groupId: string): Promise<{ readonly removed: true; readonly memberIds: string[] }> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/acl-groups/${encodeURIComponent(groupId)}/self-remove`, {
    method: 'POST', credentials: 'include', headers: { ...(await csrfHeaders()) }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'ACL 그룹에서 직접 제거하지 못했습니다.');
  }
  return response.json();
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

export async function previewWikiMarkup(
  contentRaw: string,
  context?: { readonly pageId?: string; readonly namespace: string; readonly localPath: string },
): Promise<{ html: string; errors: string[]; blockingErrors: string[] }> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/preview`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify({ contentRaw, ...context }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? 'Failed to render preview.');
  }
  return response.json();
}

export async function saveWikiPage(input: { pageId?: string; spaceId?: string; namespace: string; title: string; contentRaw: string; editSummary: string; isMinor: boolean; baseRevisionId?: string; captchaToken?: string; policyAcceptance?: WikiPolicyAcceptance }): Promise<WikiMutationResponse> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/pages${input.pageId ? `/${input.pageId}` : ''}`, {
    method: input.pageId ? 'PATCH' : 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify({
      namespace: input.namespace,
      spaceId: input.spaceId,
      title: input.title,
      contentRaw: input.contentRaw,
      editSummary: input.editSummary,
      isMinor: input.isMinor,
      baseRevisionId: input.baseRevisionId,
      captchaToken: input.captchaToken,
      policyAcceptance: input.policyAcceptance,
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
  policyAcceptance?: WikiPolicyAcceptance;
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
        baseRevisionId: input.baseRevisionId,
        policyAcceptance: input.policyAcceptance,
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

export async function moveWikiPage(input: { pageId: string; namespace?: string; spaceId?: string; title: string; displayTitle?: string; reason: string; leaveRedirect: boolean }): Promise<WikiMoveResponse> {
  return mutateWikiPage(input.pageId, 'move', {
    namespace: input.namespace,
    spaceId: input.spaceId,
    title: input.title,
    displayTitle: input.displayTitle,
    reason: input.reason,
    leaveRedirect: input.leaveRedirect,
  });
}

export async function fetchWikiSwapCandidates(pageId: string, query: string): Promise<{ readonly items: WikiSwapCandidate[] }> {
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/pages/${encodeURIComponent(pageId)}/swap-candidates?${params.toString()}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw wikiApiError(response, body, 'Failed to find exchange candidates.');
  return body as { readonly items: WikiSwapCandidate[] };
}

export async function swapWikiPages(input: {
  readonly pageId: string;
  readonly targetPageId: string;
  readonly expectedSourceRevisionId: string;
  readonly expectedTargetRevisionId: string;
  readonly reason: string;
  readonly sourceTitleConfirmation: string;
  readonly targetTitleConfirmation: string;
}): Promise<WikiSwapResponse> {
  return mutateWikiPage(input.pageId, 'swap', {
    targetPageId: input.targetPageId,
    expectedSourceRevisionId: input.expectedSourceRevisionId,
    expectedTargetRevisionId: input.expectedTargetRevisionId,
    reason: input.reason,
    sourceTitleConfirmation: input.sourceTitleConfirmation,
    targetTitleConfirmation: input.targetTitleConfirmation,
  });
}

export async function fetchWikiUsernameState(): Promise<WikiUsernameState> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/me/username`, {
    credentials: 'include',
    cache: 'no-store',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw wikiApiError(response, body, 'Wiki 아이디 정보를 불러오지 못했습니다.');
  return body as WikiUsernameState;
}

export async function changeWikiUsername(input: {
  readonly username: string;
  readonly confirmation: string;
  readonly password?: string;
}): Promise<WikiUsernameChangeResponse> {
  const response = await fetch(`${apiBaseUrl()}/v1/wiki/me/username`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw wikiApiError(response, body, 'Wiki 아이디를 변경하지 못했습니다.');
  return body as WikiUsernameChangeResponse;
}

export async function deleteWikiPage(input: { pageId: string; reason: string }): Promise<{ pageId: string; status: string }> {
  return mutateWikiPage(input.pageId, 'delete', { reason: input.reason });
}

export async function restoreWikiPage(input: { pageId: string; reason: string; revisionId?: string }): Promise<{ pageId: string; status: string; revisionId?: string; sourceRevisionId?: string | null }> {
  return mutateWikiPage(input.pageId, 'restore', { reason: input.reason, revisionId: input.revisionId });
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

export async function uploadWikiMedia(input: {
  data: string;
  filename: string;
  pageId?: string;
  spaceId?: string;
  license: string;
  sourceUrl?: string;
  sourceText?: string;
  replaceFileId?: string;
}): Promise<{ url: string; publicPath: string; id: string; filename: string; wikiDocumentPath: string | null }> {
  if (Boolean(input.pageId) === Boolean(input.spaceId)) {
    throw new Error('Exactly one wiki page or space is required for an upload.');
  }
  const response = await fetch(`${apiBaseUrl()}/v1/files/wiki-media`, {
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
      linkedResourceType: input.pageId ? 'wiki_page' : 'wiki_space',
      linkedResourceId: input.pageId ?? input.spaceId,
      replaceFileId: input.replaceFileId,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const retryAfter = response.headers.get('Retry-After');
    const retryHint = response.status === 429 && retryAfter
      ? ` 요청 한도를 초과했습니다. 서버 재시도 안내: ${retryAfter}.`
      : '';
    throw new Error(`${body?.message ?? 'Failed to upload wiki media.'}${retryHint}`);
  }
  return {
    id: String(body.id),
    filename: String(body.wikiFilename ?? body.filename),
    url: String(body.url ?? body.publicPath),
    publicPath: String(body.publicPath ?? body.url),
    wikiDocumentPath: typeof body.wikiDocumentPath === 'string' ? body.wikiDocumentPath : null,
  };
}

export interface WikiFileVersion {
  readonly id: string;
  readonly fileId: string;
  readonly pageId: string;
  readonly pageRevisionId: string;
  readonly versionNo: number;
  readonly isCurrent: boolean;
  readonly mimeType: string;
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly hash: string;
  readonly createdAt: string;
}

export async function fetchWikiFileVersions(fileId: string): Promise<WikiFileVersion[]> {
  const response = await fetch(`${apiBaseUrl()}/v1/files/${encodeURIComponent(fileId)}/versions`, {
    credentials: 'include',
    cache: 'no-store',
  });
  const body = await response.json().catch(() => []);
  if (!response.ok) throw new Error(body?.message ?? 'Failed to load wiki file versions.');
  return body as WikiFileVersion[];
}

export async function restoreWikiFileVersion(input: {
  readonly fileId: string;
  readonly versionId: string;
  readonly expectedCurrentVersionNo: number;
}) {
  const response = await fetch(
    `${apiBaseUrl()}/v1/files/${encodeURIComponent(input.fileId)}/versions/${encodeURIComponent(input.versionId)}/restore`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
      body: JSON.stringify({ expectedCurrentVersionNo: input.expectedCurrentVersionNo }),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message ?? 'Failed to restore wiki file version.');
  return body;
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

export async function fetchWikiCreateContext(input: {
  readonly namespace: string;
  readonly title: string;
  readonly spaceId?: string;
}): Promise<WikiCreateContext> {
  const params = new URLSearchParams({ namespace: input.namespace, title: input.title });
  if (input.spaceId) params.set('spaceId', input.spaceId);
  return readWikiBrowser<WikiCreateContext>(`/v1/wiki/create-context?${params.toString()}`);
}

export async function listWikiDocumentTemplates(input: { readonly pageId?: string; readonly spaceId?: string } = {}): Promise<WikiDocumentTemplateSummary[]> {
  if (input.pageId && input.spaceId) throw new Error('Choose either a wiki page or space for document templates.');
  const params = new URLSearchParams();
  if (input.pageId) params.set('pageId', input.pageId);
  if (input.spaceId) params.set('spaceId', input.spaceId);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return readWikiBrowser<WikiDocumentTemplateSummary[]>(`/v1/wiki/templates${suffix}`);
}

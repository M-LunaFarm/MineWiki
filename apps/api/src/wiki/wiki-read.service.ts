import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, ServerWikiReleaseItem, WikiPage } from '@prisma/client';
import {
  type AstNode,
  buildWikiSearchBooleanQuery,
  collectWikiFileNames,
  collectWikiLinkTargets,
  parseLinkTarget,
  parseMarkup,
  renderDocument,
  resolveWikiPath,
  slugifyTitle,
  wikiLinkKey,
  wikiUrl,
  WIKI_RENDERER_VERSION
} from '@minewiki/wiki-core';
import { PUBLIC_WIKI_PAGE_STATUSES, PUBLIC_WIKI_PAGE_STATUS_SQL_LIST } from '@minewiki/wiki-core/page-status';
import { PrismaService } from '../common/prisma.service';
import { fileReadDecision } from '../file/file-permission.service';
import type { SessionPayload } from '../session/session.service';
import { WikiPermissionService, type WikiPermissionActor, type WikiPublishedRevisionScope } from './wiki-permission.service';
import { WikiLinkIndexService } from './wiki-link-index.service';
import { WikiIncludeService } from './wiki-include.service';
import { buildCanonicalServerWikiPath, buildCanonicalServerWikiToolPath, WikiRoutePathResolver, type WikiRoutePathBatch } from './wiki-route-path.resolver';
import { matchCommonLines } from './wiki-line-diff';
import { resolveEffectiveServerWikiLayout } from '../server/server-wiki-layout-policy';
import { publicWikiRecentChangeSummary, publicWikiRevisionEditSummary } from './wiki-revision-summary';
import { wikiLinkResolutionContext } from './wiki-link-context';
import { serverWikiIdentityConflicts } from '../server/server-wiki-identity';
import { buildServerWikiReleaseNavigation } from './server-wiki-navigation-order';
import { WikiSpecialCursorCodec, type WikiSpecialCursorBinding, type WikiSpecialCursorPosition } from './wiki-special-cursor';
import { PUBLIC_SERVER_LISTING_STATUS } from '@minewiki/schemas';

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

export interface WikiSearchResult {
  readonly pageId: string;
  readonly namespace: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly routePath: string;
  readonly snippet: string;
  readonly highlights: {
    readonly title: ReadonlyArray<readonly [start: number, length: number]>;
    readonly snippet: ReadonlyArray<readonly [start: number, length: number]>;
  };
  readonly updatedAt: string;
}

export type WikiSearchTarget = 'all' | 'title' | 'content';

export interface WikiSearchResponse {
  readonly items: WikiSearchResult[];
  readonly nextCursor: string | null;
}

export interface WikiSearchSuggestionResponse {
  readonly items: WikiSearchResult[];
  readonly exactMatch: WikiSearchResult | null;
}

export interface WikiPublicStatsResponse {
  readonly pageCount: number;
  /** Canonical namespace code, or null when the site-wide count was requested. */
  readonly namespace: string | null;
  readonly generatedAt: string;
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

export type WikiBacklinkType = 'link' | 'file' | 'include' | 'redirect';

export interface WikiContributionItem {
  readonly id: string;
  readonly kind: 'document' | 'discussion' | 'edit_request' | 'review';
  readonly pageId: string | null;
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
  readonly items: WikiContributionItem[];
  readonly nextCursor: string | null;
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

export interface WikiSpecialDocumentItem {
  readonly id: string;
  readonly pageId: string | null;
  readonly namespace: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly routePath: string;
  readonly value: number | null;
  readonly updatedAt: string | null;
}

export interface WikiSpecialDocumentResponse {
  readonly type: WikiSpecialDocumentType;
  readonly items: WikiSpecialDocumentItem[];
  readonly nextCursor: string | null;
  readonly generation?: string | null;
  readonly generatedAt?: string | null;
  readonly isRebuilding?: boolean;
  readonly isStale?: boolean;
}

interface ParsedWikiSpecialSnapshotItem extends WikiSpecialDocumentItem {
  readonly sourceContributions: ReadonlyArray<{
    readonly pageId: string;
    readonly count: number;
  }>;
  readonly sourceContributionsComplete: boolean;
}

export interface WikiPublicBlockEvent {
  readonly id: string;
  readonly target: {
    readonly profileId: string;
    readonly username: string | null;
    readonly displayName: string;
  };
  readonly actor: {
    readonly profileId: string;
    readonly username: string | null;
    readonly displayName: string;
  };
  readonly action: 'block' | 'unblock';
  readonly publicReason: string | null;
  readonly createdAt: string;
}

export interface WikiPublicBlockHistoryResponse {
  readonly items: WikiPublicBlockEvent[];
  readonly nextCursor: string | null;
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

/**
 * Browser reads pass a SessionPayload so request-scoped authorization claims
 * survive the controller boundary. Credentialed API callers keep passing only
 * an account ID and therefore cannot acquire browser-session claims.
 */
export type WikiAccessViewer = SessionPayload | string | null | undefined;

export interface WikiAccessContext {
  readonly accountId: string | null;
  readonly actor?: WikiPermissionActor | null;
  readonly requestIp?: string | null;
}

interface ReleasedServerWikiPage {
  readonly releaseId: bigint;
  readonly revisionId: bigint;
  readonly page: {
    readonly namespaceId: number;
    readonly id: bigint;
    readonly spaceId: bigint;
    readonly localPath: string;
    readonly slug: string;
    readonly title: string;
    readonly displayTitle: string;
    readonly currentRevisionId: bigint;
    readonly pageType: string;
    readonly protectionLevel: string;
    readonly status: string;
    readonly createdBy: bigint | null;
    readonly ownerProfileId: bigint | null;
    readonly updatedAt: Date;
  };
}

function pageFromServerWikiReleaseItem(item: ServerWikiReleaseItem): ReleasedServerWikiPage['page'] {
  return {
    namespaceId: item.namespaceId,
    id: item.pageId,
    spaceId: item.spaceId,
    localPath: item.localPath,
    slug: item.slug,
    title: item.title,
    displayTitle: item.displayTitle,
    currentRevisionId: item.revisionId,
    pageType: item.pageType,
    protectionLevel: item.protectionLevel,
    status: item.pageStatus,
    createdBy: item.createdBy,
    ownerProfileId: item.ownerProfileId,
    updatedAt: item.pageUpdatedAt,
  };
}

const serverWikiNavigationReleaseItemSelect = {
  namespaceId: true,
  spaceId: true,
  pageId: true,
  revisionId: true,
  localPath: true,
  slug: true,
  title: true,
  displayTitle: true,
  pageType: true,
  protectionLevel: true,
  pageStatus: true,
  createdBy: true,
  ownerProfileId: true,
  pageUpdatedAt: true,
} satisfies Prisma.ServerWikiReleaseItemSelect;

type NavigationReleaseItem = Prisma.ServerWikiReleaseItemGetPayload<{
  select: typeof serverWikiNavigationReleaseItemSelect;
}>;

function pageFromNavigationReleaseItem(item: NavigationReleaseItem): ReleasedServerWikiPage['page'] {
  return {
    namespaceId: item.namespaceId,
    id: item.pageId,
    spaceId: item.spaceId,
    localPath: item.localPath,
    slug: item.slug,
    title: item.title,
    displayTitle: item.displayTitle,
    currentRevisionId: item.revisionId,
    pageType: item.pageType,
    protectionLevel: item.protectionLevel,
    status: item.pageStatus,
    createdBy: item.createdBy,
    ownerProfileId: item.ownerProfileId,
    updatedAt: item.pageUpdatedAt,
  };
}

const serverWikiNavigationDraftPageSelect = {
  namespaceId: true,
  spaceId: true,
  id: true,
  currentRevisionId: true,
  localPath: true,
  slug: true,
  title: true,
  displayTitle: true,
  pageType: true,
  protectionLevel: true,
  status: true,
  createdBy: true,
  ownerProfileId: true,
  updatedAt: true,
} satisfies Prisma.WikiPageSelect;

export async function resolveWikiAccessContext(
  prisma: Pick<PrismaService, 'wikiProfile'>,
  wikiPermissions: WikiPermissionService,
  viewer: WikiAccessViewer
): Promise<WikiAccessContext> {
  if (typeof viewer === 'string') return { accountId: viewer };
  if (!viewer) return { accountId: null };
  const profile = await prisma.wikiProfile.findUnique({
    where: { accountId: viewer.userId },
    select: { id: true, status: true }
  });
  return {
    accountId: viewer.userId,
    actor: profile ? wikiPermissions.actorFromSession(viewer, profile) : null,
    requestIp: viewer.requestIp
  };
}

function lifecycleIdentity(input: {
  readonly namespace: string | null;
  readonly spaceId: bigint | null;
  readonly title: string | null;
  readonly path: string | null;
}): WikiLifecycleIdentity | null {
  if (!input.namespace || input.spaceId === null || !input.title || !input.path) return null;
  return {
    namespace: input.namespace,
    spaceId: input.spaceId.toString(),
    title: input.title,
    path: input.path
  };
}

@Injectable()
export class WikiReadService {
  private readonly publicStatsCache = new Map<string, {
    readonly expiresAt: number;
    readonly value: WikiPublicStatsResponse;
  }>();
  private readonly publicStatsInflight = new Map<string, Promise<WikiPublicStatsResponse>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiPermissions: WikiPermissionService,
    @Optional() _wikiLinks?: WikiLinkIndexService,
    @Optional() private readonly wikiIncludes?: WikiIncludeService,
    @Optional() private readonly injectedRoutePaths?: WikiRoutePathResolver,
    @Optional() private readonly injectedSpecialCursors?: WikiSpecialCursorCodec
  ) {}

  private get routePaths(): WikiRoutePathResolver {
    return this.injectedRoutePaths ?? new WikiRoutePathResolver(this.prisma);
  }

  private get specialCursors(): WikiSpecialCursorCodec {
    return this.injectedSpecialCursors ?? new WikiSpecialCursorCodec();
  }

  async getPublicStats(namespaceInput?: string): Promise<WikiPublicStatsResponse> {
    const requestedNamespace = namespaceInput?.trim().slice(0, 64) || null;
    const namespace = requestedNamespace
      ? await this.prisma.wikiNamespace.findFirst({
          where: { OR: [{ code: requestedNamespace }, { displayName: requestedNamespace }] },
          select: { id: true, code: true }
        })
      : null;
    // thetree treats an unknown namespace argument as an unscoped pagecount.
    const cacheKey = namespace ? `namespace:${namespace.id}` : 'all';
    const cached = this.publicStatsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const running = this.publicStatsInflight.get(cacheKey);
    if (running) return running;

    const calculation = this.countAnonymousReadablePages(namespace?.id)
      .then((pageCount) => {
        const value: WikiPublicStatsResponse = {
          pageCount,
          namespace: namespace?.code ?? null,
          generatedAt: new Date().toISOString()
        };
        this.publicStatsCache.set(cacheKey, { expiresAt: Date.now() + 30_000, value });
        return value;
      })
      .finally(() => this.publicStatsInflight.delete(cacheKey));
    this.publicStatsInflight.set(cacheKey, calculation);
    return calculation;
  }

  private async countAnonymousReadablePages(namespaceId?: number): Promise<number> {
    const batchSize = 500;
    let cursor: bigint | null = null;
    let count = 0;
    for (;;) {
      const pages = await this.prisma.wikiPage.findMany({
        where: {
          ...(cursor !== null ? { id: { gt: cursor } } : {}),
          ...(namespaceId !== undefined ? { namespaceId } : {}),
          status: { in: [...PUBLIC_WIKI_PAGE_STATUSES] },
          currentRevisionId: { not: null }
        },
        orderBy: { id: 'asc' },
        take: batchSize
      });
      if (pages.length === 0) break;
      cursor = pages[pages.length - 1]!.id;
      const revisionIds = pages.flatMap((page) => page.currentRevisionId ? [page.currentRevisionId] : []);
      const publicRevisions = await this.prisma.wikiPageRevision.findMany({
        where: { id: { in: revisionIds }, visibility: 'public' },
        select: { id: true, pageId: true }
      });
      const publicRevisionKeys = new Set(publicRevisions.map((revision) => `${revision.pageId}:${revision.id}`));
      const publicCandidates = pages.filter((page) =>
        page.currentRevisionId !== null && publicRevisionKeys.has(`${page.id}:${page.currentRevisionId}`)
      );
      const readable = await this.wikiPermissions.filterReadablePages({
        actor: null,
        pages: publicCandidates,
        // Public pagecount must not vary with the requester's IP or expose an
        // address-scoped allow rule through a shared statistic.
        requestIp: ''
      });
      count += readable.length;
      if (pages.length < batchSize) break;
    }
    return count;
  }

  async getPage(
    namespaceCode: string,
    title: string,
    viewer?: WikiAccessViewer,
    options: { readonly followRedirects?: boolean } = {}
  ): Promise<WikiPageResponse> {
    const access = await resolveWikiAccessContext(this.prisma, this.wikiPermissions, viewer);
    return this.getPageInternal(namespaceCode, title, access, {
      followRedirects: options.followRedirects !== false,
      redirectTrail: []
    });
  }

  private async getPageInternal(
    namespaceCode: string,
    title: string,
    access: WikiAccessContext,
    options: {
      readonly followRedirects: boolean;
      readonly redirectTrail: readonly string[];
    }
  ): Promise<WikiPageResponse> {
    const normalizedNamespace = namespaceCode.trim() || 'main';
    const normalizedTitle = title.trim() || '대문';
    const pageKey = `${normalizedNamespace}:${slugifyTitle(normalizedTitle)}`;
    if (options.redirectTrail.includes(pageKey)) {
      throw new BadRequestException('Wiki redirect loop detected.');
    }
    if (options.redirectTrail.length >= 5) {
      throw new BadRequestException('Wiki redirect depth exceeded.');
    }
    const namespace = await this.prisma.wikiNamespace.findUnique({
      where: { code: normalizedNamespace }
    });
    if (!namespace) {
      throw new NotFoundException('Wiki namespace not found.');
    }

    const released = await this.resolveReleasedServerWikiPage(
      namespace.code,
      namespace.id,
      normalizedTitle,
      access,
    );
    const page = released === undefined
      ? await this.prisma.wikiPage.findUnique({
          where: {
            namespaceId_slug: {
              namespaceId: namespace.id,
              slug: slugifyTitle(normalizedTitle)
            }
          }
        })
      : released?.page ?? null;
    if (!page) {
      if (normalizedNamespace === 'user' && options.followRedirects) {
        const [requestedRoot = '', ...suffixParts] = normalizedTitle.split('/');
        if (requestedRoot.normalize('NFKC') !== requestedRoot) throw new NotFoundException('Wiki page not found.');
        const alias = await this.prisma.wikiUsernameAlias.findUnique({
          where: { oldUsername: requestedRoot.normalize('NFKC') },
          select: { profileId: true }
        });
        const canonical = alias ? await this.prisma.wikiProfile.findUnique({
          where: { id: alias.profileId },
          select: { username: true, status: true }
        }) : null;
        if (canonical?.status === 'active' && canonical.username !== requestedRoot) {
          const canonicalTitle = suffixParts.length > 0
            ? `${canonical.username}/${suffixParts.join('/')}`
            : canonical.username;
          const redirected = await this.getPageInternal('user', canonicalTitle, access, {
            followRedirects: true,
            redirectTrail: [...options.redirectTrail, pageKey]
          });
          return {
            ...redirected,
            redirectedFrom: redirected.redirectedFrom ?? {
              namespace: 'user',
              title: normalizedTitle,
              path: wikiUrl('user', normalizedTitle)
            }
          };
        }
      }
      throw new NotFoundException('Wiki page not found.');
    }
    return this.renderPage(namespace.code, page, access, {
      ...options,
      ...(released ? { revisionId: released.revisionId, releaseId: released.releaseId } : {}),
    });
  }

  private async resolveReleasedServerWikiPage(
    namespaceCode: string,
    namespaceId: number,
    title: string,
    access: WikiAccessContext,
  ): Promise<ReleasedServerWikiPage | null | undefined> {
    if (namespaceCode !== 'server') return undefined;
    const [contentSlug = ''] = slugifyTitle(title).split('/');
    if (!contentSlug) return null;
    const serverWiki = await this.prisma.serverWiki.findUnique({
      where: { slug: contentSlug },
      select: {
        id: true,
        spaceId: true,
        status: true,
        publicationStatus: true,
        publishedReleaseId: true,
      },
    });
    if (!serverWiki || serverWiki.status !== 'active') return null;
    if (await this.wikiPermissions.canPreviewServerWikiSpace({ ...access, spaceId: serverWiki.spaceId })) {
      return undefined;
    }
    if (serverWiki.publicationStatus !== 'published' || serverWiki.publishedReleaseId === null) {
      return null;
    }
    const item = await this.prisma.serverWikiReleaseItem.findFirst({
      where: {
        releaseId: serverWiki.publishedReleaseId,
        serverWikiId: serverWiki.id,
        spaceId: serverWiki.spaceId,
        namespaceId,
        slug: slugifyTitle(title),
      },
    });
    if (!item) return null;
    return {
      releaseId: item.releaseId,
      revisionId: item.revisionId,
      page: pageFromServerWikiReleaseItem(item),
    };
  }

  async getPageByPath(
    path: string,
    viewer?: WikiAccessViewer,
    options: { readonly followRedirects?: boolean } = {}
  ): Promise<WikiPageResponse> {
    const siteRoute = parseServerWikiSitePath(path);
    if (siteRoute) {
      const serverWiki = await this.prisma.serverWiki.findUnique({
        where: { siteSlug: siteRoute.siteSlug },
        select: { slug: true, status: true }
      });
      if (!serverWiki || serverWiki.status !== 'active') {
        throw new NotFoundException('Server wiki not found.');
      }
      const title = siteRoute.relativePath
        ? `${serverWiki.slug}/${siteRoute.relativePath}`
        : serverWiki.slug;
      return this.getPage('server', title, viewer, options);
    }
    const resolved = resolveWikiPath(path);
    return this.getPage(resolved.namespace, resolved.title, viewer, options);
  }

  async getServerWikiNavigation(slug: string, viewer?: WikiAccessViewer): Promise<ServerWikiNavigationResponse> {
    const contentSlug = slugifyTitle(slug);
    const wiki = await this.prisma.serverWiki.findUnique({
      where: { slug: contentSlug },
      select: {
        id: true,
        spaceId: true,
        slug: true,
        siteSlug: true,
        status: true,
        publicationStatus: true,
        publishedReleaseId: true,
        navigationOrder: true,
        navigationVersion: true,
        contentSettingsVersion: true,
      },
    });
    if (!wiki || wiki.status !== 'active') throw new NotFoundException('Server wiki not found.');
    const access = await resolveWikiAccessContext(this.prisma, this.wikiPermissions, viewer);
    await this.wikiPermissions.assertCanReadSpace({ ...access, spaceId: wiki.spaceId });
    const canPreview = await this.wikiPermissions.canPreviewServerWikiSpace({ ...access, spaceId: wiki.spaceId });
    const siteSlug = wiki.siteSlug ?? wiki.slug;
    if (!canPreview) {
      if (wiki.publicationStatus !== 'published' || wiki.publishedReleaseId === null) {
        throw new NotFoundException('Server wiki not found.');
      }
      const releaseId = wiki.publishedReleaseId;
      const [storedNodes, release] = await Promise.all([
        this.prisma.serverWikiReleaseNavigationNode.findMany({
          where: { releaseId, serverWikiId: wiki.id },
          orderBy: { position: 'asc' },
          select: {
            nodeKey: true,
            kind: true,
            pageId: true,
            parentKey: true,
            title: true,
            position: true,
            depth: true,
            hasChildren: true,
          },
        }),
        this.prisma.serverWikiRelease.findFirst({
          where: { id: releaseId, serverWikiId: wiki.id },
          select: { presentationSnapshot: true },
        }),
      ]);
      const releasedItems = await this.prisma.serverWikiReleaseItem.findMany({
        where: {
          releaseId,
          serverWikiId: wiki.id,
          spaceId: wiki.spaceId,
          pageType: { not: 'redirect' },
          ...(storedNodes.length > 0
            ? { pageId: { in: storedNodes.flatMap((node) => node.pageId ? [node.pageId] : []) } }
            : {}),
        },
        orderBy: [{ localPath: 'asc' }, { pageId: 'asc' }],
        select: serverWikiNavigationReleaseItemSelect,
      });
      const readableItems = await this.wikiPermissions.filterReadablePages({ ...access, pages: releasedItems.map(pageFromNavigationReleaseItem) });
      const readableIds = new Set(readableItems.map((page) => page.id));
      const presentation = isJsonRecord(release?.presentationSnapshot) ? release.presentationSnapshot : null;
      const navigationOrder = presentation && 'navigationOrder' in presentation
        ? presentation.navigationOrder ?? null
        : null;
      const nodes = storedNodes.length > 0
        ? storedNodes
        : buildServerWikiReleaseNavigation(wiki.slug, releasedItems.map(pageFromNavigationReleaseItem), navigationOrder).map((node) => ({
            nodeKey: node.nodeKey,
            kind: node.kind,
            pageId: node.kind === 'page' ? node.page.id : null,
            parentKey: node.parentKey,
            title: node.title,
            position: node.position,
            depth: node.depth,
            hasChildren: node.hasChildren,
          }));
      const itemByPageId = new Map(releasedItems.map((item) => [item.pageId, item]));
      const items = projectReadableServerWikiNavigation(nodes, readableIds, (pageId) => {
        const item = itemByPageId.get(pageId);
        return item ? buildCanonicalServerWikiPath(siteSlug, item.title, wiki.slug, '/serverWiki') : null;
      });
      const hasReadAcl = await this.hasServerWikiNavigationReadAcl(wiki.spaceId, releasedItems);
      return {
        key: `release:${releaseId}:v1`,
        cacheable: access.actor == null && !hasReadAcl,
        items,
      };
    }

    const draftPages = await this.prisma.wikiPage.findMany({
      where: { spaceId: wiki.spaceId, status: { not: 'deleted' }, pageType: { not: 'redirect' } },
      orderBy: [{ localPath: 'asc' }, { id: 'asc' }],
      select: serverWikiNavigationDraftPageSelect,
    });
    const revisionIds = draftPages.flatMap((page) => page.currentRevisionId ? [page.currentRevisionId] : []);
    const publicRevisions = revisionIds.length > 0 ? await this.prisma.wikiPageRevision.findMany({
      where: { id: { in: revisionIds }, visibility: 'public' },
      select: { id: true, pageId: true },
    }) : [];
    const publicKeys = new Set(publicRevisions.map((revision) => `${revision.pageId}:${revision.id}`));
    const publicPages = draftPages.filter((page) => page.currentRevisionId
      && publicKeys.has(`${page.id}:${page.currentRevisionId}`));
    const readablePages = await this.wikiPermissions.filterReadablePages({ ...access, pages: publicPages });
    return {
      key: `draft:${wiki.navigationVersion}:${wiki.contentSettingsVersion}`,
      cacheable: false,
      items: buildServerWikiNavigation(wiki.slug, readablePages, -1n, siteSlug, '/serverWiki', wiki.navigationOrder)
        .map((item) => ({
          kind: item.kind,
          id: item.id,
          title: item.title,
          path: item.path,
          depth: item.depth,
          hasChildren: item.hasChildren,
        })),
    };
  }

  private async hasServerWikiNavigationReadAcl(
    spaceId: bigint,
    pages: ReadonlyArray<{ readonly pageId: bigint; readonly namespaceId: number }>,
  ): Promise<boolean> {
    const now = new Date();
    const pageIds = pages.map((page) => page.pageId);
    const namespaceIds = [...new Set(pages.map((page) => BigInt(page.namespaceId)))];
    return (await this.prisma.aclRule.count({
      where: {
        action: 'read',
        OR: [
          { targetType: 'site', targetId: null },
          { targetType: 'space', targetId: spaceId },
          ...(namespaceIds.length > 0 ? [{ targetType: 'namespace', targetId: { in: namespaceIds } }] : []),
          ...(pageIds.length > 0 ? [{ targetType: 'page', targetId: { in: pageIds } }] : []),
        ],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
      },
    })) > 0;
  }

  async getRenderedRevision(revisionId: string, viewer?: WikiAccessViewer): Promise<WikiRenderedRevisionResponse> {
    const parsedRevisionId = this.parseBigIntId(revisionId, 'revisionId');
    const revision = await this.prisma.wikiPageRevision.findFirst({
      where: { id: parsedRevisionId, visibility: 'public' }
    });
    if (!revision) {
      throw new NotFoundException('Public wiki revision not found.');
    }
    const page = await this.prisma.wikiPage.findUnique({ where: { id: revision.pageId } });
    if (!page) {
      throw new NotFoundException('Public wiki revision not found.');
    }
    const namespace = await this.prisma.wikiNamespace.findUnique({ where: { id: page.namespaceId } });
    if (!namespace) throw new NotFoundException('Public wiki revision not found.');
    const access = await resolveWikiAccessContext(this.prisma, this.wikiPermissions, viewer);
    const publication = await this.publishedRevisionScopeForViewer(page, access);
    const releaseItem = publication?.revisionItems.find((item) => item.revisionId === revision.id) ?? null;
    if (publication && !releaseItem) {
      throw new NotFoundException('Public wiki revision not found.');
    }
    const renderedPage = releaseItem ? pageFromServerWikiReleaseItem(releaseItem) : page;
    await this.wikiPermissions.assertCanReadPage({ ...access, page: renderedPage, revision });
    await this.wikiPermissions.assertCanUsePageAction({
      ...access,
      action: 'history',
      page: renderedPage
    });
    const rendered = await this.renderPage(namespace.code, renderedPage, access, {
      followRedirects: false,
      redirectTrail: [],
      revisionId: revision.id,
      releaseId: releaseItem?.releaseId,
    });
    const routePaths = await this.routePaths.preload([renderedPage], new Map([[namespace.id, namespace.code]]));
    const publicSummary = publicWikiRevisionEditSummary(revision);
    const publicCurrentRevisionId = publication?.currentItem.revisionId ?? page.currentRevisionId;
    return {
      ...rendered,
      routePath: routePaths.routePath(renderedPage, namespace.code),
      currentRevisionId: publicCurrentRevisionId?.toString() ?? null,
      render: {
        rendererVersion: WIKI_RENDERER_VERSION,
        dependencyMode: releaseItem ? 'release-snapshot' : 'live-current',
        releaseId: releaseItem?.releaseId.toString() ?? null,
      },
      revision: {
        ...rendered.revision,
        parentRevisionId: revision.parentRevisionId?.toString() ?? null,
        ...publicSummary,
        isMinor: revision.isMinor,
        contentSize: revision.contentSize,
        syntaxVersion: revision.syntaxVersion,
        visibility: 'public',
        isCurrent: publicCurrentRevisionId === revision.id
      }
    };
  }

  async getRevisions(pageId: string, viewer?: WikiAccessViewer, cursor?: string, requestedLimit: string | number = 50): Promise<WikiRevisionListResponse> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: parsedPageId } });
    if (!page) {
      throw new NotFoundException('Wiki page not found.');
    }
    const access = await resolveWikiAccessContext(this.prisma, this.wikiPermissions, viewer);
    const publication = await this.publishedRevisionScopeForViewer(page, access);
    await this.wikiPermissions.assertCanReadPage({ ...access, page });
    await this.wikiPermissions.assertCanUsePageAction({
      ...access,
      action: 'history',
      page
    });
    const limit = Math.min(Math.max(Number(requestedLimit) || 50, 1), 100);
    const cursorRevisionNo = cursor ? this.parsePositiveInt(cursor, 'cursor') : null;
    const revisions = await this.prisma.wikiPageRevision.findMany({
      where: {
        pageId: parsedPageId,
        visibility: 'public',
        ...(publication ? { id: { in: publication.revisionItems.map((item) => item.revisionId) } } : {}),
        ...(cursorRevisionNo ? { revisionNo: { lt: cursorRevisionNo } } : {})
      },
      orderBy: [{ revisionNo: 'desc' }],
      take: limit + 1
    });
    const hasMore = revisions.length > limit;
    const pageRows = revisions.slice(0, limit);
    const profileIds = [...new Set(pageRows.flatMap((revision) => revision.createdBy ? [revision.createdBy] : []))];
    const profileById = await this.canonicalProfileViews(profileIds);
    const items = pageRows.map((revision, index) => {
      const previous = revisions[index + 1];
      const publicSummary = publicWikiRevisionEditSummary(revision);
      return {
        id: revision.id.toString(),
        revisionNo: revision.revisionNo,
        ...publicSummary,
        isMinor: revision.isMinor,
        createdBy: revision.createdBy?.toString() ?? null,
        createdByName: revision.createdBy ? profileById.get(revision.createdBy)?.displayName ?? null : null,
        createdByUsername: revision.createdBy ? profileById.get(revision.createdBy)?.username ?? null : null,
        createdAt: revision.createdAt.toISOString(),
        contentHash: revision.contentHash,
        contentSize: revision.contentSize,
        previousPublicRevisionId: previous?.id.toString() ?? null,
        sizeDelta: previous ? revision.contentSize - previous.contentSize : null
      };
    });
    return { items, nextCursor: hasMore ? pageRows.at(-1)?.revisionNo.toString() ?? null : null };
  }

  private async releasedRevisionForViewer(
    page: { readonly id: bigint; readonly spaceId: bigint },
    access: WikiAccessContext,
  ): Promise<{ readonly revisionId: bigint; readonly releaseId: bigint } | undefined> {
    const releasedItem = await this.releasedItemForViewer(page, access);
    return releasedItem
      ? { revisionId: releasedItem.revisionId, releaseId: releasedItem.releaseId }
      : undefined;
  }

  private async publishedRevisionScopeForViewer(
    page: {
      readonly id: bigint;
      readonly spaceId: bigint;
      readonly title: string;
      readonly protectionLevel: string;
      readonly status: string;
    },
    access: WikiAccessContext,
  ): Promise<WikiPublishedRevisionScope | null> {
    const resolver = this.wikiPermissions.resolvePublishedRevisionScope?.bind(this.wikiPermissions);
    if (!resolver) return null;
    return resolver({ actor: access.actor ?? null, page });
  }

  private async releasedItemForViewer(
    page: { readonly id: bigint; readonly spaceId: bigint },
    access: WikiAccessContext,
    requireServerWiki = false,
  ): Promise<ServerWikiReleaseItem | undefined> {
    const serverWiki = await this.prisma.serverWiki.findFirst({
      where: { spaceId: page.spaceId, status: 'active' },
      select: { id: true, spaceId: true, publicationStatus: true, publishedReleaseId: true },
    });
    if (!serverWiki) {
      if (requireServerWiki) throw new NotFoundException('Public wiki revision not found.');
      return undefined;
    }
    if (await this.wikiPermissions.canPreviewServerWikiSpace({ ...access, spaceId: page.spaceId })) {
      return undefined;
    }
    if (serverWiki.publicationStatus !== 'published' || serverWiki.publishedReleaseId === null) {
      throw new NotFoundException('Public wiki revision not found.');
    }
    const item = await this.prisma.serverWikiReleaseItem.findFirst({
      where: {
        releaseId: serverWiki.publishedReleaseId,
        serverWikiId: serverWiki.id,
        spaceId: page.spaceId,
        pageId: page.id,
      },
    });
    if (!item) throw new NotFoundException('Public wiki revision not found.');
    return item;
  }

  private async projectDerivedPages(
    pages: readonly WikiPage[],
    namespaceById: ReadonlyMap<number, string>,
    access: WikiAccessContext,
  ): Promise<Array<ReturnType<typeof pageFromServerWikiReleaseItem> | WikiPage>> {
    return (await this.projectDerivedPagesWithContext(pages, namespaceById, access)).pages;
  }

  private async projectDerivedPagesWithContext(
    pages: readonly WikiPage[],
    namespaceById: ReadonlyMap<number, string>,
    access: WikiAccessContext,
  ): Promise<{
    readonly pages: Array<ReturnType<typeof pageFromServerWikiReleaseItem> | WikiPage>;
    readonly signature: string;
    readonly sourceByPageId: ReadonlyMap<bigint, DerivedPageProjectionSource>;
  }> {
    const currentRevisionIds = pages.flatMap((page) => page.currentRevisionId ? [page.currentRevisionId] : []);
    const publicRevisions = currentRevisionIds.length > 0
      ? await this.prisma.wikiPageRevision.findMany({
          where: { id: { in: currentRevisionIds }, visibility: 'public' },
          select: { id: true },
        })
      : [];
    const publicRevisionIds = new Set(publicRevisions.map((revision) => revision.id));
    const serverSpaceIds = [...new Set(pages
      .filter((page) => namespaceById.get(page.namespaceId) === 'server')
      .map((page) => page.spaceId))];
    const serverWikis = serverSpaceIds.length > 0
      ? await this.prisma.serverWiki.findMany({
          where: { spaceId: { in: serverSpaceIds }, status: 'active' },
          select: {
            id: true,
            spaceId: true,
            publicationStatus: true,
            publishedReleaseId: true,
            publishedRelease: { select: { publishedAt: true } },
          },
        })
      : [];
    const serverWikiBySpace = new Map(serverWikis.map((wiki) => [wiki.spaceId, wiki]));
    const previewSpaceIds = new Set<bigint>();
    for (const wiki of serverWikis) {
      if (await this.wikiPermissions.canPreviewServerWikiSpace({ ...access, spaceId: wiki.spaceId })) {
        previewSpaceIds.add(wiki.spaceId);
      }
    }
    const publicReleaseWikis = serverWikis.filter((wiki) =>
      !previewSpaceIds.has(wiki.spaceId)
      && wiki.publicationStatus === 'published'
      && wiki.publishedReleaseId !== null);
    const releasedItems = publicReleaseWikis.length > 0 && pages.length > 0
      ? await this.prisma.serverWikiReleaseItem.findMany({
          where: {
            pageId: { in: pages.map((page) => page.id) },
            OR: publicReleaseWikis.map((wiki) => ({
              releaseId: wiki.publishedReleaseId!,
              serverWikiId: wiki.id,
              spaceId: wiki.spaceId,
            })),
          },
        })
      : [];
    const releasedItemByPageId = new Map(releasedItems.flatMap((item) => {
      const wiki = serverWikiBySpace.get(item.spaceId);
      return wiki
        && wiki.publishedReleaseId === item.releaseId
        && wiki.id === item.serverWikiId
        ? [[item.pageId, item] as const]
        : [];
    }));
    const sourceByPageId = new Map<bigint, DerivedPageProjectionSource>();
    const projectedPages = pages.flatMap((page) => {
      const isServerPage = namespaceById.get(page.namespaceId) === 'server';
      const serverWiki = serverWikiBySpace.get(page.spaceId);
      if (!isServerPage || (serverWiki && previewSpaceIds.has(page.spaceId))) {
        const visible = page.currentRevisionId
          && publicRevisionIds.has(page.currentRevisionId)
          && PUBLIC_WIKI_PAGE_STATUSES.includes(page.status as (typeof PUBLIC_WIKI_PAGE_STATUSES)[number])
          && page.pageType !== 'redirect';
        if (!visible) return [];
        sourceByPageId.set(page.id, { kind: 'current' });
        return [page];
      }
      const releasedItem = releasedItemByPageId.get(page.id);
      const visible = releasedItem
        && PUBLIC_WIKI_PAGE_STATUSES.includes(releasedItem.pageStatus as (typeof PUBLIC_WIKI_PAGE_STATUSES)[number])
        && releasedItem.pageType !== 'redirect';
      if (!visible) return [];
      sourceByPageId.set(page.id, {
        kind: 'release',
        releaseId: releasedItem.releaseId,
        serverWikiId: releasedItem.serverWikiId,
        spaceId: releasedItem.spaceId,
        publishedAt: serverWiki?.publishedRelease?.publishedAt ?? null,
      });
      return [pageFromServerWikiReleaseItem(releasedItem)];
    });
    const projectionState = serverWikis
      .map((wiki) => [
        wiki.id.toString(),
        wiki.spaceId.toString(),
        previewSpaceIds.has(wiki.spaceId) ? 'preview' : wiki.publicationStatus,
        previewSpaceIds.has(wiki.spaceId) ? 'current' : wiki.publishedReleaseId?.toString() ?? 'none',
      ].join(':'))
      .sort()
      .join('|');
    return {
      pages: projectedPages,
      signature: createHash('sha256').update(projectionState || 'no-server-projection').digest('base64url').slice(0, 22),
      sourceByPageId,
    };
  }

  async getPageLifecycleEvents(
    pageId: string,
    viewer?: WikiAccessViewer,
    cursor?: string,
    requestedLimit: string | number = 50
  ): Promise<WikiPageLifecycleEventListResponse> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: parsedPageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const access = await resolveWikiAccessContext(this.prisma, this.wikiPermissions, viewer);
    await this.wikiPermissions.assertCanReadPage({ ...access, page });
    await this.wikiPermissions.assertCanUsePageAction({ ...access, action: 'history', page });

    const limit = Math.min(Math.max(Number(requestedLimit) || 50, 1), 100);
    const cursorId = cursor ? this.parseBigIntId(cursor, 'cursor') : null;
    const events = await this.prisma.wikiPageLifecycleEvent.findMany({
      where: {
        pageId: parsedPageId,
        ...(cursorId ? { id: { lt: cursorId } } : {})
      },
      orderBy: [{ id: 'desc' }],
      take: limit + 1
    });
    const hasMore = events.length > limit;
    const rows = events.slice(0, limit);
    const actorIds = [...new Set(rows.flatMap((event) => event.actorProfileId ? [event.actorProfileId] : []))];
    const profileById = await this.canonicalProfileViews(actorIds);
    const items = rows.map((event) => {
      const sourceVisible = event.sourceNamespaceId === null || event.sourceSpaceId === null
        ? true
        : event.sourceNamespaceId === page.namespaceId && event.sourceSpaceId === page.spaceId;
      const destinationVisible = event.destinationNamespaceId === null || event.destinationSpaceId === null
        ? true
        : event.destinationNamespaceId === page.namespaceId && event.destinationSpaceId === page.spaceId;
      const identityRedacted = !sourceVisible || !destinationVisible;
      const actor = event.actorProfileId ? profileById.get(event.actorProfileId) : null;
      return {
        id: event.id.toString(),
        eventType: event.eventType as 'move' | 'delete' | 'restore',
        sourceRevisionId: event.sourceRevisionId?.toString() ?? null,
        actorProfileId: event.actorProfileId?.toString() ?? null,
        actorName: actor?.displayName ?? null,
        actorUsername: actor?.username ?? null,
        reason: identityRedacted && event.eventType === 'move' ? null : event.reason,
        source: sourceVisible ? lifecycleIdentity({
          namespace: event.sourceNamespaceCode,
          spaceId: event.sourceSpaceId,
          title: event.sourceTitle,
          path: event.sourcePath
        }) : null,
        destination: destinationVisible ? lifecycleIdentity({
          namespace: event.destinationNamespaceCode,
          spaceId: event.destinationSpaceId,
          title: event.destinationTitle,
          path: event.destinationPath
        }) : null,
        identityRedacted,
        createdAt: event.createdAt.toISOString()
      };
    });
    return { items, nextCursor: hasMore ? rows.at(-1)?.id.toString() ?? null : null };
  }

  async getPageAclHistoryEvents(
    pageId: string,
    viewer?: WikiAccessViewer,
    cursor?: string,
    requestedLimit: string | number = 50
  ): Promise<WikiPageAclHistoryEventListResponse> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: parsedPageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const access = await resolveWikiAccessContext(this.prisma, this.wikiPermissions, viewer);
    await this.wikiPermissions.assertCanReadPage({ ...access, page });
    await this.wikiPermissions.assertCanUsePageAction({ ...access, action: 'history', page });
    const management = await this.wikiPermissions.canManagePageAcl({ actor: access.actor ?? null, page });
    const detailsVisible = management.allowed;

    const limit = Math.min(Math.max(Number(requestedLimit) || 50, 1), 100);
    const cursorId = cursor ? this.parseBigIntId(cursor, 'cursor') : null;
    const events = await this.prisma.aclChangeLog.findMany({
      where: {
        targetType: 'page',
        targetId: parsedPageId,
        ...(cursorId ? { id: { lt: cursorId } } : {})
      },
      orderBy: [{ id: 'desc' }],
      take: limit + 1
    });
    const hasMore = events.length > limit;
    const rows = events.slice(0, limit);
    const actorIds = [...new Set(rows.flatMap((event) => event.changedBy ? [event.changedBy] : []))];
    const profileById = await this.canonicalProfileViews(actorIds);
    const items = rows.map((event) => {
      const actor = event.changedBy ? profileById.get(event.changedBy) : null;
      return {
        id: event.id.toString(),
        actionType: event.actionType,
        actorProfileId: event.changedBy?.toString() ?? null,
        actorName: actor?.displayName ?? null,
        actorUsername: actor?.username ?? null,
        reason: detailsVisible ? event.reason : null,
        oldRules: detailsVisible ? event.oldRuleJson : null,
        newRules: detailsVisible ? event.newRuleJson : null,
        detailsVisible,
        createdAt: event.createdAt.toISOString()
      };
    });
    return { items, nextCursor: hasMore ? rows.at(-1)?.id.toString() ?? null : null, detailsVisible };
  }

  async getRecent(input: {
    readonly accountId?: string | null;
    readonly viewer?: WikiAccessViewer;
    readonly cursor?: string;
    readonly limit?: string | number;
    readonly changeType?: string;
    readonly namespace?: string;
    readonly spaceId?: string;
    readonly minor?: string;
  } = {}): Promise<WikiRecentChangeListResponse> {
    const access = await resolveWikiAccessContext(
      this.prisma,
      this.wikiPermissions,
      input.viewer ?? input.accountId ?? null
    );
    const limit = Math.min(Math.max(Number(input.limit ?? 50) || 50, 1), 100);
    const cursor = input.cursor ? this.parseBigIntId(input.cursor, 'cursor') : null;
    const changeType = this.parseRecentFilter(input.changeType, 'changeType');
    const namespace = this.parseRecentFilter(input.namespace, 'namespace');
    const spaceId = input.spaceId ? this.parseBigIntId(input.spaceId, 'spaceId') : null;
    const isMinor = input.minor === 'true' ? true : input.minor === 'false' ? false : undefined;
    if (input.minor && isMinor === undefined) throw new BadRequestException('minor must be true or false.');
    const scanLimit = Math.min(limit * 4 + 1, 401);
    const changes = await this.prisma.wikiRecentChange.findMany({
      where: {
        ...(cursor ? { id: { lt: cursor } } : {}),
        ...(changeType ? { changeType } : {}),
        ...(namespace ? { namespaceCode: namespace } : {}),
        ...(spaceId ? { spaceId } : {}),
        ...(isMinor === undefined ? {} : { isMinor })
      },
      orderBy: [{ id: 'desc' }],
      take: scanLimit
    });
    const hiddenByRevisionId = await this.summaryHiddenByRevisionId(
      changes.flatMap((change) => change.revisionId === null ? [] : [change.revisionId])
    );
    const pageIds = [...new Set(changes.flatMap((change) => change.pageId ? [change.pageId] : []))];
    const pages = pageIds.length > 0 ? await this.prisma.wikiPage.findMany({ where: { id: { in: pageIds } } }) : [];
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const actorIds = [...new Set(changes.flatMap((change) => change.actorId ? [change.actorId] : []))];
    const profileById = await this.canonicalProfileViews(actorIds);
    const revisionIds = [...new Set(changes.flatMap((change) => change.revisionId ? [change.revisionId] : []))];
    const revisionActors = revisionIds.length > 0
      ? await this.prisma.wikiPageRevision.findMany({
          where: { id: { in: revisionIds } },
          select: { id: true, actorType: true, visibility: true }
        })
      : [];
    const revisionActorById = new Map(revisionActors.map((revision) => [revision.id, revision]));
    const changeSpaceIds = [...new Set(changes.flatMap((change) => change.spaceId ? [change.spaceId] : []))];
    const serverWikis = changeSpaceIds.length > 0
      ? await this.prisma.serverWiki.findMany({
          where: { spaceId: { in: changeSpaceIds }, status: 'active' },
          select: {
            spaceId: true,
            publicationStatus: true,
            publishedReleaseId: true,
            publishedRelease: { select: { publishedAt: true } },
          },
        })
      : [];
    const publicReleaseCutoffBySpace = new Map<bigint, Date | null>();
    for (const wiki of serverWikis) {
      const canPreview = await this.wikiPermissions.canPreviewServerWikiSpace({
        ...access,
        spaceId: wiki.spaceId,
      });
      if (!canPreview) {
        publicReleaseCutoffBySpace.set(
          wiki.spaceId,
          wiki.publicationStatus === 'published' && wiki.publishedReleaseId !== null
            ? wiki.publishedRelease?.publishedAt ?? null
            : null,
        );
      }
    }
    const knownNamespaces = new Map<number, string>();
    for (const change of changes) {
      const page = change.pageId ? pageById.get(change.pageId) : null;
      if (page) knownNamespaces.set(page.namespaceId, change.namespaceCode);
    }
    const routePaths = await this.routePaths.preload(pages, knownNamespaces);
    const readableByPageId = new Map<bigint, boolean>();
    const historyByPageId = new Map<bigint, boolean>();
    const visible: WikiRecentChangeSummary[] = [];
    let lastScannedId: bigint | null = null;
    for (const change of changes) {
      lastScannedId = change.id;
      const releaseCutoff = change.spaceId ? publicReleaseCutoffBySpace.get(change.spaceId) : undefined;
      if (releaseCutoff === null || (releaseCutoff && change.createdAt > releaseCutoff)) continue;
      const publicDeletion = change.changeType === 'delete' && change.eventAudience === 'public';
      if (change.pageId) {
        let readable = readableByPageId.get(change.pageId);
        if (readable === undefined) {
          try {
            const revision = change.revisionId ? revisionActorById.get(change.revisionId) : null;
            await this.wikiPermissions.assertCanReadPage({
              ...access,
              page: pageById.get(change.pageId) ?? null,
              revision: revision ? { id: revision.id, visibility: revision.visibility } : undefined,
            });
            readable = true;
          } catch {
            readable = false;
          }
          readableByPageId.set(change.pageId, readable);
        }
        if (!readable && !publicDeletion) continue;
      }
      if (change.changeType === 'delete' && !publicDeletion) continue;
      let canViewDiff = false;
      if (change.pageId && change.revisionId && change.previousPublicRevisionId && change.changeType !== 'delete') {
        let historyAllowed = historyByPageId.get(change.pageId);
        if (historyAllowed === undefined) {
          try {
            await this.wikiPermissions.assertCanUsePageAction({
              ...access,
              action: 'history',
              page: pageById.get(change.pageId) ?? null
            });
            historyAllowed = true;
          } catch {
            historyAllowed = false;
          }
          historyByPageId.set(change.pageId, historyAllowed);
        }
        const revisionActor = revisionActorById.get(change.revisionId);
        canViewDiff = historyAllowed && revisionActor?.visibility === 'public';
      }
      const publicSummary = change.changeType === 'delete'
        ? { summary: '문서 삭제', summaryHidden: false }
        : publicWikiRecentChangeSummary({
            summary: change.summary,
            revisionId: change.revisionId,
            hiddenByRevisionId
          });
      const profile = change.actorId ? profileById.get(change.actorId) : null;
      const revisionActor = change.revisionId ? revisionActorById.get(change.revisionId) : null;
      visible.push({
        id: change.id.toString(),
        pageId: change.pageId?.toString() ?? null,
        revisionId: change.revisionId?.toString() ?? null,
        previousPublicRevisionId: canViewDiff ? change.previousPublicRevisionId?.toString() ?? null : null,
        actorId: change.actorId?.toString() ?? null,
        actorName: profile?.displayName ?? (revisionActor?.actorType === 'ip' ? '익명 기여자' : '알 수 없는 기여자'),
        actorUsername: profile?.username ?? null,
        changeType: change.changeType,
        title: change.title,
        namespaceCode: change.namespaceCode,
        spaceId: change.spaceId?.toString() ?? null,
        routePath: change.pageId && pageById.has(change.pageId)
          ? routePaths.routePath(pageById.get(change.pageId)!, change.namespaceCode)
          : wikiUrl(change.namespaceCode as Parameters<typeof wikiUrl>[0], change.localPath ?? change.title),
        ...publicSummary,
        sizeDelta: change.sizeDelta,
        canViewDiff,
        isMinor: change.isMinor,
        createdAt: change.createdAt.toISOString()
      });
      if (visible.length >= limit) break;
    }
    const mayHaveMore = changes.length > 0 && (visible.length >= limit || changes.length >= scanLimit);
    return { items: visible, nextCursor: mayHaveMore ? lastScannedId?.toString() ?? null : null };
  }

  async getBacklinks(input: {
    readonly pageId: string;
    readonly accountId?: string | null;
    readonly viewer?: WikiAccessViewer;
    readonly sourceSpaceId?: bigint;
    readonly cursor?: string;
    readonly limit?: string | number;
    readonly types?: string;
    readonly namespace?: string;
  }): Promise<WikiBacklinkResponse> {
    const pageId = this.parseBigIntId(input.pageId, 'pageId');
    const target = await this.prisma.wikiPage.findUnique({ where: { id: pageId } });
    if (!target) throw new NotFoundException('Wiki page not found.');
    const access = await resolveWikiAccessContext(
      this.prisma,
      this.wikiPermissions,
      input.viewer ?? input.accountId ?? null
    );
    const namespace = await this.prisma.wikiNamespace.findUnique({ where: { id: target.namespaceId } });
    if (!namespace) throw new NotFoundException('Wiki namespace not found.');
    const releasedTarget = namespace.code === 'server'
      ? await this.releasedItemForViewer(target, access, true)
      : undefined;
    const projectedTarget = releasedTarget ? pageFromServerWikiReleaseItem(releasedTarget) : target;
    await this.wikiPermissions.assertCanReadPage({ ...access, page: projectedTarget });
    if (!projectedTarget.currentRevisionId) throw new NotFoundException('Wiki page has no public revision.');
    const targetRevision = await this.prisma.wikiPageRevision.findUnique({
      where: { id: projectedTarget.currentRevisionId },
      select: { visibility: true }
    });
    if (targetRevision?.visibility !== 'public') throw new NotFoundException('Wiki page has no public revision.');
    const limit = Math.min(Math.max(Number(input.limit ?? 30) || 30, 1), 100);
    const selectedTypes = parseBacklinkTypes(input.types);
    const requestedNamespace = parseBacklinkNamespace(input.namespace);
    const currentLinks = await this.prisma.wikiPageLink.findMany({
      where: {
        targetNamespaceCode: namespace.code,
        targetSlug: projectedTarget.slug,
        linkType: { in: [...ALL_BACKLINK_TYPES] }
      }
    });
    const releasedLinks = namespace.code === 'server'
      ? await this.prisma.serverWikiReleaseLink.findMany({
          where: {
            targetNamespaceCode: namespace.code,
            targetSlug: projectedTarget.slug,
            linkType: { in: [...ALL_BACKLINK_TYPES] },
            release: {
              publishedFor: { is: { status: 'active', publicationStatus: 'published' } },
            },
          },
        })
      : [];
    const links = [...currentLinks, ...releasedLinks];
    const pageIds = [...new Set(links.map((link) => link.sourcePageId))];
    const pages = pageIds.length > 0
      ? await this.prisma.wikiPage.findMany({
          where: {
            id: { in: pageIds },
            ...(input.sourceSpaceId !== undefined ? { spaceId: input.sourceSpaceId } : {})
          }
        })
      : [];
    const namespaceIds = [...new Set(pages.map((page) => page.namespaceId))];
    const namespaces = namespaceIds.length > 0
      ? await this.prisma.wikiNamespace.findMany({ where: { id: { in: namespaceIds } } })
      : [];
    const namespaceById = new Map(namespaces.map((item) => [item.id, item.code]));
    const projectedSources = await this.projectDerivedPages(pages, namespaceById, access);
    const projectedSourceByPageId = new Map(projectedSources.map((page) => [page.id, page]));
    const routePaths = await this.routePaths.preload(projectedSources, namespaceById);
    const readableSourceIds = new Set<bigint>();
    for (const source of projectedSources) {
      try {
        await this.wikiPermissions.assertCanReadPage({ ...access, page: source });
        readableSourceIds.add(source.id);
      } catch {
        // Counts and rows must not reveal ACL-hidden source documents.
      }
    }
    const isVisibleCurrentLink = (link: (typeof links)[number]) => {
      const source = projectedSourceByPageId.get(link.sourcePageId);
      return Boolean(source && source.currentRevisionId === link.sourceRevisionId && readableSourceIds.has(source.id));
    };
    const grouped = new Map<bigint, { readonly source: (typeof projectedSources)[number]; readonly types: Set<WikiBacklinkType> }>();
    for (const link of links) {
      if (!isVisibleCurrentLink(link)) continue;
      const source = projectedSourceByPageId.get(link.sourcePageId)!;
      const entry = grouped.get(source.id) ?? { source, types: new Set<WikiBacklinkType>() };
      entry.types.add(link.linkType as WikiBacklinkType);
      grouped.set(source.id, entry);
    }
    const visibleEntries = [...grouped.values()];
    const namespaceCounts = countBacklinks(visibleEntries.map(({ source }) => namespaceById.get(source.namespaceId) ?? 'main'));
    const typeCounts = ALL_BACKLINK_TYPES.map((type) => ({
      type,
      count: visibleEntries.filter((entry) => entry.types.has(type)).length
    })).filter((item) => item.count > 0);
    const selectedNamespace = namespaceCounts.some((item) => item.key === requestedNamespace)
      ? requestedNamespace
      : namespaceCounts[0]?.key ?? null;
    const filtered = visibleEntries
      .filter(({ source, types }) =>
        (selectedNamespace === null || (namespaceById.get(source.namespaceId) ?? 'main') === selectedNamespace) &&
        selectedTypes.some((type) => types.has(type))
      )
      .sort(compareBacklinkEntries);
    const cursor = parseBacklinkCursor(input.cursor, selectedNamespace, selectedTypes);
    const pageEntries = cursor?.direction === 'prev'
      ? filtered.filter((entry) => compareBacklinkEntryToCursor(entry, cursor) < 0).slice(-limit)
      : filtered.filter((entry) => !cursor || compareBacklinkEntryToCursor(entry, cursor) > 0).slice(0, limit);
    const first = pageEntries[0];
    const last = pageEntries.at(-1);
    const hasBefore = Boolean(first && filtered.some((entry) => compareBacklinkEntries(entry, first) < 0));
    const hasAfter = Boolean(last && filtered.some((entry) => compareBacklinkEntries(entry, last) > 0));
    const items: WikiBacklinkItem[] = pageEntries.map(({ source, types }) => {
      const sourceNamespace = namespaceById.get(source.namespaceId) ?? 'main';
      return {
        id: source.id.toString(),
        sourcePageId: source.id.toString(),
        sourceRevisionId: source.currentRevisionId!.toString(),
        namespace: sourceNamespace,
        title: source.title,
        displayTitle: source.displayTitle,
        routePath: routePaths.routePath(source, sourceNamespace),
        linkTypes: ALL_BACKLINK_TYPES.filter((type) => types.has(type)),
        updatedAt: source.updatedAt.toISOString()
      };
    });
    return {
      items,
      prevCursor: hasBefore && first ? encodeBacklinkCursor('prev', first, selectedNamespace, selectedTypes) : null,
      nextCursor: hasAfter && last ? encodeBacklinkCursor('next', last, selectedNamespace, selectedTypes) : null,
      summary: {
        total: visibleEntries.length,
        complete: true,
        namespaceCounts: namespaceCounts.map(({ key, count }) => ({ namespace: key, count })),
        typeCounts
      },
      filters: { types: selectedTypes, namespace: selectedNamespace }
    };
  }

  async getCategoryMembers(input: {
    readonly category: string;
    readonly accountId?: string | null;
    readonly viewer?: WikiAccessViewer;
    readonly namespace?: string;
    readonly cursor?: string;
    readonly limit?: string | number;
  }): Promise<WikiCategoryResponse> {
    const access = await resolveWikiAccessContext(
      this.prisma,
      this.wikiPermissions,
      input.viewer ?? input.accountId ?? null
    );
    const category = input.category.trim().replace(/_/g, ' ');
    const categorySlug = slugifyTitle(category);
    if (!categorySlug) throw new BadRequestException('category is required.');
    const categoryNamespace = await this.prisma.wikiNamespace.findUnique({
      where: { code: 'category' },
      select: { id: true, code: true }
    });
    const namespace = input.namespace?.trim()
      ? await this.prisma.wikiNamespace.findUnique({ where: { code: input.namespace.trim() }, select: { id: true, code: true } })
      : null;
    const emptyHierarchy = {
      document: null,
      parents: [],
      subcategories: [],
      isRoot: categorySlug === slugifyTitle('분류'),
      isOrphan: false
    };
    if (input.namespace?.trim() && !namespace) return { category, ...emptyHierarchy, items: [], nextCursor: null };
    const categoryPage = categoryNamespace
      ? await this.prisma.wikiPage.findUnique({
          where: { namespaceId_slug: { namespaceId: categoryNamespace.id, slug: categorySlug } }
        })
      : null;
    let readableCategoryPage = null as typeof categoryPage;
    if (categoryPage && categoryPage.status !== 'deleted' && categoryPage.currentRevisionId) {
      try {
        await this.wikiPermissions.assertCanReadPage({ ...access, page: categoryPage });
        readableCategoryPage = categoryPage;
      } catch {
        readableCategoryPage = null;
      }
    }
    const parentLinks = readableCategoryPage
      ? await this.prisma.wikiPageLink.findMany({
          where: {
            sourcePageId: readableCategoryPage.id,
            sourceRevisionId: readableCategoryPage.currentRevisionId ?? undefined,
            targetNamespaceCode: 'category',
            linkType: 'category'
          },
          orderBy: [{ targetSlug: 'asc' }],
          take: 100
        })
      : [];
    const parents = parentLinks.map((link) => ({
      category: categoryTitleFromSlug(link.targetSlug),
      routePath: wikiUrl('category', link.targetSlug)
    }));
    const childLinks = categoryNamespace
      ? await this.prisma.wikiPageLink.findMany({
          where: {
            targetNamespaceCode: 'category',
            targetSlug: categorySlug,
            linkType: 'category'
          },
          orderBy: [{ id: 'desc' }],
          take: 501
        })
      : [];
    const childPageIds = [...new Set(childLinks.map((link) => link.sourcePageId))];
    const childPages = categoryNamespace && childPageIds.length > 0
      ? await this.prisma.wikiPage.findMany({
          where: {
            id: { in: childPageIds },
            namespaceId: categoryNamespace.id,
            status: { in: [...PUBLIC_WIKI_PAGE_STATUSES] },
            pageType: { not: 'redirect' }
          }
        })
      : [];
    const childLinkByPageId = new Map(childLinks.map((link) => [link.sourcePageId, link]));
    const subcategories: WikiCategoryResponse['subcategories'][number][] = [];
    for (const childPage of childPages) {
      const link = childLinkByPageId.get(childPage.id);
      if (!link || childPage.currentRevisionId !== link.sourceRevisionId) continue;
      try {
        await this.wikiPermissions.assertCanReadPage({ ...access, page: childPage });
      } catch {
        continue;
      }
      subcategories.push({
        pageId: childPage.id.toString(),
        category: childPage.title,
        displayTitle: childPage.displayTitle,
        routePath: wikiUrl('category', childPage.title)
      });
    }
    subcategories.sort((left, right) => left.displayTitle.localeCompare(right.displayTitle, 'ko'));
    const isRoot = categorySlug === slugifyTitle('분류');
    const reachesRoot = isRoot || (readableCategoryPage && categoryNamespace
      ? await this.categoryParentsReachRoot(parentLinks.map((link) => link.targetSlug), categoryNamespace.id, access)
      : false);
    const limit = Math.min(Math.max(Number(input.limit ?? 30) || 30, 1), 100);
    const currentLinks = await this.prisma.wikiPageLink.findMany({
      where: {
        targetNamespaceCode: 'category',
        targetSlug: categorySlug,
        linkType: 'category'
      },
    });
    const releasedLinks = await this.prisma.serverWikiReleaseLink.findMany({
      where: {
        targetNamespaceCode: 'category',
        targetSlug: categorySlug,
        linkType: 'category',
        release: {
          publishedFor: { is: { status: 'active', publicationStatus: 'published' } },
        },
      },
    });
    const links = [...currentLinks, ...releasedLinks];
    const pageIds = [...new Set(links.map((link) => link.sourcePageId))];
    const pages = pageIds.length > 0
      ? await this.prisma.wikiPage.findMany({
          where: {
            id: { in: pageIds },
            ...(namespace
              ? { namespaceId: namespace.id }
              : categoryNamespace
                ? { namespaceId: { not: categoryNamespace.id } }
                : {})
          }
        })
      : [];
    const namespaceIds = [...new Set(pages.map((page) => page.namespaceId))];
    const namespaces = namespaceIds.length > 0
      ? await this.prisma.wikiNamespace.findMany({ where: { id: { in: namespaceIds } }, select: { id: true, code: true } })
      : [];
    const namespaceById = new Map(namespaces.map((item) => [item.id, item.code]));
    const projection = await this.projectDerivedPagesWithContext(pages, namespaceById, access);
    const routePaths = await this.routePaths.preload(projection.pages, namespaceById);
    const currentLinkKeys = new Set(currentLinks.map((link) => `${link.sourcePageId}:${link.sourceRevisionId}`));
    const releaseLinkKeys = new Set(releasedLinks.map((link) => [
      link.releaseId,
      link.serverWikiId,
      link.spaceId,
      link.sourcePageId,
      link.sourceRevisionId,
    ].join(':')));
    const visiblePages: typeof projection.pages = [];
    for (const page of projection.pages) {
      if (!page.currentRevisionId) continue;
      const source = projection.sourceByPageId.get(page.id);
      const hasMatchingLink = source?.kind === 'release'
        ? releaseLinkKeys.has([
            source.releaseId,
            source.serverWikiId,
            source.spaceId,
            page.id,
            page.currentRevisionId,
          ].join(':'))
        : currentLinkKeys.has(`${page.id}:${page.currentRevisionId}`);
      if (!hasMatchingLink) continue;
      try {
        await this.wikiPermissions.assertCanReadPage({ ...access, page });
      } catch {
        continue;
      }
      visiblePages.push(page);
    }
    visiblePages.sort(compareCategoryPages);
    const cursor = parseCategoryCursor(input.cursor, categorySlug, namespace?.code ?? null, projection.signature);
    const afterCursor = cursor
      ? visiblePages.filter((page) => compareCategoryPageToCursor(page, cursor) > 0)
      : visiblePages;
    const hasMore = afterCursor.length > limit;
    const pageRows = afterCursor.slice(0, limit);
    const items: WikiCategoryResponse['items'][number][] = pageRows.map((page) => {
      const namespaceCode = namespaceById.get(page.namespaceId) ?? 'main';
      return {
        id: page.id.toString(),
        pageId: page.id.toString(),
        namespace: namespaceCode,
        title: page.title,
        displayTitle: page.displayTitle,
        routePath: routePaths.routePath(page, namespaceCode),
        updatedAt: page.updatedAt.toISOString()
      };
    });
    const last = pageRows.at(-1);
    return {
      category,
      document: readableCategoryPage ? {
        pageId: readableCategoryPage.id.toString(),
        routePath: wikiUrl('category', readableCategoryPage.title)
      } : null,
      parents,
      subcategories,
      isRoot,
      isOrphan: Boolean(readableCategoryPage && !reachesRoot),
      items,
      nextCursor: hasMore && last
        ? encodeCategoryCursor(last, categorySlug, namespace?.code ?? null, projection.signature)
        : null
    };
  }

  private async categoryParentsReachRoot(initialParentSlugs: readonly string[], namespaceId: number, access: WikiAccessContext): Promise<boolean> {
    const rootSlug = slugifyTitle('분류');
    const queue = [...initialParentSlugs];
    const visited = new Set<string>();
    while (queue.length > 0 && visited.size < 1000) {
      const slug = queue.shift();
      if (!slug || visited.has(slug)) continue;
      if (slug === rootSlug) return true;
      visited.add(slug);
      const page = await this.prisma.wikiPage.findUnique({
        where: { namespaceId_slug: { namespaceId, slug } }
      });
      if (!page || page.status === 'deleted' || !page.currentRevisionId) continue;
      try {
        await this.wikiPermissions.assertCanReadPage({ ...access, page });
      } catch {
        continue;
      }
      const links = await this.prisma.wikiPageLink.findMany({
        where: {
          sourcePageId: page.id,
          sourceRevisionId: page.currentRevisionId,
          targetNamespaceCode: 'category',
          linkType: 'category'
        },
        orderBy: [{ targetSlug: 'asc' }],
        take: 100
      });
      for (const link of links) if (!visited.has(link.targetSlug)) queue.push(link.targetSlug);
    }
    return false;
  }

  async getDocumentTemplates(input: {
    readonly accountId?: string | null;
    readonly viewer?: WikiAccessViewer;
    readonly pageId?: string;
    readonly spaceId?: string;
  }): Promise<WikiDocumentTemplateSummary[]> {
    const access = await resolveWikiAccessContext(
      this.prisma,
      this.wikiPermissions,
      input.viewer ?? input.accountId ?? null
    );
    let spaceId: bigint | null = null;
    let targetAreas: readonly string[] = ['any'];
    if (input.pageId && input.spaceId) throw new BadRequestException('Choose either pageId or spaceId for document templates.');
    if (input.pageId) {
      const page = await this.prisma.wikiPage.findUnique({ where: { id: this.parseBigIntId(input.pageId, 'pageId') } });
      if (!page || page.status === 'deleted') throw new NotFoundException('Wiki page not found.');
      await this.wikiPermissions.assertCanReadPage({ ...access, page });
      spaceId = page.spaceId;
      targetAreas = page.pageType === 'server' ? ['any', 'official'] : ['any'];
    } else if (input.spaceId) {
      spaceId = this.parseBigIntId(input.spaceId, 'spaceId');
      await this.wikiPermissions.assertCanReadSpace({ ...access, spaceId });
      const space = await this.prisma.wikiSpace.findUnique({ where: { id: spaceId }, select: { spaceType: true } });
      if (!space) throw new NotFoundException('Wiki space not found.');
      targetAreas = space.spaceType === 'server_wiki' ? ['any', 'official'] : ['any'];
    }
    const profile = access.accountId
      ? await this.prisma.wikiProfile.findUnique({ where: { accountId: access.accountId }, select: { id: true } })
      : null;
    const templates = await this.prisma.documentTemplate.findMany({
      where: {
        status: 'active',
        targetArea: { in: [...targetAreas] },
        OR: [
          { templateScope: 'global', spaceId: null },
          ...(spaceId ? [{ templateScope: 'space', spaceId }] : []),
          ...(profile ? [{ templateScope: 'user', createdBy: profile.id, spaceId }] : [])
        ]
      },
      orderBy: [{ templateScope: 'asc' }, { title: 'asc' }, { id: 'asc' }],
      take: 80
    });
    return templates.map((template) => ({
      id: template.id.toString(),
      key: template.templateKey,
      title: template.title,
      description: template.description,
      scope: template.templateScope,
      targetArea: template.targetArea,
      defaultCategory: template.defaultCategory,
      contentRaw: template.contentRaw
    }));
  }

  async getContributions(input: {
    readonly profileId: string;
    readonly accountId?: string | null;
    readonly session?: SessionPayload | null;
    readonly cursor?: string;
    readonly limit?: string | number;
    readonly activity?: string;
  }): Promise<WikiContributionResponse> {
    const profileId = this.parseBigIntId(input.profileId, 'profileId');
    const requestedProfile = await this.prisma.wikiProfile.findUnique({
      where: { id: profileId },
      select: { id: true, username: true, displayName: true, status: true, mergedIntoProfileId: true }
    });
    if (!requestedProfile) throw new NotFoundException('Wiki profile not found.');
    const aliasDelegate = this.prisma.wikiProfileAlias;
    const alias = aliasDelegate
      ? await aliasDelegate.findUnique({
          where: { sourceProfileId: requestedProfile.id },
          select: { targetProfileId: true }
        })
      : null;
    const canonicalProfileId = alias?.targetProfileId ?? requestedProfile.mergedIntoProfileId ?? requestedProfile.id;
    const profile = canonicalProfileId === requestedProfile.id
      ? requestedProfile
      : await this.prisma.wikiProfile.findUnique({
          where: { id: canonicalProfileId },
          select: { id: true, username: true, displayName: true, status: true, mergedIntoProfileId: true }
        });
    if (!profile || !['active', 'blocked'].includes(profile.status)) throw new NotFoundException('Wiki profile not found.');
    const aliases = aliasDelegate
      ? await aliasDelegate.findMany({
          where: { targetProfileId: profile.id },
          select: { sourceProfileId: true },
          orderBy: { sourceProfileId: 'asc' }
        })
      : [];
    const actorProfileIds = [...new Set([profile.id, ...aliases.map((item) => item.sourceProfileId)])];
    const limit = Math.min(Math.max(Number(input.limit ?? 30) || 30, 1), 100);
    const cursor = input.cursor ? this.parseBigIntId(input.cursor, 'cursor') : null;
    const activity = input.activity ?? 'edits';
    if (!['edits', 'discussions', 'edit-requests', 'reviews'].includes(activity)) throw new BadRequestException('activity is invalid.');
    const common = {
      profile,
      actorProfileIds,
      requestedProfileId: requestedProfile.id,
      accountId: input.accountId ?? null,
      session: input.session ?? null,
      cursor,
      limit
    };
    if (activity === 'discussions') return this.getDiscussionContributions(common);
    if (activity === 'edit-requests') return this.getEditRequestContributions(common, false);
    if (activity === 'reviews') return this.getEditRequestContributions(common, true);
    const changes = await this.prisma.wikiRecentChange.findMany({
      where: {
        actorId: { in: actorProfileIds },
        pageId: { not: null },
        ...(cursor ? { id: { lt: cursor } } : {})
      },
      orderBy: [{ id: 'desc' }],
      take: Math.min(limit * 4 + 1, 401)
    });
    const hiddenByRevisionId = await this.summaryHiddenByRevisionId(
      changes.flatMap((change) => change.revisionId === null ? [] : [change.revisionId])
    );
    const pageIds = [...new Set(changes.flatMap((change) => change.pageId ? [change.pageId] : []))];
    const pages = pageIds.length > 0 ? await this.prisma.wikiPage.findMany({ where: { id: { in: pageIds } } }) : [];
    const namespaceIds = [...new Set(pages.map((page) => page.namespaceId))];
    const namespaces = namespaceIds.length > 0
      ? await this.prisma.wikiNamespace.findMany({ where: { id: { in: namespaceIds } } })
      : [];
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    const access = await resolveWikiAccessContext(
      this.prisma,
      this.wikiPermissions,
      input.session ?? input.accountId ?? null,
    );
    const projection = await this.projectDerivedPagesWithContext(pages, namespaceById, access);
    const pageById = new Map(projection.pages.map((page) => [page.id, page]));
    const routePaths = await this.routePaths.preload(projection.pages, namespaceById);
    const items: WikiContributionItem[] = [];
    let lastScannedId: bigint | null = null;
    for (const change of changes) {
      lastScannedId = change.id;
      if (!change.pageId) continue;
      const page = pageById.get(change.pageId);
      if (!page) continue;
      const source = projection.sourceByPageId.get(page.id);
      if (source?.kind === 'release' && (!source.publishedAt || change.createdAt > source.publishedAt)) continue;
      try {
        await this.wikiPermissions.assertCanReadPage({ ...access, page });
      } catch {
        continue;
      }
      const namespace = namespaceById.get(page.namespaceId) ?? change.namespaceCode;
      const publicSummary = publicWikiRecentChangeSummary({
        summary: change.summary,
        revisionId: change.revisionId,
        hiddenByRevisionId
      });
      items.push({
        id: change.id.toString(),
        kind: 'document',
        pageId: page.id.toString(),
        revisionId: change.revisionId?.toString() ?? null,
        changeType: change.changeType,
        title: page.displayTitle,
        namespace,
        routePath: routePaths.routePath(page, namespace),
        href: change.revisionId && (source?.kind !== 'release' || change.revisionId === page.currentRevisionId)
          ? `/wiki/revision/${change.revisionId.toString()}`
          : routePaths.routePath(page, namespace),
        ...publicSummary,
        isMinor: change.isMinor,
        status: null,
        createdAt: change.createdAt.toISOString()
      });
      if (items.length >= limit) break;
    }
    const mayHaveMore = changes.length > 0 && (items.length >= limit || changes.length >= Math.min(limit * 4 + 1, 401));
    return {
      activity: 'edits',
      profile: {
        id: profile.id.toString(),
        username: profile.username,
        displayName: profile.displayName,
        status: profile.status
      },
      requestedProfileId: requestedProfile.id.toString(),
      mergedProfileIds: actorProfileIds.map((id) => id.toString()),
      items,
      nextCursor: mayHaveMore ? lastScannedId?.toString() ?? null : null
    };
  }

  private async getDiscussionContributions(input: {
    readonly profile: { readonly id: bigint; readonly username: string; readonly displayName: string; readonly status: string };
    readonly actorProfileIds: bigint[];
    readonly requestedProfileId: bigint;
    readonly accountId: string | null;
    readonly session: SessionPayload | null;
    readonly cursor: bigint | null;
    readonly limit: number;
  }): Promise<WikiContributionResponse> {
    const scanLimit = Math.min(input.limit * 4 + 1, 401);
    const comments = await this.prisma.wikiDiscussionComment.findMany({
      where: { createdBy: { in: input.actorProfileIds }, ...(input.cursor ? { id: { lt: input.cursor } } : {}) },
      orderBy: [{ id: 'desc' }],
      take: scanLimit
    });
    const threadIds = [...new Set(comments.map((comment) => comment.threadId))];
    const threads = threadIds.length > 0 ? await this.prisma.wikiDiscussionThread.findMany({ where: { id: { in: threadIds } } }) : [];
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    const pageIds = [...new Set(threads.map((thread) => thread.pageId))];
    const pages = pageIds.length > 0 ? await this.prisma.wikiPage.findMany({ where: { id: { in: pageIds } } }) : [];
    const namespaces = pages.length > 0 ? await this.prisma.wikiNamespace.findMany({ where: { id: { in: [...new Set(pages.map((page) => page.namespaceId))] } } }) : [];
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    const access = await resolveWikiAccessContext(
      this.prisma,
      this.wikiPermissions,
      input.session ?? input.accountId ?? null,
    );
    const projection = await this.projectDerivedPagesWithContext(pages, namespaceById, access);
    const pageById = new Map(projection.pages.map((page) => [page.id, page]));
    const routePaths = await this.routePaths.preload(projection.pages, namespaceById);
    const readableThreadIds = new Set((await this.wikiPermissions.filterReadableThreads({
      accountId: input.accountId,
      actor: access.actor ?? undefined,
      items: threads.flatMap((thread) => {
        const page = pageById.get(thread.pageId);
        return page ? [{ thread, page }] : [];
      })
    })).map((item) => item.thread.id));
    const items: WikiContributionItem[] = [];
    let lastScannedId: bigint | null = null;
    for (const comment of comments) {
      lastScannedId = comment.id;
      const thread = threadById.get(comment.threadId);
      if (!thread || !readableThreadIds.has(thread.id)) continue;
      const page = pageById.get(thread.pageId);
      if (!page) continue;
      const namespace = namespaceById.get(page.namespaceId) ?? 'main';
      const serverWikiRoute = namespace === 'server' ? routePaths.serverWiki(page) : undefined;
      const routePath = routePaths.routePath(page, namespace);
      items.push({
        id: comment.id.toString(), kind: 'discussion', pageId: page.id.toString(), revisionId: null,
        changeType: comment.entryType === 'system' ? comment.eventType ?? 'discussion_event' : 'comment', title: thread.title, namespace, routePath,
        href: serverWikiRoute
          ? `${buildCanonicalServerWikiToolPath(serverWikiRoute.siteSlug, page.localPath, 'discuss', serverWikiRoute.slug, '/serverWiki')}?thread=${thread.id.toString()}&comment=${comment.id.toString()}`
          : `/wiki/discuss/${page.id.toString()}?thread=${thread.id.toString()}&comment=${comment.id.toString()}`,
        summary: comment.entryType === 'system'
          ? this.discussionEventSummary(comment.eventType, comment.eventBefore, comment.eventAfter)
          : comment.status === 'normal' ? comment.content.slice(0, 255) : '삭제된 댓글', isMinor: false,
        summaryHidden: false,
        status: thread.status, createdAt: comment.createdAt.toISOString()
      });
      if (items.length >= input.limit) break;
    }
    return this.contributionResponse(
      'discussions', input.profile, items, comments, lastScannedId, input.limit, scanLimit,
      input.requestedProfileId, input.actorProfileIds
    );
  }

  private discussionEventSummary(type: string | null, before: string | null, after: string | null): string {
    if (type === 'status_change') return `토론 상태 변경: ${this.discussionStatusLabel(before)} → ${this.discussionStatusLabel(after)}`;
    if (type === 'topic_change') return `주제 변경: ${before ?? '이전 주제'} → ${after ?? '새 주제'}`;
    if (type === 'page_move') return '토론 문서를 이동함';
    if (type === 'pin_change') return after ? '댓글을 고정함' : '댓글 고정을 해제함';
    return '토론 관리 작업';
  }

  private discussionStatusLabel(value: string | null): string {
    return ({ open: '열림', paused: '일시 중지', closed: '닫힘' } as Record<string, string>)[value ?? ''] ?? '알 수 없음';
  }

  private async getEditRequestContributions(input: {
    readonly profile: { readonly id: bigint; readonly username: string; readonly displayName: string; readonly status: string };
    readonly actorProfileIds: bigint[];
    readonly requestedProfileId: bigint;
    readonly accountId: string | null;
    readonly session: SessionPayload | null;
    readonly cursor: bigint | null;
    readonly limit: number;
  }, reviews: boolean): Promise<WikiContributionResponse> {
    const scanLimit = Math.min(input.limit * 4 + 1, 401);
    const requests = await this.prisma.wikiEditRequest.findMany({
      where: reviews
        ? { reviewedBy: { in: input.actorProfileIds }, reviewedAt: { not: null }, ...(input.cursor ? { id: { lt: input.cursor } } : {}) }
        : { createdBy: { in: input.actorProfileIds }, ...(input.cursor ? { id: { lt: input.cursor } } : {}) },
      orderBy: [{ id: 'desc' }],
      take: scanLimit
    });
    const hiddenByRevisionId = await this.summaryHiddenByRevisionId(
      requests.flatMap((request) => request.acceptedRevisionId === null ? [] : [request.acceptedRevisionId])
    );
    const pageIds = [...new Set(requests.flatMap((request) => request.pageId === null ? [] : [request.pageId]))];
    const pages = pageIds.length > 0 ? await this.prisma.wikiPage.findMany({ where: { id: { in: pageIds } } }) : [];
    const namespaces = pages.length > 0 ? await this.prisma.wikiNamespace.findMany({ where: { id: { in: [...new Set(pages.map((page) => page.namespaceId))] } } }) : [];
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    const access = await resolveWikiAccessContext(
      this.prisma,
      this.wikiPermissions,
      input.session ?? input.accountId ?? null,
    );
    const projection = await this.projectDerivedPagesWithContext(pages, namespaceById, access);
    const pageById = new Map(projection.pages.map((page) => [page.id, page]));
    const routePaths = await this.routePaths.preload(projection.pages, namespaceById);
    const readable = new Map<bigint, boolean>();
    const items: WikiContributionItem[] = [];
    let lastScannedId: bigint | null = null;
    for (const request of requests) {
      lastScannedId = request.id;
      const page = request.pageId === null ? null : pageById.get(request.pageId) ?? null;
      let pageId: string | null;
      let namespace: string;
      let title: string;
      let routePath: string;
      let href: string;
      if (page) {
        const source = projection.sourceByPageId.get(page.id);
        const activityAt = reviews ? request.reviewedAt ?? request.updatedAt : request.createdAt;
        if (source?.kind === 'release' && (
          !source.publishedAt
          || activityAt > source.publishedAt
          || request.acceptedRevisionId === null
        )) continue;
        if (!(await this.canReadContributionPage(page, access, readable))) continue;
        pageId = page.id.toString();
        namespace = namespaceById.get(page.namespaceId) ?? 'main';
        title = page.displayTitle;
        routePath = routePaths.routePath(page, namespace);
        const serverWikiRoute = namespace === 'server' ? routePaths.serverWiki(page) : undefined;
        href = serverWikiRoute
          ? `${buildCanonicalServerWikiToolPath(serverWikiRoute.siteSlug, page.localPath, 'requests', serverWikiRoute.slug, '/serverWiki')}?request=${request.id.toString()}`
          : `/wiki/edit-requests/${page.id.toString()}?returnTo=${encodeURIComponent(routePath)}&request=${request.id.toString()}`;
      } else {
        const {
          targetNamespaceId,
          targetNamespaceCode,
          targetSpaceId,
          targetTitle,
          targetDisplayTitle
        } = request;
        if (
          request.requestKind !== 'create' ||
          targetNamespaceId === null ||
          targetNamespaceCode === null ||
          targetSpaceId === null ||
          targetTitle === null ||
          targetDisplayTitle === null
        ) continue;
        if (targetNamespaceCode === 'server') {
          const canPreview = await this.wikiPermissions.canPreviewServerWikiSpace({ ...access, spaceId: targetSpaceId });
          if (!canPreview) continue;
        }
        try {
          await this.wikiPermissions.assertCanReadCreateTarget({
            ...access,
            namespaceId: targetNamespaceId,
            namespaceCode: targetNamespaceCode,
            spaceId: targetSpaceId,
            title: targetTitle
          });
        } catch {
          continue;
        }
        pageId = null;
        namespace = targetNamespaceCode;
        title = targetDisplayTitle;
        routePath = wikiUrl(targetNamespaceCode as Parameters<typeof wikiUrl>[0], targetTitle);
        href = `/wiki/edit-requests/request/${request.id.toString()}?returnTo=${encodeURIComponent(routePath)}`;
      }
      const copiedSummary = publicWikiRecentChangeSummary({
        summary: request.editSummary,
        revisionId: request.acceptedRevisionId,
        hiddenByRevisionId
      });
      const publicSummary = reviews && request.reviewNote
        ? { summary: request.reviewNote, summaryHidden: false }
        : copiedSummary;
      items.push({
        id: request.id.toString(), kind: reviews ? 'review' : 'edit_request', pageId, revisionId: request.acceptedRevisionId?.toString() ?? null,
        changeType: reviews ? 'review' : 'edit_request', title, namespace, routePath, href,
        ...publicSummary,
        isMinor: request.isMinor, status: request.status,
        createdAt: (reviews ? request.reviewedAt ?? request.updatedAt : request.createdAt).toISOString()
      });
      if (items.length >= input.limit) break;
    }
    return this.contributionResponse(
      reviews ? 'reviews' : 'edit-requests', input.profile, items, requests, lastScannedId, input.limit, scanLimit,
      input.requestedProfileId, input.actorProfileIds
    );
  }

  private async canReadContributionPage(
    page: Parameters<WikiPermissionService['assertCanReadPage']>[0]['page'] & { id: bigint },
    access: WikiAccessContext,
    cache: Map<bigint, boolean>,
  ): Promise<boolean> {
    const cached = cache.get(page.id);
    if (cached !== undefined) return cached;
    try {
      await this.wikiPermissions.assertCanReadPage({ ...access, page });
      cache.set(page.id, true);
      return true;
    } catch {
      cache.set(page.id, false);
      return false;
    }
  }

  private contributionResponse(
    activity: WikiContributionResponse['activity'],
    profile: { readonly id: bigint; readonly username: string; readonly displayName: string; readonly status: string },
    items: WikiContributionItem[], scanned: ReadonlyArray<unknown>, lastScannedId: bigint | null, limit: number, scanLimit: number,
    requestedProfileId: bigint = profile.id, mergedProfileIds: bigint[] = [profile.id]
  ): WikiContributionResponse {
    return {
      activity,
      profile: { id: profile.id.toString(), username: profile.username, displayName: profile.displayName, status: profile.status },
      requestedProfileId: requestedProfileId.toString(),
      mergedProfileIds: mergedProfileIds.map((id) => id.toString()),
      items,
      nextCursor: scanned.length > 0 && (items.length >= limit || scanned.length >= scanLimit) ? lastScannedId?.toString() ?? null : null
    };
  }

  async getDeletedPages(input: {
    readonly accountId: string;
    readonly profileId: bigint;
    readonly includeAll?: boolean;
    readonly cursor?: string;
    readonly limit?: string | number;
  }): Promise<WikiDeletedPageListResponse> {
    let managedSpaceIds: bigint[] = [];
    if (!input.includeAll) {
      const [spaces, roles, servers, verifiedMods] = await Promise.all([
        this.prisma.wikiSpace.findMany({
          where: { OR: [{ ownerUserId: input.profileId }, { createdBy: input.profileId }] },
          select: { id: true }
        }),
        this.prisma.subwikiRole.findMany({
          where: {
            userId: input.profileId,
            status: 'active',
            role: { in: ['owner', 'manager', 'maintainer'] }
          },
          select: { spaceId: true }
        }),
        this.prisma.server.findMany({ where: { ownerAccountId: input.accountId }, select: { id: true } }),
        this.prisma.modWiki.findMany({ where: { verifiedBy: input.profileId }, select: { spaceId: true } })
      ]);
      const ownedServerIds = servers.map((server) => server.id);
      const serverWikis = ownedServerIds.length > 0
        ? await this.prisma.serverWiki.findMany({
            where: { voteServerId: { in: ownedServerIds } },
            select: { spaceId: true }
          })
        : [];
      managedSpaceIds = [...new Set([
        ...spaces.map((space) => space.id),
        ...roles.map((role) => role.spaceId),
        ...serverWikis.map((wiki) => wiki.spaceId),
        ...verifiedMods.map((wiki) => wiki.spaceId)
      ])];
    }
    const cursor = input.cursor ? decodeDeletedPageCursor(input.cursor) : null;
    const limit = Math.min(Math.max(Number(input.limit ?? 50) || 50, 1), 100);
    const scope = !input.includeAll
      ? {
          OR: [
            { createdBy: input.profileId },
            ...(managedSpaceIds.length > 0 ? [{ spaceId: { in: managedSpaceIds } }] : [])
          ]
        }
      : {};
    const pages = await this.prisma.wikiPage.findMany({
      where: {
        status: 'deleted',
        AND: [
          scope,
          ...(cursor ? [{ OR: [{ updatedAt: { lt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { lt: cursor.id } }] }] : [])
        ]
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1
    });
    const pageRows = pages.slice(0, limit);
    const namespaceIds = [...new Set(pageRows.map((page) => page.namespaceId))];
    const namespaces = namespaceIds.length > 0
      ? await this.prisma.wikiNamespace.findMany({ where: { id: { in: namespaceIds } } })
      : [];
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    return {
      items: pageRows.map((page) => ({
        id: page.id.toString(),
        namespace: namespaceById.get(page.namespaceId) ?? 'main',
        title: page.title,
        displayTitle: page.displayTitle,
        spaceId: page.spaceId.toString(),
        updatedAt: page.updatedAt.toISOString()
      })),
      nextCursor: pages.length > limit && pageRows.length > 0
        ? encodeDeletedPageCursor(pageRows.at(-1)!)
        : null
    };
  }

  async getDeletedPageRecovery(input: {
    readonly pageId: string;
    readonly viewer: SessionPayload;
    readonly revisionId?: string;
    readonly cursor?: string;
    readonly limit?: string | number;
  }): Promise<WikiDeletedPageRecoveryResponse> {
    const pageId = this.parseBigIntId(input.pageId, 'pageId');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: pageId } });
    const access = await resolveWikiAccessContext(this.prisma, this.wikiPermissions, input.viewer);
    try {
      await this.wikiPermissions.assertCanRestorePage({ actor: access.actor ?? null, page });
    } catch (error) {
      if (error instanceof ForbiddenException) throw new NotFoundException('Wiki page not found.');
      throw error;
    }
    if (!page || page.status !== 'deleted') throw new NotFoundException('Wiki page not found.');
    const namespace = await this.prisma.wikiNamespace.findUnique({ where: { id: page.namespaceId } });
    if (!namespace) throw new NotFoundException('Wiki page not found.');

    const limit = Math.min(Math.max(Number(input.limit ?? 50) || 50, 1), 100);
    const cursorRevisionNo = input.cursor ? this.parsePositiveInt(input.cursor, 'cursor') : null;
    const rows = await this.prisma.wikiPageRevision.findMany({
      where: {
        pageId,
        visibility: 'public',
        ...(cursorRevisionNo ? { revisionNo: { lt: cursorRevisionNo } } : {})
      },
      orderBy: [{ revisionNo: 'desc' }],
      take: limit + 1
    });
    const latestPublic = await this.prisma.wikiPageRevision.findFirst({
      where: { pageId, visibility: 'public' },
      orderBy: [{ revisionNo: 'desc' }]
    });
    if (!latestPublic) throw new ConflictException('A wiki page without a public revision cannot be restored.');
    const selectedRevisionId = input.revisionId
      ? this.parseBigIntId(input.revisionId, 'revisionId')
      : latestPublic.id;
    const selected = selectedRevisionId === latestPublic.id
      ? latestPublic
      : await this.prisma.wikiPageRevision.findUnique({ where: { id: selectedRevisionId } });
    if (!selected || selected.pageId !== page.id || selected.visibility !== 'public') {
      throw new NotFoundException('Restore source revision not found.');
    }

    const pageRows = rows.slice(0, limit);
    const profileIds = [...new Set(pageRows.flatMap((revision) => revision.createdBy ? [revision.createdBy] : []))];
    if (selected.createdBy && !profileIds.includes(selected.createdBy)) profileIds.push(selected.createdBy);
    const profileById = await this.canonicalProfileViews(profileIds);
    const revisions = pageRows.map((revision, index) => this.recoveryRevisionSummary(
      revision,
      rows[index + 1] ?? null,
      profileById.get(revision.createdBy ?? -1n) ?? null
    ));
    const selectedSummary = this.recoveryRevisionSummary(
      selected,
      null,
      profileById.get(selected.createdBy ?? -1n) ?? null
    );
    const rendered = await this.renderPage(namespace.code, page, access, {
      followRedirects: false,
      redirectTrail: [],
      revisionId: selected.id,
      authorizedDeletedRecovery: true
    });
    const lifecycleRows = await this.prisma.wikiPageLifecycleEvent.findMany({
      where: { pageId },
      orderBy: [{ id: 'desc' }],
      take: 50
    });
    const lifecycle = await this.deletedRecoveryLifecycle(page, lifecycleRows);
    return {
      page: {
        id: page.id.toString(),
        namespace: namespace.code,
        title: page.title,
        displayTitle: page.displayTitle,
        spaceId: page.spaceId.toString(),
        updatedAt: page.updatedAt.toISOString(),
        pageType: page.pageType,
        latestPublicRevisionId: latestPublic.id.toString(),
        canSelectHistoricalRevision: namespace.code !== 'file'
      },
      revisions: {
        items: revisions,
        nextCursor: rows.length > limit ? pageRows.at(-1)?.revisionNo.toString() ?? null : null
      },
      lifecycle: { items: lifecycle, nextCursor: null },
      selectedRevision: {
        ...selectedSummary,
        html: rendered.html,
        headings: rendered.headings
      }
    };
  }

  private recoveryRevisionSummary(
    revision: Prisma.WikiPageRevisionGetPayload<object>,
    previous: Prisma.WikiPageRevisionGetPayload<object> | null,
    profile: { readonly displayName: string; readonly username: string } | null
  ): WikiRevisionSummary {
    return {
      id: revision.id.toString(),
      revisionNo: revision.revisionNo,
      ...publicWikiRevisionEditSummary(revision),
      isMinor: revision.isMinor,
      createdBy: revision.createdBy?.toString() ?? null,
      createdByName: revision.actorType === 'ip' ? '익명 기여자' : profile?.displayName ?? null,
      createdByUsername: revision.actorType === 'ip' ? null : profile?.username ?? null,
      createdAt: revision.createdAt.toISOString(),
      contentHash: revision.contentHash,
      contentSize: revision.contentSize,
      previousPublicRevisionId: previous?.id.toString() ?? null,
      sizeDelta: previous ? revision.contentSize - previous.contentSize : null
    };
  }

  private async deletedRecoveryLifecycle(
    page: WikiPage,
    rows: Prisma.WikiPageLifecycleEventGetPayload<object>[]
  ): Promise<WikiPageLifecycleEventSummary[]> {
    const actorIds = [...new Set(rows.flatMap((event) => event.actorProfileId ? [event.actorProfileId] : []))];
    const profileById = await this.canonicalProfileViews(actorIds);
    return rows.map((event) => {
      const sourceVisible = event.sourceNamespaceId === null || event.sourceSpaceId === null
        ? true
        : event.sourceNamespaceId === page.namespaceId && event.sourceSpaceId === page.spaceId;
      const destinationVisible = event.destinationNamespaceId === null || event.destinationSpaceId === null
        ? true
        : event.destinationNamespaceId === page.namespaceId && event.destinationSpaceId === page.spaceId;
      const identityRedacted = !sourceVisible || !destinationVisible;
      const actor = event.actorProfileId ? profileById.get(event.actorProfileId) : null;
      return {
        id: event.id.toString(),
        eventType: event.eventType as 'move' | 'delete' | 'restore',
        sourceRevisionId: event.sourceRevisionId?.toString() ?? null,
        actorProfileId: event.actorProfileId?.toString() ?? null,
        actorName: actor?.displayName ?? null,
        actorUsername: actor?.username ?? null,
        reason: identityRedacted && event.eventType === 'move' ? null : event.reason,
        source: sourceVisible ? lifecycleIdentity({
          namespace: event.sourceNamespaceCode,
          spaceId: event.sourceSpaceId,
          title: event.sourceTitle,
          path: event.sourcePath
        }) : null,
        destination: destinationVisible ? lifecycleIdentity({
          namespace: event.destinationNamespaceCode,
          spaceId: event.destinationSpaceId,
          title: event.destinationTitle,
          path: event.destinationPath
        }) : null,
        identityRedacted,
        createdAt: event.createdAt.toISOString()
      };
    });
  }

  async getSpecialDocuments(input: {
    readonly type?: string;
    readonly namespace?: string;
    readonly limit?: string | number;
    readonly cursor?: string;
    readonly accountId?: string | null;
    readonly viewer?: WikiAccessViewer;
  }): Promise<WikiSpecialDocumentResponse> {
    const access = await resolveWikiAccessContext(
      this.prisma,
      this.wikiPermissions,
      input.viewer ?? input.accountId ?? null
    );
    const allowedTypes: WikiSpecialDocumentType[] = [
      'random',
      'orphaned',
      'orphaned_categories',
      'wanted',
      'categories',
      'uncategorized',
      'old',
      'long',
      'short'
    ];
    const type = allowedTypes.includes(input.type as WikiSpecialDocumentType)
      ? input.type as WikiSpecialDocumentType
      : 'orphaned';
    const limit = Math.min(Math.max(Number(input.limit ?? 50) || 50, 1), 100);
    const namespace = input.namespace?.trim()
      ? await this.prisma.wikiNamespace.findUnique({ where: { code: input.namespace.trim() } })
      : null;
    if (input.namespace?.trim() && !namespace) return { type, items: [], nextCursor: null };
    if (type === 'orphaned_categories' && namespace && namespace.code !== 'category') return { type, items: [], nextCursor: null };
    if (type === 'random' || type === 'old' || type === 'long' || type === 'short' || type === 'uncategorized') {
      return this.getIndexedSpecialDocuments(type, limit, namespace?.id, namespace?.code ?? '', access, input.cursor);
    }
    return this.getSnapshotSpecialDocuments(type, limit, namespace?.code ?? '', access, input.cursor);
  }

  async getPublicBlockHistory(input: {
    readonly cursor?: string;
    readonly limit?: string;
    readonly action?: string;
    readonly query?: string;
  }): Promise<WikiPublicBlockHistoryResponse> {
    const cursor = input.cursor?.trim() ? this.parseBigIntId(input.cursor, 'cursor') : null;
    const parsedLimit = input.limit?.trim() ? Number(input.limit) : 50;
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1) {
      throw new BadRequestException('limit must be a positive integer.');
    }
    const limit = Math.min(parsedLimit, 100);
    const action = input.action?.trim() || null;
    if (action && action !== 'block' && action !== 'unblock') {
      throw new BadRequestException('action must be block or unblock.');
    }
    const query = input.query?.trim().slice(0, 64) ?? '';
    const matchingProfiles = query
      ? await this.prisma.wikiProfile.findMany({
          where: { OR: [{ username: { contains: query } }, { displayName: { contains: query } }] },
          select: { id: true },
          take: 200
        })
      : null;
    if (matchingProfiles && matchingProfiles.length === 0) return { items: [], nextCursor: null };

    const events = await this.prisma.wikiUserBlockEvent.findMany({
      where: {
        ...(cursor ? { id: { lt: cursor } } : {}),
        ...(action ? { action } : {}),
        ...(matchingProfiles ? { targetProfileId: { in: matchingProfiles.map((profile) => profile.id) } } : {})
      },
      orderBy: [{ id: 'desc' }],
      take: limit + 1
    });
    const hasMore = events.length > limit;
    const visible = events.slice(0, limit);
    const profileIds = [...new Set(visible.flatMap((event) => [event.targetProfileId, event.actorProfileId]))];
    const profiles = profileIds.length > 0
      ? await this.prisma.wikiProfile.findMany({
          where: { id: { in: profileIds } },
          select: { id: true, username: true, displayName: true }
        })
      : [];
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    const publicProfile = (profileId: bigint, fallback: string) => {
      const profile = profileById.get(profileId);
      return {
        profileId: profileId.toString(),
        username: profile?.username ?? null,
        displayName: profile?.displayName ?? fallback
      };
    };
    return {
      items: visible.map((event) => ({
        id: event.id.toString(),
        target: publicProfile(event.targetProfileId, '탈퇴한 사용자'),
        actor: publicProfile(event.actorProfileId, '알 수 없는 관리자'),
        action: event.action === 'unblock' ? 'unblock' : 'block',
        publicReason: event.publicReason?.trim() || null,
        createdAt: event.createdAt.toISOString()
      })),
      nextCursor: hasMore && visible.length > 0 ? visible[visible.length - 1]!.id.toString() : null
    };
  }

  private async getSnapshotSpecialDocuments(
    type: 'orphaned' | 'orphaned_categories' | 'wanted' | 'categories',
    limit: number,
    namespaceCode: string,
    access: WikiAccessContext,
    cursorValue?: string,
  ): Promise<WikiSpecialDocumentResponse> {
    const snapshot = await this.prisma.wikiSpecialSnapshot.findUnique({
      where: { type_namespaceCode: { type, namespaceCode } }
    });
    if (!snapshot) {
      return { type, items: [], nextCursor: null, generation: null, generatedAt: null, isRebuilding: true, isStale: true };
    }
    const snapshotItems = parseSpecialSnapshotItems(snapshot.items);
    if (snapshotItems === null) {
      return {
        type,
        items: [],
        nextCursor: null,
        generation: snapshot.generation,
        generatedAt: snapshot.generatedAt.toISOString(),
        isRebuilding: true,
        isStale: true,
      };
    }
    const binding: WikiSpecialCursorBinding = {
      type,
      namespace: namespaceCode,
      generation: snapshot.generation,
      viewerScope: specialCursorViewerScope(access),
    };
    let offset = 0;
    if (cursorValue) {
      const cursor = this.specialCursors.decode(cursorValue, binding);
      if (cursor.kind !== 'snapshot') {
        throw new BadRequestException('특수 문서 목록의 커서 종류가 올바르지 않습니다.');
      }
      offset = cursor.offset;
    }
    const aggregateType = type === 'wanted' || type === 'categories';
    const identifiedViewer = access.accountId !== null;
    const eligibleSnapshotItems = aggregateType && identifiedViewer
      ? snapshotItems.filter((item) => item.sourceContributionsComplete)
      : snapshotItems;
    const pageIds = eligibleSnapshotItems.flatMap((item) => item.pageId ? [BigInt(item.pageId)] : []);
    const sourcePageIds = aggregateType && identifiedViewer
      ? eligibleSnapshotItems.flatMap((item) => item.sourceContributions.map((source) => BigInt(source.pageId)))
      : [];
    const candidatePageIds = [...new Set([...pageIds, ...sourcePageIds])];
    const pages = candidatePageIds.length > 0
      ? await this.prisma.wikiPage.findMany({ where: { id: { in: candidatePageIds } } })
      : [];
    const readablePages = await this.wikiPermissions.filterReadablePages({ ...access, pages });
    const readablePageIds = new Set(readablePages.map((page) => page.id.toString()));
    const items: WikiSpecialDocumentItem[] = [];
    for (const item of eligibleSnapshotItems) {
      if (item.pageId && !readablePageIds.has(item.pageId)) continue;
      if (aggregateType && identifiedViewer) {
        const value = item.sourceContributions.reduce(
          (total, source) => total + (readablePageIds.has(source.pageId) ? source.count : 0),
          0
        );
        if (value === 0) continue;
        items.push(publicSpecialSnapshotItem(item, value));
      } else {
        items.push(publicSpecialSnapshotItem(item));
      }
    }
    if (aggregateType && identifiedViewer) {
      items.sort((left, right) =>
        (right.value ?? 0) - (left.value ?? 0) || left.id.localeCompare(right.id, 'ko')
      );
    }
    const stale = Date.now() - snapshot.generatedAt.getTime() > 30 * 60 * 1000;
    const pageItems = items.slice(offset, offset + limit);
    const nextOffset = offset + pageItems.length;
    return {
      type,
      items: pageItems,
      nextCursor: nextOffset < items.length
        ? this.specialCursors.encode(binding, { kind: 'snapshot', offset: nextOffset })
        : null,
      generation: snapshot.generation,
      generatedAt: snapshot.generatedAt.toISOString(),
      isRebuilding: false,
      isStale: stale
    };
  }

  private async getIndexedSpecialDocuments(
    type: 'random' | 'old' | 'long' | 'short' | 'uncategorized',
    limit: number,
    namespaceId: number | undefined,
    namespaceCode: string,
    access: WikiAccessContext,
    cursorValue?: string,
  ): Promise<WikiSpecialDocumentResponse> {
    const scanBudget = Math.min(Math.max(limit * 5, 50), 500);
    const baseWhere: Prisma.WikiPageWhereInput = {
      namespaceId,
      status: { in: [...PUBLIC_WIKI_PAGE_STATUSES] },
      pageType: { not: 'redirect' },
      currentRevisionId: { not: null },
      ...(type === 'uncategorized' ? { currentCategoryCount: 0 } : {})
    };
    const binding: WikiSpecialCursorBinding = {
      type,
      namespace: namespaceCode,
      generation: null,
      viewerScope: specialCursorViewerScope(access),
    };
    let decoded: IndexedSpecialCursor | null = null;
    if (cursorValue) {
      const cursor = this.specialCursors.decode(cursorValue, binding);
      if (cursor.kind !== 'indexed') {
        throw new BadRequestException('특수 문서 목록의 커서 종류가 올바르지 않습니다.');
      }
      decoded = cursor;
    }
    if (type === 'random' && cursorValue) throw new BadRequestException('임의 문서 목록에는 커서를 사용할 수 없습니다.');
    const snapshotAt = decoded ? new Date(decoded.snapshotAt) : new Date();
    if (type === 'random') {
      const bounds = await this.prisma.wikiPage.aggregate({
        where: baseWhere,
        _min: { id: true },
        _max: { id: true }
      });
      if (bounds._min.id === null || bounds._max.id === null) return { type, items: [], nextCursor: null };
      const anchor = randomBigIntBetween(bounds._min.id, bounds._max.id);
      const after = await this.prisma.wikiPage.findMany({
        where: { ...baseWhere, id: { gte: anchor } },
        orderBy: [{ id: 'asc' }],
        take: scanBudget
      });
      const remaining = scanBudget - after.length;
      const before = remaining > 0
        ? await this.prisma.wikiPage.findMany({
            where: { ...baseWhere, id: { lt: anchor } },
            orderBy: [{ id: 'asc' }],
            take: remaining
          })
        : [];
      const candidates = [...after, ...before];
      const visible = await this.wikiPermissions.filterReadablePages({ ...access, pages: candidates });
      const selected = visible.length > 0 ? [visible[Math.floor(Math.random() * visible.length)]!] : [];
      const namespaceIds = [...new Set(selected.map((page) => page.namespaceId))];
      const namespaces = namespaceIds.length > 0
        ? await this.prisma.wikiNamespace.findMany({ where: { id: { in: namespaceIds } }, select: { id: true, code: true } })
        : [];
      const namespaceById = new Map(namespaces.map((item) => [item.id, item.code]));
      const routePaths = await this.routePaths.preload(selected, namespaceById);
      return {
        type,
        items: selected.map((page) => this.specialPageItem(page, namespaceById.get(page.namespaceId) ?? 'main', null, routePaths)),
        nextCursor: null,
      };
    }

    const orderBy = indexedSpecialOrder(type);
    const visible: WikiPage[] = [];
    const seen = new Set<bigint>();
    let position = decoded;
    let lastScanned: WikiPage | null = null;
    let exhausted = false;
    for (let batch = 0; batch < 10 && visible.length <= limit; batch += 1) {
      const candidates = await this.prisma.wikiPage.findMany({
        where: indexedSpecialWhere(baseWhere, type, snapshotAt, position),
        orderBy,
        take: scanBudget,
      });
      if (candidates.length === 0) {
        exhausted = true;
        break;
      }
      lastScanned = candidates.at(-1)!;
      position = indexedSpecialPosition(type, snapshotAt, lastScanned);
      const readable = await this.wikiPermissions.filterReadablePages({ ...access, pages: candidates });
      for (const page of readable) {
        if (!seen.has(page.id)) {
          seen.add(page.id);
          visible.push(page);
        }
        if (visible.length > limit) break;
      }
      if (candidates.length < scanBudget) {
        exhausted = true;
        break;
      }
    }
    const selected = visible.slice(0, limit);
    const namespaceIds = [...new Set(selected.map((page) => page.namespaceId))];
    const namespaces = namespaceIds.length > 0
      ? await this.prisma.wikiNamespace.findMany({
          where: { id: { in: namespaceIds } },
          select: { id: true, code: true }
        })
      : [];
    const namespaceById = new Map(namespaces.map((item) => [item.id, item.code]));
    const routePaths = await this.routePaths.preload(selected, namespaceById);
    const cursorPage = visible.length > limit ? selected.at(-1) ?? null : lastScanned;
    const hasMore = visible.length > limit || !exhausted;
    return {
      type,
      items: selected.map((page) => this.specialPageItem(
        page,
        namespaceById.get(page.namespaceId) ?? 'main',
        type === 'long' || type === 'short' ? page.currentContentSize : null,
        routePaths
      )),
      nextCursor: hasMore && cursorPage
        ? this.specialCursors.encode(binding, indexedSpecialPosition(type, snapshotAt, cursorPage))
        : null,
    };
  }

  async getBlame(pageId: string, viewer?: WikiAccessViewer): Promise<WikiBlameResponse> {
    const id = this.parseBigIntId(pageId, 'pageId');
    const page = await this.prisma.wikiPage.findUnique({ where: { id } });
    if (!page || page.status === 'deleted') throw new NotFoundException('Wiki page not found.');
    const access = await resolveWikiAccessContext(this.prisma, this.wikiPermissions, viewer);
    const publication = await this.publishedRevisionScopeForViewer(page, access);
    await this.wikiPermissions.assertCanReadPage({ ...access, page });
    await this.wikiPermissions.assertCanUsePageAction({ ...access, action: 'history', page });
    const revisionWhere = {
      pageId: page.id,
      visibility: 'public' as const,
      ...(publication ? { id: { in: publication.revisionItems.map((item) => item.revisionId) } } : {}),
    };
    const total = await this.prisma.wikiPageRevision.count({ where: revisionWhere });
    const revisions = await this.prisma.wikiPageRevision.findMany({
      where: revisionWhere,
      orderBy: [{ revisionNo: 'asc' }],
      ...(total > 500 ? { skip: total - 500 } : {}),
      take: 500,
      select: { id: true, revisionNo: true, contentRaw: true, createdBy: true, createdAt: true }
    });
    const current = revisions.at(-1);
    if (!current) throw new NotFoundException('Public wiki revision not found.');

    type Attribution = { revisionId: bigint; revisionNo: number; createdBy: bigint | null; createdAt: Date };
    let lines: string[] = [];
    let attribution: Attribution[] = [];
    const lineLimit = 5_000;
    for (const revision of revisions) {
      const nextLines = revision.contentRaw.replace(/\r\n/g, '\n').split('\n').slice(0, lineLimit);
      const nextAttribution: Attribution = {
        revisionId: revision.id,
        revisionNo: revision.revisionNo,
        createdBy: revision.createdBy,
        createdAt: revision.createdAt
      };
      attribution = transferLineAttribution(lines, attribution, nextLines, nextAttribution);
      lines = nextLines;
    }
    const profileIds = [...new Set(attribution.flatMap((item) => item.createdBy ? [item.createdBy] : []))];
    const profileById = await this.canonicalProfileViews(profileIds);
    const nameById = new Map([...profileById.entries()].map(([id, profile]) => [id, profile.displayName]));
    return {
      pageId: page.id.toString(),
      revisionId: current.id.toString(),
      revisionNo: current.revisionNo,
      revisionCount: total,
      truncatedHistory: total > revisions.length,
      lineCount: current.contentRaw.replace(/\r\n/g, '\n').split('\n').length,
      truncatedLines: current.contentRaw.replace(/\r\n/g, '\n').split('\n').length > lineLimit,
      lines: lines.map((content, index) => {
        const source = attribution[index]!;
        return {
          lineNo: index + 1,
          content,
          revisionId: source.revisionId.toString(),
          revisionNo: source.revisionNo,
          createdBy: source.createdBy?.toString() ?? null,
          createdByName: source.createdBy ? nameById.get(source.createdBy) ?? '알 수 없는 사용자' : '알 수 없는 사용자',
          createdAt: source.createdAt.toISOString()
        };
      })
    };
  }

  private specialPageItem(
    page: { id: bigint; namespaceId: number; spaceId: bigint; localPath: string; title: string; displayTitle: string; updatedAt: Date },
    namespace: string,
    value: number | null,
    routePaths?: WikiRoutePathBatch
  ): WikiSpecialDocumentItem {
    return {
      id: page.id.toString(), pageId: page.id.toString(), namespace, title: page.title, displayTitle: page.displayTitle,
      routePath: routePaths?.routePath(page, namespace) ?? wikiUrl(namespace as Parameters<typeof wikiUrl>[0], page.title), value, updatedAt: page.updatedAt.toISOString()
    };
  }

  async search(input: {
    readonly q?: string;
    readonly namespace?: string;
    readonly serverSlug?: string;
    readonly target?: string;
    /** Internal tenant boundary used by credentialed API tokens. */
    readonly spaceId?: bigint;
    readonly limit?: string | number;
    readonly cursor?: string;
    readonly accountId?: string | null;
    readonly viewer?: WikiAccessViewer;
  }): Promise<WikiSearchResponse> {
    const query = input.q?.trim() ?? '';
    if (!query) {
      return { items: [], nextCursor: null };
    }
    if (query.length > 100) throw new BadRequestException('q is too long.');
    const target = input.target?.trim() || 'all';
    if (!['all', 'title', 'content'].includes(target)) {
      throw new BadRequestException('target must be all, title, or content.');
    }
    const limit = Math.min(Math.max(Number(input.limit ?? 20) || 20, 1), 50);
    const cursor = parseWikiSearchCursor(input.cursor);
    let spaceId = input.spaceId;
    let namespaceCode = input.namespace?.trim() || undefined;
    let releasedSearchWiki: {
      readonly id: bigint;
      readonly spaceId: bigint;
      readonly slug: string;
      readonly siteSlug: string | null;
      readonly publicationStatus: string;
      readonly publishedReleaseId: bigint | null;
    } | null = null;
    if (input.serverSlug?.trim()) {
      const requestedSlug = input.serverSlug.trim();
      const serverWiki = await this.prisma.serverWiki.findFirst({
        where: { OR: [{ siteSlug: requestedSlug }, { slug: requestedSlug }] },
        select: {
          id: true,
          spaceId: true,
          slug: true,
          siteSlug: true,
          status: true,
          publicationStatus: true,
          publishedReleaseId: true,
        },
      });
      if (!serverWiki || serverWiki.status !== 'active') {
        return { items: [], nextCursor: null };
      }
      if (namespaceCode && namespaceCode !== 'server') {
        return { items: [], nextCursor: null };
      }
      namespaceCode = 'server';
      spaceId = serverWiki.spaceId;
      releasedSearchWiki = serverWiki;
    }
    const namespace = namespaceCode
      ? await this.prisma.wikiNamespace.findUnique({ where: { code: namespaceCode } })
      : null;
    if (namespaceCode && !namespace) {
      return { items: [], nextCursor: null };
    }
    const access = await resolveWikiAccessContext(
      this.prisma,
      this.wikiPermissions,
      input.viewer ?? input.accountId ?? null,
    );

    if (releasedSearchWiki && namespace) {
      const canPreview = await this.wikiPermissions.canPreviewServerWikiSpace({
        ...access,
        spaceId: releasedSearchWiki.spaceId,
      });
      if (!canPreview) {
        if (releasedSearchWiki.publicationStatus !== 'published'
          || releasedSearchWiki.publishedReleaseId === null) {
          return { items: [], nextCursor: null };
        }
        return this.searchReleasedServerWiki({
          wiki: releasedSearchWiki,
          namespaceId: namespace.id,
          query,
          target: target as WikiSearchTarget,
          limit,
          cursor,
          access,
        });
      }
    }

    const scanLimit = Math.max(limit * 4, 50);
    const serverNamespace = namespaceCode === 'server' && namespace
      ? namespace
      : !namespaceCode
        ? await this.prisma.wikiNamespace.findUnique({ where: { code: 'server' } })
        : null;
    const [currentMatchIds, releasedMatchIds] = await Promise.all([
      findCurrentSearchMatchIds(this.prisma, {
        query,
        namespaceId: namespace?.id ?? null,
        spaceId: spaceId ?? null,
        cursor,
        limit: scanLimit + 1,
      }),
      serverNamespace && spaceId === undefined && !releasedSearchWiki
        ? findReleasedServerWikiSearchMatchIds(this.prisma, {
            query,
            namespaceId: serverNamespace.id,
            cursor,
            limit: scanLimit + 1,
          })
        : Promise.resolve([]),
    ]);
    const hasCandidateSentinel = currentMatchIds.length > scanLimit || releasedMatchIds.length > scanLimit;
    const candidateIds = currentMatchIds.slice(0, scanLimit);
    const releaseCandidateIds = releasedMatchIds.slice(0, scanLimit);
    const unorderedPages = candidateIds.length > 0
      ? await this.prisma.wikiPage.findMany({ where: { id: { in: candidateIds } } })
      : [];
    const unorderedReleaseItems = releaseCandidateIds.length > 0
      ? await this.prisma.serverWikiReleaseItem.findMany({
          where: { id: { in: releaseCandidateIds } },
          include: { release: { select: { serverWiki: { select: { slug: true, siteSlug: true } } } } },
        })
      : [];
    const pageById = new Map(unorderedPages.map((page) => [page.id, page]));
    const pages = candidateIds.flatMap((id) => {
      const page = pageById.get(id);
      return page && (spaceId === undefined || page.spaceId === spaceId) ? [page] : [];
    });
    const releaseItemById = new Map(unorderedReleaseItems.map((item) => [item.id, item]));
    const releaseItems = releaseCandidateIds.flatMap((id) => {
      const item = releaseItemById.get(id);
      return item ? [item] : [];
    });
    const serverSpaceIds = [...new Set([
      ...pages.filter((page) => page.namespaceId === serverNamespace?.id).map((page) => page.spaceId),
      ...releaseItems.map((item) => item.spaceId),
    ])];
    const previewSpaceIds = new Set<bigint>();
    for (const candidateSpaceId of serverSpaceIds) {
      if (await this.wikiPermissions.canPreviewServerWikiSpace({ ...access, spaceId: candidateSpaceId })) {
        previewSpaceIds.add(candidateSpaceId);
      }
    }
    const currentPages = pages.filter((page) =>
      page.namespaceId !== serverNamespace?.id || previewSpaceIds.has(page.spaceId));
    const publicReleaseItems = releaseItems.filter((item) => !previewSpaceIds.has(item.spaceId));
    const revisionIds = [
      ...currentPages.flatMap((page) => page.currentRevisionId ? [page.currentRevisionId] : []),
      ...publicReleaseItems.map((item) => item.revisionId),
    ];
    const revisions = revisionIds.length > 0
      ? await this.prisma.wikiPageRevision.findMany({
          where: { id: { in: revisionIds }, visibility: 'public' },
          select: { id: true, pageId: true, contentRaw: true },
        })
      : [];
    const revisionByKey = new Map(revisions.map((revision) => [`${revision.pageId}:${revision.id}`, revision]));
    const matchesTarget = (identity: { title: string; displayTitle: string; slug: string; localPath: string }, contentRaw: string) => {
      const titleMatch = wikiSearchTextMatches(
        [identity.title, identity.displayTitle, identity.slug, identity.localPath].join(' '),
        query,
      );
      const contentMatch = wikiSearchTextMatches(contentRaw, query);
      return target === 'title' ? titleMatch : target === 'content' ? contentMatch : titleMatch || contentMatch;
    };
    const currentCandidates = currentPages.flatMap((page) => {
      const revision = page.currentRevisionId ? revisionByKey.get(`${page.id}:${page.currentRevisionId}`) : null;
      return revision && matchesTarget(page, revision.contentRaw) ? [{ kind: 'current' as const, page, revision }] : [];
    });
    const releaseCandidates = publicReleaseItems.flatMap((item) => {
      const revision = revisionByKey.get(`${item.pageId}:${item.revisionId}`);
      return revision && matchesTarget(item, revision.contentRaw)
        ? [{ kind: 'release' as const, page: pageFromServerWikiReleaseItem(item), revision, item }]
        : [];
    });
    const readableCurrent = await this.wikiPermissions.filterReadablePages({
      ...access,
      pages: currentCandidates.map((candidate) => candidate.page),
    });
    const readableReleased = await this.wikiPermissions.filterReadablePages({
      ...access,
      pages: releaseCandidates.map((candidate) => candidate.page),
    });
    const readableCurrentIds = new Set(readableCurrent.map((page) => page.id));
    const readableReleasedIds = new Set(readableReleased.map((page) => page.id));
    const projections = [...currentCandidates, ...releaseCandidates]
      .sort((left, right) => right.page.updatedAt.getTime() - left.page.updatedAt.getTime()
        || (right.page.id > left.page.id ? 1 : right.page.id < left.page.id ? -1 : 0));
    const readableProjections = projections.filter((projection) => projection.kind === 'current'
      ? readableCurrentIds.has(projection.page.id)
      : readableReleasedIds.has(projection.page.id));
    const resultProjections = readableProjections.slice(0, limit);
    const namespaceIds = [...new Set(resultProjections.map((projection) => projection.page.namespaceId))];
    const namespaces = namespaceIds.length > 0
      ? await this.prisma.wikiNamespace.findMany({
          where: { id: { in: namespaceIds } },
          select: { id: true, code: true }
        })
      : [];
    const namespaceById = new Map(namespaces.map((item) => [item.id, item.code]));
    const currentResultPages = resultProjections
      .filter((projection) => projection.kind === 'current')
      .map((projection) => projection.page);
    const routePaths = await this.routePaths.preload(currentResultPages, namespaceById);
    const items: WikiSearchResult[] = [];
    for (const projection of resultProjections) {
      const { page, revision } = projection;
      const namespaceCode = namespaceById.get(page.namespaceId) ?? 'main';
      const snippet = makeSearchSnippet(revision.contentRaw, query, page.displayTitle);
      items.push({
        pageId: page.id.toString(),
        namespace: namespaceCode,
        title: page.title,
        displayTitle: page.displayTitle,
        routePath: projection.kind === 'release'
          ? buildCanonicalServerWikiPath(
              projection.item.release.serverWiki.siteSlug ?? projection.item.release.serverWiki.slug,
              page.title,
              projection.item.release.serverWiki.slug,
              '/serverWiki',
            )
          : routePaths.routePath(page, namespaceCode),
        snippet,
        highlights: {
          title: findSearchHighlights(page.displayTitle, query),
          snippet: findSearchHighlights(snippet, query)
        },
        updatedAt: page.updatedAt.toISOString()
      });
    }
    const lastVisible = resultProjections.at(-1);
    const lastScanned = projections.at(-1);
    const hasMore = readableProjections.length > limit || hasCandidateSentinel;
    const cursorProjection = readableProjections.length > limit ? lastVisible : lastScanned;
    return {
      items,
      nextCursor: hasMore && cursorProjection
        ? encodeWikiSearchCursor(cursorProjection.page.updatedAt, cursorProjection.page.id)
        : null,
    };
  }

  private async searchReleasedServerWiki(input: {
    readonly wiki: {
      readonly id: bigint;
      readonly spaceId: bigint;
      readonly slug: string;
      readonly siteSlug: string | null;
      readonly publishedReleaseId: bigint;
    };
    readonly namespaceId: number;
    readonly query: string;
    readonly target: WikiSearchTarget;
    readonly limit: number;
    readonly cursor: { readonly updatedAt: Date; readonly id: bigint } | null;
    readonly access: WikiAccessContext;
  }): Promise<WikiSearchResponse> {
    const items = await this.prisma.serverWikiReleaseItem.findMany({
      where: {
        releaseId: input.wiki.publishedReleaseId,
        serverWikiId: input.wiki.id,
        spaceId: input.wiki.spaceId,
        namespaceId: input.namespaceId,
        ...(input.cursor
          ? {
              OR: [
                { pageUpdatedAt: { lt: input.cursor.updatedAt } },
                { pageUpdatedAt: input.cursor.updatedAt, pageId: { lt: input.cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ pageUpdatedAt: 'desc' }, { pageId: 'desc' }],
    });
    const revisionIds = items.map((item) => item.revisionId);
    const revisions = revisionIds.length > 0
      ? await this.prisma.wikiPageRevision.findMany({
          where: { id: { in: revisionIds }, visibility: 'public' },
          select: { id: true, pageId: true, contentRaw: true },
        })
      : [];
    const revisionByKey = new Map(revisions.map((revision) => [`${revision.pageId}:${revision.id}`, revision]));
    const matching = items.filter((item) => {
      const revision = revisionByKey.get(`${item.pageId}:${item.revisionId}`);
      if (!revision) return false;
      const titleMatch = wikiSearchTextMatches(
        [item.title, item.displayTitle, item.slug, item.localPath].join(' '),
        input.query,
      );
      const contentMatch = wikiSearchTextMatches(revision.contentRaw, input.query);
      return input.target === 'title' ? titleMatch : input.target === 'content' ? contentMatch : titleMatch || contentMatch;
    });
    const pages = matching.map((item) => ({
      id: item.pageId,
      namespaceId: item.namespaceId,
      spaceId: item.spaceId,
      title: item.title,
      protectionLevel: item.protectionLevel,
      status: item.pageStatus,
      createdBy: item.createdBy,
      ownerProfileId: item.ownerProfileId,
    }));
    const readable = await this.wikiPermissions.filterReadablePages({ ...input.access, pages });
    const readableIds = new Set(readable.map((page) => page.id));
    const visible = matching.filter((item) => readableIds.has(item.pageId));
    const pageItems = visible.slice(0, input.limit);
    const siteSlug = input.wiki.siteSlug ?? input.wiki.slug;
    const responseItems = pageItems.flatMap((item): WikiSearchResult[] => {
      const revision = revisionByKey.get(`${item.pageId}:${item.revisionId}`);
      if (!revision) return [];
      const snippet = makeSearchSnippet(revision.contentRaw, input.query, item.displayTitle);
      return [{
        pageId: item.pageId.toString(),
        namespace: 'server',
        title: item.title,
        displayTitle: item.displayTitle,
        routePath: buildCanonicalServerWikiPath(siteSlug, item.title, input.wiki.slug, '/serverWiki'),
        snippet,
        highlights: {
          title: findSearchHighlights(item.displayTitle, input.query),
          snippet: findSearchHighlights(snippet, input.query),
        },
        updatedAt: item.pageUpdatedAt.toISOString(),
      }];
    });
    const last = pageItems.at(-1);
    return {
      items: responseItems,
      nextCursor: visible.length > input.limit && last
        ? encodeWikiSearchCursor(last.pageUpdatedAt, last.pageId)
        : null,
    };
  }

  async suggest(input: {
    readonly q?: string;
    readonly limit?: string | number;
    readonly accountId?: string | null;
    readonly viewer?: WikiAccessViewer;
  }): Promise<WikiSearchSuggestionResponse> {
    const query = input.q?.trim().slice(0, 100) ?? '';
    if (!query) return { items: [], exactMatch: null };
    const limit = Math.min(Math.max(Number(input.limit ?? 8) || 8, 1), 20);
    const slug = slugifyTitle(query);
    const [pages, releaseItems] = await Promise.all([
      this.prisma.wikiPage.findMany({
        where: {
          status: { in: [...PUBLIC_WIKI_PAGE_STATUSES] },
          pageType: { not: 'redirect' },
          currentRevisionId: { not: null },
          OR: [
            { title: { contains: query } },
            { displayTitle: { contains: query } },
            ...(slug ? [{ slug: { contains: slug } }, { localPath: { contains: slug } }] : []),
          ],
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 200,
      }),
      this.prisma.serverWikiReleaseItem.findMany({
        where: {
          release: {
            publishedFor: { is: { status: 'active', publicationStatus: 'published' } },
          },
          OR: [
            { title: { contains: query } },
            { displayTitle: { contains: query } },
            ...(slug ? [{ slug: { contains: slug } }, { localPath: { contains: slug } }] : []),
          ],
        },
        include: { release: { select: { serverWiki: { select: { slug: true, siteSlug: true } } } } },
        orderBy: [{ pageUpdatedAt: 'desc' }, { pageId: 'desc' }],
        take: 200,
      }),
    ]);
    const namespaces = pages.length > 0 || releaseItems.length > 0
      ? await this.prisma.wikiNamespace.findMany({
          where: { id: { in: [...new Set([...pages, ...releaseItems].map((page) => page.namespaceId))] } },
          select: { id: true, code: true },
        })
      : [];
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    const access = await resolveWikiAccessContext(
      this.prisma,
      this.wikiPermissions,
      input.viewer ?? input.accountId ?? null,
    );
    const serverNamespaceId = namespaces.find((namespace) => namespace.code === 'server')?.id;
    const serverSpaceIds = [...new Set([
      ...pages.filter((page) => page.namespaceId === serverNamespaceId).map((page) => page.spaceId),
      ...releaseItems.map((item) => item.spaceId),
    ])];
    const previewSpaceIds = new Set<bigint>();
    for (const candidateSpaceId of serverSpaceIds) {
      if (await this.wikiPermissions.canPreviewServerWikiSpace({ ...access, spaceId: candidateSpaceId })) {
        previewSpaceIds.add(candidateSpaceId);
      }
    }
    const currentPages = pages.filter((page) =>
      page.namespaceId !== serverNamespaceId || previewSpaceIds.has(page.spaceId));
    const publicReleaseItems = releaseItems.filter((item) => !previewSpaceIds.has(item.spaceId));
    const releasePages = publicReleaseItems.map(pageFromServerWikiReleaseItem);
    const [readableCurrent, readableReleased] = await Promise.all([
      this.wikiPermissions.filterReadablePages({ ...access, pages: currentPages }),
      this.wikiPermissions.filterReadablePages({ ...access, pages: releasePages }),
    ]);
    const readableCurrentIds = new Set(readableCurrent.map((page) => page.id));
    const readableReleasedIds = new Set(readableReleased.map((page) => page.id));
    const routePaths = await this.routePaths.preload(currentPages, namespaceById);
    const normalized = query.toLocaleLowerCase('ko-KR');
    const ranked: Array<{ score: number; exact: boolean; item: WikiSearchResult }> = [];
    for (const page of currentPages) {
      if (!readableCurrentIds.has(page.id)) continue;
      const candidates = [page.displayTitle, page.title, page.slug, page.localPath]
        .map((value) => value.toLocaleLowerCase('ko-KR'));
      const namespace = namespaceById.get(page.namespaceId) ?? 'main';
      const exact = candidates.some((value) => value === normalized);
      const matchRank = exact ? 0 : candidates.some((value) => value.startsWith(normalized)) ? 2 : 4;
      const score = matchRank + (namespace === 'main' ? 0 : 1);
      ranked.push({
        score,
        exact,
        item: {
          pageId: page.id.toString(), namespace, title: page.title, displayTitle: page.displayTitle,
          routePath: routePaths.routePath(page, namespace), snippet: '',
          highlights: { title: findSearchHighlights(page.displayTitle, query), snippet: [] },
          updatedAt: page.updatedAt.toISOString()
        }
      });
    }
    for (const item of publicReleaseItems) {
      if (!readableReleasedIds.has(item.pageId)) continue;
      const candidates = [item.displayTitle, item.title, item.slug, item.localPath]
        .map((value) => value.toLocaleLowerCase('ko-KR'));
      const exact = candidates.some((value) => value === normalized);
      const matchRank = exact ? 0 : candidates.some((value) => value.startsWith(normalized)) ? 2 : 4;
      const siteSlug = item.release.serverWiki.siteSlug ?? item.release.serverWiki.slug;
      ranked.push({
        score: matchRank + 1,
        exact,
        item: {
          pageId: item.pageId.toString(),
          namespace: 'server',
          title: item.title,
          displayTitle: item.displayTitle,
          routePath: buildCanonicalServerWikiPath(siteSlug, item.title, item.release.serverWiki.slug, '/serverWiki'),
          snippet: '',
          highlights: { title: findSearchHighlights(item.displayTitle, query), snippet: [] },
          updatedAt: item.pageUpdatedAt.toISOString(),
        },
      });
    }
    ranked.sort((left, right) => left.score - right.score || right.item.updatedAt.localeCompare(left.item.updatedAt) || left.item.pageId.localeCompare(right.item.pageId));
    const items = ranked.slice(0, limit).map(({ item }) => item);
    const exact = ranked.filter((entry) => entry.exact);
    const mainExact = exact.filter((entry) => entry.item.namespace === 'main');
    const exactMatch = mainExact.length === 1
      ? mainExact[0].item
      : exact.length === 1
        ? exact[0].item
        : null;
    return { items, exactMatch };
  }

  private async findMissingLinks(
    sourceNamespace: string,
    sourceLocalPath: string,
    targets: readonly string[],
    access: WikiAccessContext,
    releaseId?: bigint,
  ): Promise<Set<string>> {
    const resolvedByLinkKey = new Map<string, { namespace: string; slug: string }>();
    for (const target of targets) {
      const resolved = resolveContextualLinkTarget(sourceNamespace, sourceLocalPath, target);
      const slug = slugifyTitle(resolved.title);
      if (slug) resolvedByLinkKey.set(wikiLinkKey(target), { namespace: resolved.namespace, slug });
    }
    if (resolvedByLinkKey.size === 0) return new Set();

    const namespaceRows = await this.prisma.wikiNamespace.findMany({
      where: { code: { in: [...new Set([...resolvedByLinkKey.values()].map((item) => item.namespace))] } },
      select: { id: true, code: true }
    });
    const namespaceIdByCode = new Map(namespaceRows.map((item) => [item.code, item.id]));
    const readableTargets = new Set<string>();
    const sourceServerSlug = sourceNamespace === 'server' ? slugifyTitle(sourceLocalPath).split('/')[0] : null;
    const releasePinnedTargets = releaseId && sourceServerSlug
      ? [...resolvedByLinkKey.values()].filter((target) =>
          target.namespace === 'server' && target.slug.split('/')[0] === sourceServerSlug)
      : [];
    if (releaseId && releasePinnedTargets.length > 0) {
      const releaseItems = await this.prisma.serverWikiReleaseItem.findMany({
        where: {
          releaseId,
          namespaceId: {
            in: [...new Set(releasePinnedTargets.flatMap((target) => {
              const namespaceId = namespaceIdByCode.get(target.namespace);
              return namespaceId === undefined ? [] : [namespaceId];
            }))],
          },
          slug: { in: [...new Set(releasePinnedTargets.map((target) => target.slug))] },
        },
      });
      const revisions = releaseItems.length > 0
        ? await this.prisma.wikiPageRevision.findMany({
            where: { id: { in: releaseItems.map((item) => item.revisionId) }, visibility: 'public' },
          })
        : [];
      const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
      const namespaceCodeById = new Map(namespaceRows.map((namespace) => [namespace.id, namespace.code]));
      for (const item of releaseItems) {
        const revision = revisionById.get(item.revisionId);
        const namespaceCode = namespaceCodeById.get(item.namespaceId);
        if (!revision || !namespaceCode) continue;
        try {
          await this.wikiPermissions.assertCanReadPage({
            ...access,
            page: pageFromServerWikiReleaseItem(item),
            revision,
          });
          readableTargets.add(`${namespaceCode}:${item.slug}`);
        } catch {
          // A released target still follows its snapshotted ACL and publication policy.
        }
      }
    }
    const releasePinnedKeys = new Set(releasePinnedTargets.map((target) => `${target.namespace}:${target.slug}`));
    for (const namespace of namespaceRows) {
      const slugs = [...new Set([...resolvedByLinkKey.values()]
        .filter((item) => item.namespace === namespace.code && !releasePinnedKeys.has(`${item.namespace}:${item.slug}`))
        .map((item) => item.slug))];
      if (slugs.length === 0) continue;
      const pages = await this.prisma.wikiPage.findMany({
        where: {
          namespaceId: namespace.id,
          slug: { in: slugs },
          status: { not: 'deleted' }
        }
      });
      const currentRevisionIds = pages.flatMap((targetPage) => targetPage.currentRevisionId ? [targetPage.currentRevisionId] : []);
      const revisions = currentRevisionIds.length > 0
        ? await this.prisma.wikiPageRevision.findMany({
            where: { id: { in: currentRevisionIds }, visibility: 'public' }
          })
        : [];
      const revisionByPageId = new Map(revisions.map((revision) => [revision.pageId, revision]));
      for (const targetPage of pages) {
        const revision = revisionByPageId.get(targetPage.id);
        if (!revision || revision.id !== targetPage.currentRevisionId) continue;
        try {
          await this.wikiPermissions.assertCanReadPage({ ...access, page: targetPage, revision });
          readableTargets.add(`${namespace.code}:${targetPage.slug}`);
        } catch {
          // Restricted targets must be indistinguishable from missing pages.
        }
      }
    }

    const missing = new Set<string>();
    for (const [linkKey, target] of resolvedByLinkKey) {
      if (!namespaceIdByCode.has(target.namespace) || !readableTargets.has(`${target.namespace}:${target.slug}`)) {
        missing.add(linkKey);
      }
    }
    return missing;
  }

  private async renderPage(namespace: string, page: {
    namespaceId?: number;
    id: bigint;
    spaceId: bigint;
    localPath: string;
    slug: string;
    title: string;
    displayTitle: string;
    currentRevisionId: bigint | null;
    pageType: string;
    protectionLevel: string;
    status: string;
    updatedAt: Date;
  }, access: WikiAccessContext, options: {
    readonly followRedirects: boolean;
    readonly redirectTrail: readonly string[];
    readonly revisionId?: bigint;
    readonly releaseId?: bigint;
    readonly authorizedDeletedRecovery?: boolean;
  }): Promise<WikiPageResponse> {
    const revision = options.revisionId
      ? await this.prisma.wikiPageRevision.findFirst({
          where: {
            id: options.revisionId,
            pageId: page.id,
            visibility: 'public'
          }
        })
      : page.currentRevisionId
      ? await this.prisma.wikiPageRevision.findFirst({
          where: {
            id: page.currentRevisionId,
            pageId: page.id,
            visibility: 'public'
          }
        })
      : await this.prisma.wikiPageRevision.findFirst({
          where: {
            pageId: page.id,
            visibility: 'public'
          },
          orderBy: [{ revisionNo: 'desc' }]
        });

    if (!revision) {
      throw new NotFoundException('Public wiki revision not found.');
    }
    if (options.authorizedDeletedRecovery) {
      if (page.status !== 'deleted') throw new NotFoundException('Wiki page not found.');
    } else {
      await this.wikiPermissions.assertCanReadPage({
        ...access,
        page,
        revision
      });
    }
    const linkResolution = wikiLinkResolutionContext(namespace, page.localPath);
    const parsed = parseMarkup(revision.contentRaw, {
      linkResolution,
      gitBookMarkdown: namespace === 'server'
    });
    if (parsed.redirectTarget && options.followRedirects) {
      const target = resolveContextualLinkTarget(namespace, page.localPath, parsed.redirectTarget);
      const redirected = await this.getPageInternal(target.namespace, target.title, access, {
        followRedirects: true,
        redirectTrail: [...options.redirectTrail, `${namespace}:${page.slug}`]
      });
      return {
        ...redirected,
        redirectedFrom: redirected.redirectedFrom ?? {
          namespace,
          title: page.title,
          path: wikiUrl(namespace as Parameters<typeof wikiUrl>[0], page.title)
        }
      };
    }

    const serverWiki = await this.findServerWikiContext(
      namespace,
      page.spaceId,
      page.id,
      access,
      options.releaseId,
    );
    const expanded = parsed.includes.length > 0 && this.wikiIncludes
      ? await this.wikiIncludes.expand({
          ast: parsed.ast,
          accountId: access.accountId,
          actor: access.actor,
          requestIp: access.requestIp,
          sourcePageId: page.id,
          sourceNamespace: namespace,
          sourceLocalPath: page.localPath,
          releaseId: options.releaseId,
        })
      : { ast: parsed.ast, includedSourceBytes: 0 };
    const links = [...collectWikiLinkTargets(expanded.ast)];
    const hasFileDependencies = collectWikiFileNames(expanded.ast).size > 0;
    const hasIncludeDependencies = parsed.includes.length > 0;
    const hasLinkDependencies = links.length > 0;
    const cache = hasFileDependencies || hasIncludeDependencies || hasLinkDependencies
      ? null
      : await this.prisma.wikiPageRenderCache.findUnique({
          where: {
            revisionId_rendererVersion: {
              revisionId: revision.id,
              rendererVersion: WIKI_RENDERER_VERSION
            }
          }
        });
    const files = cache ? {} : await this.findRenderableFiles(expanded.ast, access);
    const missingLinks = hasLinkDependencies
      ? await this.findMissingLinks(namespace, page.localPath, links, access, options.releaseId)
      : new Set<string>();
    const html = cache?.html ?? renderDocument(expanded.ast, {
      files,
      missingLinks,
      internalLinkBasePath: serverWiki ? `/serverWiki/${encodeURIComponent(serverWiki.context.slug)}` : undefined,
      linkResolution,
    });
    if (Buffer.byteLength(html, 'utf8') > 2 * 1024 * 1024) {
      throw new BadRequestException('Rendered wiki document exceeds the size limit.');
    }
    if (!cache && !hasFileDependencies && !hasIncludeDependencies && !hasLinkDependencies) {
      await this.prisma.wikiPageRenderCache
        .create({
          data: {
            pageId: page.id,
            revisionId: revision.id,
            rendererVersion: WIKI_RENDERER_VERSION,
            html,
            createdAt: new Date()
          }
        })
        .catch(() => undefined);
    }
    return {
      id: page.id.toString(),
      namespace,
      spaceId: page.spaceId.toString(),
      slug: page.slug,
      title: page.title,
      displayTitle: page.displayTitle,
      pageType: page.pageType,
      protectionLevel: page.protectionLevel,
      status: page.status,
      updatedAt: page.updatedAt.toISOString(),
      revision: {
        id: revision.id.toString(),
        revisionNo: revision.revisionNo,
        contentHash: revision.contentHash,
        createdAt: revision.createdAt.toISOString(),
        createdBy: revision.createdBy?.toString() ?? null
      },
      html,
      links,
      categories: parsed.categories,
      headings: parsed.headings.map(({ level, title, anchor }) => ({ level, title, anchor })),
      redirectTarget: parsed.redirectTarget,
      redirectedFrom: null,
      serverDirectoryPath: serverWiki?.directoryPath ?? null,
      serverWiki: serverWiki?.context ?? null
    };
  }

  private async findServerWikiContext(
    namespace: string,
    spaceId: bigint,
    currentPageId: bigint,
    access: WikiAccessContext,
    releaseId?: bigint,
  ) {
    if (namespace !== 'server') {
      return null;
    }
    const serverWiki = await this.prisma.serverWiki.findFirst({
      where: { spaceId, status: 'active' },
      select: {
        id: true,
        voteServerId: true,
        serverName: true,
        slug: true,
        siteSlug: true,
        host: true,
        port: true,
        edition: true,
        supportedVersions: true,
        genres: true,
        publicationStatus: true,
        layoutKey: true,
        navigationOrder: true,
        navigationVersion: true,
        contentSettingsVersion: true,
      }
    });
    if (!serverWiki) {
      return null;
    }
    const releasedNavigation = releaseId
      ? await this.findReleasedServerWikiNavigationSummary({
          releaseId,
          serverWikiId: serverWiki.id,
          spaceId,
          contentSlug: serverWiki.slug,
          siteSlug: serverWiki.siteSlug ?? serverWiki.slug,
          currentPageId,
          access,
        })
      : null;
    const now = new Date();
    const [server, pageRows, layoutEntitlements, release] = await Promise.all([
      serverWiki.voteServerId
        ? this.prisma.server.findUnique({
            where: { id: serverWiki.voteServerId },
            select: {
              id: true,
              shortCode: true,
              wikiSpaceId: true,
              wikiSlug: true,
              name: true,
              joinHost: true,
              joinPort: true,
              edition: true,
              listingStatus: true,
              shortDescription: true,
              tags: true,
              verificationGrade: true,
              votes24h: true,
              votesMonthly: true,
              reviewsCount: true,
              websiteUrl: true,
              discordUrl: true,
              isOnline: true,
              playersOnline: true,
              playersMax: true,
              playersLastUpdatedAt: true,
              stats: {
                select: {
                  rankCurrent: true,
                  rankDelta24h: true,
                  rankBest: true,
                  votesTotal: true,
                  rankCalculatedAt: true,
                },
              },
            }
          })
        : null,
      releaseId && !releasedNavigation
        ? this.prisma.serverWikiReleaseItem.findMany({
            where: { releaseId, serverWikiId: serverWiki.id, spaceId, pageType: { not: 'redirect' } },
            orderBy: [{ localPath: 'asc' }, { pageId: 'asc' }],
            select: serverWikiNavigationReleaseItemSelect,
          })
        : releaseId
          ? Promise.resolve([])
          : this.prisma.wikiPage.findMany({
            where: { spaceId, status: { not: 'deleted' }, pageType: { not: 'redirect' } },
            orderBy: [{ localPath: 'asc' }, { id: 'asc' }]
          }),
      serverWiki.layoutKey === 'handbook' || serverWiki.layoutKey === 'brand'
        ? this.prisma.serverWikiLayoutEntitlement.findMany({
            where: {
              serverWikiId: serverWiki.id,
              layoutKey: serverWiki.layoutKey,
              status: 'active',
              startsAt: { lte: now },
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
            select: { layoutKey: true, status: true, startsAt: true, expiresAt: true },
            take: 1,
          })
        : Promise.resolve([]),
      releaseId
        ? this.prisma.serverWikiRelease.findFirst({
            where: { id: releaseId, serverWikiId: serverWiki.id },
            select: { presentationSnapshot: true },
          })
        : Promise.resolve(null),
    ]);
    if (server && serverWikiIdentityConflicts(serverWiki, server)) {
      throw new NotFoundException('Server wiki not found.');
    }
    const pages: Array<{
      readonly id: bigint;
      readonly namespaceId: number;
      readonly spaceId: bigint;
      readonly localPath: string;
      readonly slug: string;
      readonly title: string;
      readonly displayTitle: string;
      readonly currentRevisionId: bigint | null;
      readonly pageType: string;
      readonly protectionLevel: string;
      readonly status: string;
      readonly createdBy: bigint | null;
      readonly ownerProfileId: bigint | null;
      readonly updatedAt: Date;
    }> = releaseId
      ? (pageRows as NavigationReleaseItem[]).map(pageFromNavigationReleaseItem)
      : pageRows as WikiPage[];
    const currentRevisionIds = pages.flatMap((page) => page.currentRevisionId ? [page.currentRevisionId] : []);
    const publicRevisionKeys = releaseId
      ? new Set(pages.flatMap((page) => page.currentRevisionId ? [`${page.id}:${page.currentRevisionId}`] : []))
      : new Set((currentRevisionIds.length > 0
          ? await this.prisma.wikiPageRevision.findMany({
              where: { id: { in: currentRevisionIds }, visibility: 'public' },
              select: { id: true, pageId: true }
            })
          : [])
        .map((revision) => `${revision.pageId}:${revision.id}`));
    const publicPages = pages.filter((page) => page.currentRevisionId !== null
      && publicRevisionKeys.has(`${page.id}:${page.currentRevisionId}`));
    const readablePages = await this.wikiPermissions.filterReadablePages({ ...access, pages: publicPages });
    const siteSlug = serverWiki.siteSlug ?? serverWiki.slug;
    const presentation = release?.presentationSnapshot && typeof release.presentationSnapshot === 'object'
      && !Array.isArray(release.presentationSnapshot)
      ? release.presentationSnapshot as Record<string, Prisma.JsonValue>
      : null;
    const navigationOrder = presentation && 'navigationOrder' in presentation
      ? presentation.navigationOrder ?? null
      : serverWiki.navigationOrder;
    const releasedLayoutKey = presentation && typeof presentation.layoutKey === 'string'
      ? presentation.layoutKey
      : serverWiki.layoutKey;
    const navigation = releasedNavigation ? [] : buildServerWikiNavigation(
      serverWiki.slug,
      readablePages,
      currentPageId,
      siteSlug,
      '/serverWiki',
      navigationOrder
    );
    const pageDocuments = navigation.filter((item) => item.kind === 'page' && item.path !== null);
    const currentIndex = pageDocuments.findIndex((item) => item.current);
    const documentLink = (item: (typeof pageDocuments)[number] | undefined): ServerWikiNavigationDocumentLink | null =>
      item?.path ? { id: item.id, title: item.title, path: item.path } : null;
    const directoryPath = server
      && server.listingStatus === PUBLIC_SERVER_LISTING_STATUS
      && server.id === serverWiki.voteServerId
      && server.wikiSpaceId === spaceId
      && server.wikiSlug === serverWiki.slug
      ? `/servers/${server.shortCode?.trim() || server.id}`
      : null;
    const directoryOverview = server && directoryPath
      ? {
          path: directoryPath,
          shortDescription: server.shortDescription.trim() || 'No description',
          tags: normalizeWikiDirectoryTags(server.tags),
          verificationGrade: server.verificationGrade === 'Unverified' ? 'Unverified' as const : 'Verified' as const,
          rank: server.stats
            && server.stats.rankCalculatedAt
            && server.stats.votesTotal > 0
            && server.stats.rankCurrent > 0
            && server.stats.rankBest > 0
            ? {
                current: server.stats.rankCurrent,
                delta24h: server.stats.rankDelta24h,
                best: server.stats.rankBest,
                updatedAt: server.stats.rankCalculatedAt.toISOString(),
              }
            : null,
          votes24h: server.votes24h,
          votesMonthly: server.votesMonthly,
          reviewsCount: server.reviewsCount,
          live: {
            isOnline: server.isOnline,
            playersOnline: server.playersOnline,
            playersMax: server.playersMax,
            updatedAt: server.playersLastUpdatedAt?.toISOString() ?? null,
          },
          websiteUrl: safeWikiDirectoryUrl(server.websiteUrl),
          discordUrl: safeWikiDirectoryUrl(server.discordUrl),
        }
      : null;
    return {
      directoryPath,
      context: {
        spaceId: spaceId.toString(),
        name: server?.name ?? serverWiki.serverName,
        slug: siteSlug,
        contentSlug: serverWiki.slug,
        host: server?.joinHost ?? serverWiki.host,
        port: server?.joinPort ?? serverWiki.port,
        edition: server?.edition ?? serverWiki.edition,
        supportedVersions: serverWiki.supportedVersions,
        genres: serverWiki.genres,
        isOnline: server?.isOnline ?? null,
        playersOnline: server?.playersOnline ?? null,
        playersMax: server?.playersMax ?? null,
        directoryOverview,
        publicationStatus: serverWiki.publicationStatus as 'draft' | 'published' | 'unpublished',
        layout: resolveEffectiveServerWikiLayout(releasedLayoutKey, layoutEntitlements, now),
        navigationKey: releaseId
          ? `release:${releaseId}:v1`
          : `draft:${serverWiki.navigationVersion}:${serverWiki.contentSettingsVersion}`,
        previousDocument: releasedNavigation?.previous
          ?? (currentIndex > 0 ? documentLink(pageDocuments[currentIndex - 1]) : null),
        nextDocument: releasedNavigation?.next
          ?? (currentIndex >= 0 ? documentLink(pageDocuments[currentIndex + 1]) : null),
        navigation
      }
    };
  }

  private async findReleasedServerWikiNavigationSummary(input: {
    readonly releaseId: bigint;
    readonly serverWikiId: bigint;
    readonly spaceId: bigint;
    readonly contentSlug: string;
    readonly siteSlug: string;
    readonly currentPageId: bigint;
    readonly access: WikiAccessContext;
  }): Promise<{ readonly previous: ServerWikiNavigationDocumentLink | null; readonly next: ServerWikiNavigationDocumentLink | null } | null> {
    const current = await this.prisma.serverWikiReleaseNavigationNode.findFirst({
      where: {
        releaseId: input.releaseId,
        serverWikiId: input.serverWikiId,
        kind: 'page',
        pageId: input.currentPageId,
      },
      select: { position: true },
    });
    if (!current) return null;
    const findNeighbor = async (direction: 'previous' | 'next'): Promise<ServerWikiNavigationDocumentLink | null> => {
      let cursor = current.position;
      for (;;) {
        const nodes = await this.prisma.serverWikiReleaseNavigationNode.findMany({
          where: {
            releaseId: input.releaseId,
            serverWikiId: input.serverWikiId,
            kind: 'page',
            position: direction === 'previous' ? { lt: cursor } : { gt: cursor },
          },
          orderBy: { position: direction === 'previous' ? 'desc' : 'asc' },
          take: 32,
          select: { pageId: true, title: true, position: true },
        });
        const pageIds = nodes.flatMap((node) => node.pageId ? [node.pageId] : []);
        if (pageIds.length === 0) return null;
        const releaseItems = await this.prisma.serverWikiReleaseItem.findMany({
          where: {
            releaseId: input.releaseId,
            serverWikiId: input.serverWikiId,
            spaceId: input.spaceId,
            pageId: { in: pageIds },
          },
          select: serverWikiNavigationReleaseItemSelect,
        });
        const readable = await this.wikiPermissions.filterReadablePages({
          ...input.access,
          pages: releaseItems.map(pageFromNavigationReleaseItem),
        });
        const readableIds = new Set(readable.map((page) => page.id));
        const itemByPageId = new Map(releaseItems.map((item) => [item.pageId, item]));
        const node = nodes.find((candidate) => candidate.pageId !== null && readableIds.has(candidate.pageId));
        if (node?.pageId) {
          const item = itemByPageId.get(node.pageId);
          if (item) {
            return {
              id: node.pageId.toString(),
              title: node.title,
              path: buildCanonicalServerWikiPath(input.siteSlug, item.title, input.contentSlug, '/serverWiki'),
            };
          }
        }
        if (nodes.length < 32) return null;
        cursor = nodes[nodes.length - 1]!.position;
      }
    };
    const [previous, next] = await Promise.all([findNeighbor('previous'), findNeighbor('next')]);
    return { previous, next };
  }

  private async findRenderableFiles(ast: AstNode[], access: WikiAccessContext) {
    const fileNames = Array.from(collectWikiFileNames(ast));
    if (fileNames.length === 0) {
      return {};
    }
    const files = await this.prisma.uploadedFile.findMany({
      where: {
        wikiFilename: { in: fileNames },
        usageContext: 'wiki_editor',
        status: 'active'
      }
    });
    const visibleFiles = [];
    for (const file of files) {
      const decision = fileReadDecision(file, {
        accountId: access.accountId,
        permissions: access.actor?.permissions
      });
      if (decision === 'allow') {
        visibleFiles.push(file);
        continue;
      }
      if (decision !== 'linked') continue;
      const linkedId = file.linkedResourceId?.trim();
      if (!linkedId || !/^\d+$/.test(linkedId)) continue;
      try {
        if (file.linkedResourceType === 'wiki_page') {
          const linkedPage = await this.prisma.wikiPage.findUnique({ where: { id: BigInt(linkedId) } });
          await this.wikiPermissions.assertCanReadPage({ ...access, page: linkedPage });
          visibleFiles.push(file);
        } else if (file.linkedResourceType === 'wiki_space') {
          await this.wikiPermissions.assertCanReadSpace({ ...access, spaceId: BigInt(linkedId) });
          visibleFiles.push(file);
        }
      } catch {
        // Render the same missing-file placeholder for unreadable and absent files.
      }
    }
    return Object.fromEntries(
      visibleFiles.map((file) => [
        file.wikiFilename ?? file.filename,
        {
          url: file.publicPath,
          mimeType: file.mimeType,
          originalName: file.originalName ?? file.filename,
          license: file.license,
          sourceUrl: file.sourceUrl,
          sourceText: file.sourceText
        }
      ])
    );
  }

  private async canonicalProfileViews(profileIds: bigint[]): Promise<Map<bigint, {
    readonly id: bigint;
    readonly displayName: string;
    readonly username: string;
  }>> {
    if (profileIds.length === 0) return new Map();
    const profileDelegate = this.prisma.wikiProfile;
    if (!profileDelegate) return new Map();
    const aliasDelegate = this.prisma.wikiProfileAlias;
    const [profiles, aliases] = await Promise.all([
      profileDelegate.findMany({
        where: { id: { in: profileIds } },
        select: { id: true, displayName: true, username: true }
      }),
      aliasDelegate
        ? aliasDelegate.findMany({
            where: { sourceProfileId: { in: profileIds } },
            select: { sourceProfileId: true, targetProfileId: true }
          })
        : Promise.resolve([])
    ]);
    const targetIds = [...new Set(aliases.map((alias) => alias.targetProfileId))];
    const targets = targetIds.length > 0
      ? await profileDelegate.findMany({
          where: { id: { in: targetIds } },
          select: { id: true, displayName: true, username: true }
        })
      : [];
    const direct = new Map(profiles.map((profile) => [profile.id, profile]));
    const targetById = new Map(targets.map((profile) => [profile.id, profile]));
    for (const alias of aliases) {
      const target = targetById.get(alias.targetProfileId);
      if (target) direct.set(alias.sourceProfileId, target);
    }
    return direct;
  }

  private async summaryHiddenByRevisionId(revisionIds: readonly bigint[]): Promise<Map<bigint, boolean>> {
    const uniqueIds = [...new Set(revisionIds)];
    if (uniqueIds.length === 0) return new Map();
    const revisions = await this.prisma.wikiPageRevision.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, editSummaryHidden: true }
    });
    return new Map(revisions.map((revision) => [revision.id, revision.editSummaryHidden]));
  }

  private parseBigIntId(value: string, label: string): bigint {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException(`${label} must be an unsigned integer.`);
    }
    return BigInt(value);
  }

  private parsePositiveInt(value: string, label: string): number {
    if (!/^\d+$/.test(value)) throw new BadRequestException(`${label} must be a positive integer.`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new BadRequestException(`${label} must be a positive integer.`);
    return parsed;
  }

  private parseRecentFilter(value: string | undefined, label: string): string | undefined {
    const normalized = value?.trim();
    if (!normalized) return undefined;
    if (!/^[a-z0-9_-]{1,32}$/i.test(normalized)) throw new BadRequestException(`${label} is invalid.`);
    return normalized;
  }
}

export function buildServerWikiPagePath(serverSlug: string, localPath: string): string {
  return buildCanonicalServerWikiPath(serverSlug, localPath);
}

export function buildServerWikiToolPath(serverSlug: string, localPath: string, tool: string): string {
  return buildCanonicalServerWikiToolPath(serverSlug, localPath, tool);
}

export function serverWikiNavigationDepth(serverSlug: string, localPath: string): number {
  const relativePath = serverWikiRelativePath(serverSlug, localPath);
  return relativePath ? relativePath.split('/').filter(Boolean).length : 0;
}

export function buildServerWikiNavigation(
  serverSlug: string,
  pages: ReadonlyArray<{ id: bigint; title: string; localPath: string; displayTitle: string }>,
  currentPageId: bigint,
  routeSlug = serverSlug,
  routePrefix: '/server' | '/serverWiki' = '/server',
  storedOrder: unknown = null
) {
  return buildServerWikiReleaseNavigation(serverSlug, pages, storedOrder).map((node) => {
    if (node.kind === 'group') {
      return {
        kind: 'group' as const,
        id: node.nodeKey,
        title: node.title,
        path: null,
        current: false,
        depth: node.depth,
        hasChildren: node.hasChildren,
      };
    }
    const item = node.page;
    return {
      kind: 'page' as const,
      id: item.id.toString(),
      title: node.title,
      path: buildCanonicalServerWikiPath(routeSlug, item.title, serverSlug, routePrefix),
      current: item.id === currentPageId,
      depth: node.depth,
      hasChildren: node.hasChildren
    };
  });
}

function projectReadableServerWikiNavigation(
  nodes: ReadonlyArray<{
    readonly nodeKey: string;
    readonly kind: string;
    readonly pageId: bigint | null;
    readonly parentKey: string | null;
    readonly title: string;
    readonly depth: number;
    readonly hasChildren: boolean;
  }>,
  readablePageIds: ReadonlySet<bigint>,
  pathForPage: (pageId: bigint) => string | null,
): ServerWikiNavigationResponse['items'] {
  const nodeByKey = new Map(nodes.map((node) => [node.nodeKey, node]));
  const visibleKeys = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== 'page' || node.pageId === null || !readablePageIds.has(node.pageId)) continue;
    visibleKeys.add(node.nodeKey);
    let parentKey = node.parentKey;
    const visited = new Set<string>();
    while (parentKey && !visited.has(parentKey)) {
      visited.add(parentKey);
      visibleKeys.add(parentKey);
      parentKey = nodeByKey.get(parentKey)?.parentKey ?? null;
    }
  }
  const visibleParentKeys = new Set(nodes
    .filter((node) => visibleKeys.has(node.nodeKey) && node.parentKey && visibleKeys.has(node.parentKey))
    .map((node) => node.parentKey!));
  const projected: Array<ServerWikiNavigationResponse['items'][number]> = [];
  for (const node of nodes) {
    if (!visibleKeys.has(node.nodeKey)) continue;
    if (node.kind === 'group') {
      projected.push({
        kind: 'group' as const,
        id: node.nodeKey,
        title: node.title,
        path: null,
        depth: node.depth,
        hasChildren: visibleParentKeys.has(node.nodeKey),
      });
      continue;
    }
    if (node.kind !== 'page' || node.pageId === null) continue;
    const path = pathForPage(node.pageId);
    if (!path) continue;
    projected.push({
      kind: 'page' as const,
      id: node.pageId.toString(),
      title: node.title,
      path,
      depth: node.depth,
      hasChildren: visibleParentKeys.has(node.nodeKey),
    });
  }
  return projected;
}

function isJsonRecord(value: Prisma.JsonValue | null | undefined): value is Prisma.JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function serverWikiRelativePath(serverSlug: string, localPath: string): string {
  const normalizedSlug = serverSlug.trim().replace(/^\/+|\/+$/g, '');
  const normalizedPath = localPath.trim().replace(/^\/+|\/+$/g, '');
  if (normalizedPath === normalizedSlug) return '';
  return normalizedPath.startsWith(`${normalizedSlug}/`)
    ? normalizedPath.slice(normalizedSlug.length + 1)
    : normalizedPath;
}

function parseServerWikiSitePath(path: string): { siteSlug: string; relativePath: string } | null {
  const match = /^\/serverWiki\/([^/]+)(?:\/(.*))?\/?$/u.exec(path.trim());
  if (!match) return null;
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      throw new BadRequestException('Invalid server wiki path encoding.');
    }
  };
  const siteSlug = decode(match[1] ?? '').trim();
  if (!/^[A-Za-z0-9가-힣][A-Za-z0-9가-힣_-]{1,79}$/u.test(siteSlug)) {
    throw new BadRequestException('Invalid server wiki site slug.');
  }
  const relativePath = (match[2] ?? '')
    .split('/')
    .filter(Boolean)
    .map(decode)
    .join('/');
  if (relativePath.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new BadRequestException('Invalid server wiki path.');
  }
  return { siteSlug, relativePath };
}

function resolveContextualLinkTarget(namespace: string, localPath: string, target: string) {
  const parsed = parseLinkTarget(target);
  if (namespace !== 'server' || parsed.namespace !== 'main' || target.includes(':')) {
    return parsed;
  }
  const [serverSlug] = slugifyTitle(localPath).split('/');
  return {
    namespace: 'server' as const,
    title: `${serverSlug}/${parsed.title}`,
  };
}

function transferLineAttribution<T>(oldLines: readonly string[], oldAttribution: readonly T[], newLines: readonly string[], fallback: T): T[] {
  const next = newLines.map(() => fallback);
  if (oldLines.length === 0 || newLines.length === 0) return next;
  const matches = matchCommonLines(oldLines, newLines);
  for (const [oldIndex, newIndex] of matches) {
    if (oldAttribution[oldIndex] !== undefined) next[newIndex] = oldAttribution[oldIndex]!;
  }
  return next;
}

function categoryTitleFromSlug(slug: string): string {
  return slug.split('/').map((part) => part.replace(/_/g, ' ')).join('/');
}

async function findCurrentSearchMatchIds(
  prisma: PrismaService,
  input: {
    readonly query: string;
    readonly namespaceId: number | null;
    readonly spaceId: bigint | null;
    readonly cursor: { readonly updatedAt: Date; readonly id: bigint } | null;
    readonly limit: number;
  }
): Promise<bigint[]> {
  const booleanQuery = buildWikiSearchBooleanQuery(input.query);
  if (!booleanQuery) return [];
  const where = [
    `p.status IN (${PUBLIC_WIKI_PAGE_STATUS_SQL_LIST})`,
    "r.visibility = 'public'",
    'MATCH(sd.search_vector) AGAINST (? IN BOOLEAN MODE)'
  ];
  const values: unknown[] = [booleanQuery];
  if (input.namespaceId !== null) {
    where.push('p.namespace_id = ?');
    values.push(input.namespaceId);
  }
  if (input.spaceId !== null) {
    where.push('p.space_id = ?');
    values.push(input.spaceId);
  }
  if (input.cursor) {
    where.push('(p.updated_at < ? OR (p.updated_at = ? AND p.id < ?))');
    values.push(input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.id);
  }
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 201);
  const rows = await prisma.$queryRawUnsafe<Array<{ id: bigint | number | string }>>(
    `
      SELECT p.id
      FROM pages AS p
      INNER JOIN wiki_search_documents AS sd
        ON sd.page_id = p.id AND sd.revision_id = p.current_revision_id
      INNER JOIN page_revisions AS r ON r.id = p.current_revision_id AND r.page_id = p.id
      WHERE ${where.join('\n        AND ')}
      ORDER BY p.updated_at DESC, p.id DESC
      LIMIT ${limit}
    `,
    ...values
  );
  return rows.map((row) => BigInt(row.id));
}

async function findReleasedServerWikiSearchMatchIds(
  prisma: PrismaService,
  input: {
    readonly query: string;
    readonly namespaceId: number;
    readonly cursor: { readonly updatedAt: Date; readonly id: bigint } | null;
    readonly limit: number;
  },
): Promise<bigint[]> {
  const booleanQuery = buildWikiSearchBooleanQuery(input.query);
  if (!booleanQuery) return [];
  const cursorSql = input.cursor
    ? 'AND (i.page_updated_at < ? OR (i.page_updated_at = ? AND i.page_id < ?))'
    : '';
  const values: unknown[] = [input.namespaceId, booleanQuery];
  if (input.cursor) values.push(input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.id);
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 201);
  const rows = await prisma.$queryRawUnsafe<Array<{ id: bigint | number | string }>>(
    `
      SELECT i.id
      FROM server_wiki_release_items AS i
      INNER JOIN server_wikis AS sw
        ON sw.published_release_id = i.release_id
       AND sw.id = i.server_wiki_id
       AND sw.space_id = i.space_id
      WHERE sw.status = 'active'
        AND sw.publication_status = 'published'
        AND i.namespace_id = ?
        AND MATCH(i.search_vector) AGAINST (? IN BOOLEAN MODE)
        ${cursorSql}
      ORDER BY i.page_updated_at DESC, i.page_id DESC
      LIMIT ${limit}
    `,
    ...values,
  );
  return rows.map((row) => BigInt(row.id));
}

export function encodeWikiSearchCursor(updatedAt: Date, id: bigint): string {
  return `${updatedAt.toISOString()}_${id.toString()}`;
}

export function parseWikiSearchCursor(value: string | undefined): { updatedAt: Date; id: bigint } | null {
  if (!value) return null;
  const separator = value.lastIndexOf('_');
  if (separator <= 0) throw new BadRequestException('cursor is invalid.');
  const updatedAt = new Date(value.slice(0, separator));
  const rawId = value.slice(separator + 1);
  if (Number.isNaN(updatedAt.getTime()) || !/^\d+$/.test(rawId)) throw new BadRequestException('cursor is invalid.');
  return { updatedAt, id: BigInt(rawId) };
}

function randomBigIntBetween(minimum: bigint, maximum: bigint): bigint {
  const span = maximum - minimum + 1n;
  if (span <= 1n) return minimum;
  return minimum + (randomBytes(8).readBigUInt64BE() % span);
}

type IndexedSpecialType = 'old' | 'long' | 'short' | 'uncategorized';
type IndexedSpecialCursor = Extract<WikiSpecialCursorPosition, { readonly kind: 'indexed' }>;

function specialCursorViewerScope(access: WikiAccessContext): string {
  if (access.actor?.profileId) return `profile:${access.actor.profileId.toString()}`;
  if (access.accountId) return `account:${access.accountId}`;
  return 'anonymous';
}

function indexedSpecialOrder(type: IndexedSpecialType): Prisma.WikiPageOrderByWithRelationInput[] {
  if (type === 'old') return [{ updatedAt: 'asc' }, { id: 'asc' }];
  if (type === 'long') return [{ currentContentSize: 'desc' }, { id: 'desc' }];
  if (type === 'short') return [{ currentContentSize: 'asc' }, { id: 'asc' }];
  return [{ updatedAt: 'desc' }, { id: 'desc' }];
}

function indexedSpecialPosition(
  type: IndexedSpecialType,
  snapshotAt: Date,
  page: Pick<WikiPage, 'id' | 'updatedAt' | 'currentContentSize'>,
): IndexedSpecialCursor {
  return {
    kind: 'indexed',
    snapshotAt: snapshotAt.toISOString(),
    sortValue: type === 'long' || type === 'short'
      ? String(page.currentContentSize)
      : page.updatedAt.toISOString(),
    pageId: page.id.toString(),
  };
}

function indexedSpecialWhere(
  base: Prisma.WikiPageWhereInput,
  type: IndexedSpecialType,
  snapshotAt: Date,
  cursor: IndexedSpecialCursor | null,
): Prisma.WikiPageWhereInput {
  const afterCursor: Prisma.WikiPageWhereInput | null = cursor
    ? indexedSpecialAfterCursor(type, cursor)
    : null;
  return {
    ...base,
    AND: [
      { updatedAt: { lte: snapshotAt } },
      ...(afterCursor ? [afterCursor] : []),
    ],
  };
}

function indexedSpecialAfterCursor(
  type: IndexedSpecialType,
  cursor: IndexedSpecialCursor,
): Prisma.WikiPageWhereInput {
  const pageId = BigInt(cursor.pageId);
  if (type === 'long' || type === 'short') {
    const size = Number(cursor.sortValue);
    return type === 'long'
      ? { OR: [{ currentContentSize: { lt: size } }, { currentContentSize: size, id: { lt: pageId } }] }
      : { OR: [{ currentContentSize: { gt: size } }, { currentContentSize: size, id: { gt: pageId } }] };
  }
  const updatedAt = new Date(cursor.sortValue);
  return type === 'old'
    ? { OR: [{ updatedAt: { gt: updatedAt } }, { updatedAt, id: { gt: pageId } }] }
    : { OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: pageId } }] };
}

function encodeDeletedPageCursor(page: { readonly updatedAt: Date; readonly id: bigint }): string {
  return Buffer.from(JSON.stringify([page.updatedAt.toISOString(), page.id.toString()]), 'utf8').toString('base64url');
}

function decodeDeletedPageCursor(value: string): { readonly updatedAt: Date; readonly id: bigint } {
  if (!/^[A-Za-z0-9_-]{8,256}$/u.test(value)) throw new BadRequestException('Invalid deleted page cursor.');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string' || !/^\d+$/u.test(parsed[1])) {
      throw new Error('invalid cursor');
    }
    const updatedAt = new Date(parsed[0]);
    if (!Number.isFinite(updatedAt.getTime()) || updatedAt.toISOString() !== parsed[0]) throw new Error('invalid cursor');
    return { updatedAt, id: BigInt(parsed[1]) };
  } catch {
    throw new BadRequestException('Invalid deleted page cursor.');
  }
}

const SPECIAL_SNAPSHOT_SOURCE_CONTRIBUTION_LIMIT = 50_000;

function parseSpecialSnapshotItems(value: unknown): ParsedWikiSpecialSnapshotItem[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (envelope.projectionVersion !== 2 || !Array.isArray(envelope.items) || envelope.items.length > 50_000) return null;
  const items: ParsedWikiSpecialSnapshotItem[] = [];
  for (const candidate of envelope.items) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const pageId = item.pageId === null ? null : typeof item.pageId === 'string' && /^\d+$/.test(item.pageId) ? item.pageId : undefined;
    const valueNumber = item.value === null ? null : typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : undefined;
    const updatedAt = item.updatedAt === null ? null : typeof item.updatedAt === 'string' ? item.updatedAt : undefined;
    if (
      typeof item.id !== 'string' ||
      pageId === undefined ||
      typeof item.namespace !== 'string' ||
      typeof item.title !== 'string' ||
      typeof item.displayTitle !== 'string' ||
      typeof item.routePath !== 'string' ||
      !item.routePath.startsWith('/') ||
      valueNumber === undefined ||
      updatedAt === undefined
    ) continue;
    const rawSourceContributions = item.sourceContributions;
    const sourceContributions: Array<{ pageId: string; count: number }> = [];
    let validSourceContributions = Array.isArray(rawSourceContributions) &&
      rawSourceContributions.length <= SPECIAL_SNAPSHOT_SOURCE_CONTRIBUTION_LIMIT;
    if (Array.isArray(rawSourceContributions) && validSourceContributions) {
      const seenPageIds = new Set<string>();
      for (const rawContribution of rawSourceContributions) {
        if (!rawContribution || typeof rawContribution !== 'object' || Array.isArray(rawContribution)) {
          validSourceContributions = false;
          break;
        }
        const contribution = rawContribution as Record<string, unknown>;
        if (
          typeof contribution.pageId !== 'string' ||
          !/^\d+$/.test(contribution.pageId) ||
          seenPageIds.has(contribution.pageId) ||
          typeof contribution.count !== 'number' ||
          !Number.isSafeInteger(contribution.count) ||
          contribution.count < 1
        ) {
          validSourceContributions = false;
          break;
        }
        seenPageIds.add(contribution.pageId);
        sourceContributions.push({ pageId: contribution.pageId, count: contribution.count });
      }
    }
    const sourceContributionTotal = sourceContributions.reduce((total, contribution) => total + contribution.count, 0);
    const sourceContributionsComplete = item.sourceContributionsComplete === true &&
      validSourceContributions &&
      valueNumber !== null &&
      sourceContributionTotal === valueNumber;
    items.push({
      id: item.id,
      pageId,
      namespace: item.namespace,
      title: item.title,
      displayTitle: item.displayTitle,
      routePath: item.routePath,
      value: valueNumber,
      updatedAt,
      sourceContributions,
      sourceContributionsComplete
    });
  }
  return items;
}

function publicSpecialSnapshotItem(
  item: ParsedWikiSpecialSnapshotItem,
  value: number | null = item.value
): WikiSpecialDocumentItem {
  return {
    id: item.id,
    pageId: item.pageId,
    namespace: item.namespace,
    title: item.title,
    displayTitle: item.displayTitle,
    routePath: item.routePath,
    value,
    updatedAt: item.updatedAt
  };
}

export function makeSearchSnippet(content: string, query: string, displayTitle?: string): string {
  const source = content
    .replace(/!\[([^\]]*)\]\(<[^>\r\n]*>\)/gu, ' $1 ')
    .replace(/\[([^\]]+)\]\(<[^>\r\n]*>\)/gu, ' $1 ');
  let normalizedContent = decodeSearchSnippetEntities(parseMarkup(source, { gitBookMarkdown: true }).plainText)
    .replace(/(^|\s)={1,6}\s*([^=]+?)\s*={1,6}(?=\s|$)/gu, '$1$2 ')
    .replace(/(^|\s)#{1,6}\s+/gu, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, ' $1 ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, ' $1 ')
    .replace(/(?:\([^()\r\n]*\)\s*)+\.(?:avif|gif|jpe?g|png|svg|webp)>?\)?/giu, ' ')
    .replace(/(?:\([^()\r\n]*\)\s*)*\([^()\r\n]*\.(?:avif|gif|jpe?g|png|svg|webp)>?\)/giu, ' ')
    .replace(/(^|\s)[>*+-]\s+/gu, '$1')
    .replace(/[*_~`]+/gu, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!>])/gu, '$1')
    .replace(/\\+(?=\s|$)/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const normalizedTitle = displayTitle?.replace(/\s+/g, ' ').trim();
  if (normalizedTitle && normalizedContent.toLocaleLowerCase('ko-KR').startsWith(normalizedTitle.toLocaleLowerCase('ko-KR'))) {
    normalizedContent = normalizedContent.slice(normalizedTitle.length).replace(/^[\s:|·-]+/u, '');
  }
  const index = normalizedContent.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) {
    return normalizedContent.slice(0, 160);
  }
  const start = Math.max(index - 60, 0);
  const end = Math.min(index + query.length + 100, normalizedContent.length);
  return `${start > 0 ? '...' : ''}${normalizedContent.slice(start, end)}${end < normalizedContent.length ? '...' : ''}`;
}

function decodeSearchSnippetEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"'
  };
  return value.replace(/&(?:#(x[0-9a-f]+|\d+)|([a-z]+));/giu, (match, numeric: string | undefined, name: string | undefined) => {
    if (name) return named[name.toLocaleLowerCase()] ?? match;
    const codePoint = numeric?.toLocaleLowerCase().startsWith('x')
      ? Number.parseInt(numeric.slice(1), 16)
      : Number.parseInt(numeric ?? '', 10);
    return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : match;
  });
}

function wikiSearchTextMatches(value: string, query: string): boolean {
  return value.normalize('NFKC').toLocaleLowerCase('ko-KR')
    .includes(query.normalize('NFKC').toLocaleLowerCase('ko-KR'));
}

function findSearchHighlights(value: string, query: string): Array<readonly [number, number]> {
  const normalizedValue = value.toLocaleLowerCase('ko-KR');
  const normalizedQuery = query.toLocaleLowerCase('ko-KR');
  if (!normalizedQuery) return [];
  const ranges: Array<readonly [number, number]> = [];
  let offset = 0;
  while (ranges.length < 20) {
    const index = normalizedValue.indexOf(normalizedQuery, offset);
    if (index < 0) break;
    ranges.push([index, query.length]);
    offset = index + Math.max(query.length, 1);
  }
  return ranges;
}

const ALL_BACKLINK_TYPES: readonly WikiBacklinkType[] = ['link', 'file', 'include', 'redirect'];

function parseBacklinkTypes(value: string | undefined): WikiBacklinkType[] {
  if (!value?.trim()) return [...ALL_BACKLINK_TYPES];
  const requested = [...new Set(value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (requested.length === 0 || requested.some((item) => !ALL_BACKLINK_TYPES.includes(item as WikiBacklinkType))) {
    throw new BadRequestException('types must contain only link, file, include, or redirect.');
  }
  return requested as WikiBacklinkType[];
}

function parseBacklinkNamespace(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(normalized)) {
    throw new BadRequestException('namespace is invalid.');
  }
  return normalized;
}

function countBacklinks<T extends string>(values: readonly T[]): Array<{ readonly key: T; readonly count: number }> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

type BacklinkSortEntry = {
  readonly source: {
    readonly id: bigint;
    readonly title: string;
    readonly displayTitle: string;
  };
};

type DerivedPageProjectionSource =
  | { readonly kind: 'current' }
  | {
      readonly kind: 'release';
      readonly releaseId: bigint;
      readonly serverWikiId: bigint;
      readonly spaceId: bigint;
      readonly publishedAt: Date | null;
    };

type BacklinkCursor = {
  readonly direction: 'prev' | 'next';
  readonly key: string;
  readonly id: bigint;
};

function backlinkTitleKey(entry: BacklinkSortEntry): string {
  return (entry.source.displayTitle || entry.source.title).normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/g, ' ').trim();
}

function compareBacklinkEntries(left: BacklinkSortEntry, right: BacklinkSortEntry): number {
  const titleOrder = backlinkTitleKey(left).localeCompare(backlinkTitleKey(right), 'ko-KR');
  if (titleOrder !== 0) return titleOrder;
  return left.source.id < right.source.id ? -1 : left.source.id > right.source.id ? 1 : 0;
}

function compareBacklinkEntryToCursor(entry: BacklinkSortEntry, cursor: BacklinkCursor): number {
  const titleOrder = backlinkTitleKey(entry).localeCompare(cursor.key, 'ko-KR');
  if (titleOrder !== 0) return titleOrder;
  return entry.source.id < cursor.id ? -1 : entry.source.id > cursor.id ? 1 : 0;
}

function backlinkFilterSignature(namespace: string | null, types: readonly WikiBacklinkType[]): string {
  return `${namespace ?? ''}|${[...types].sort().join(',')}`;
}

function encodeBacklinkCursor(direction: 'prev' | 'next', entry: BacklinkSortEntry, namespace: string | null, types: readonly WikiBacklinkType[]): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    d: direction,
    k: backlinkTitleKey(entry),
    i: entry.source.id.toString(),
    f: backlinkFilterSignature(namespace, types)
  })).toString('base64url');
}

function parseBacklinkCursor(value: string | undefined, namespace: string | null, types: readonly WikiBacklinkType[]): BacklinkCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      parsed.v !== 1 ||
      (parsed.d !== 'prev' && parsed.d !== 'next') ||
      typeof parsed.k !== 'string' || parsed.k.length > 512 ||
      typeof parsed.i !== 'string' || !/^\d+$/.test(parsed.i) ||
      parsed.f !== backlinkFilterSignature(namespace, types)
    ) throw new Error('invalid');
    return { direction: parsed.d, key: parsed.k, id: BigInt(parsed.i) };
  } catch {
    throw new BadRequestException('cursor is invalid for the selected backlink filters.');
  }
}

type CategorySortPage = {
  readonly id: bigint;
  readonly updatedAt: Date;
};

type CategoryCursor = {
  readonly updatedAt: number;
  readonly pageId: bigint;
};

function compareCategoryPages(left: CategorySortPage, right: CategorySortPage): number {
  const updatedOrder = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (updatedOrder !== 0) return updatedOrder;
  return left.id > right.id ? -1 : left.id < right.id ? 1 : 0;
}

function compareCategoryPageToCursor(page: CategorySortPage, cursor: CategoryCursor): number {
  const updatedOrder = cursor.updatedAt - page.updatedAt.getTime();
  if (updatedOrder !== 0) return updatedOrder;
  return page.id > cursor.pageId ? -1 : page.id < cursor.pageId ? 1 : 0;
}

function categoryCursorFilter(categorySlug: string, namespace: string | null, projectionSignature: string): string {
  return `${categorySlug}|${namespace ?? ''}|${projectionSignature}`;
}

function encodeCategoryCursor(
  page: CategorySortPage,
  categorySlug: string,
  namespace: string | null,
  projectionSignature: string,
): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    t: page.updatedAt.getTime(),
    i: page.id.toString(),
    f: categoryCursorFilter(categorySlug, namespace, projectionSignature),
  })).toString('base64url');
}

function parseCategoryCursor(
  value: string | undefined,
  categorySlug: string,
  namespace: string | null,
  projectionSignature: string,
): CategoryCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      parsed.v !== 1
      || typeof parsed.t !== 'number' || !Number.isSafeInteger(parsed.t) || parsed.t < 0
      || typeof parsed.i !== 'string' || !/^\d+$/.test(parsed.i)
      || parsed.f !== categoryCursorFilter(categorySlug, namespace, projectionSignature)
    ) throw new Error('invalid');
    return { updatedAt: parsed.t, pageId: BigInt(parsed.i) };
  } catch {
    throw new BadRequestException('cursor is invalid for the selected category filters or publication state.');
  }
}

function normalizeWikiDirectoryTags(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter((item) => item.length > 0);
}

function safeWikiDirectoryUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

import { Body, Controller, Get, Header, Optional, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { CurrentSession } from '../session/session.decorator';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import {
  WikiEditService,
  type WikiMoveRequest,
  type WikiMoveResponse,
  type WikiMutationResponse,
  type WikiCreateContextResponse,
  type WikiPageMutationRequest,
  type WikiPreviewResponse,
  type WikiRevertRequest,
  type WikiRevisionDiffResponse,
  type WikiRevisionResponse,
  type WikiSectionMutationRequest,
  type WikiSectionEditResponse,
  type WikiSectionMutationResponse,
  type WikiStatusMutationRequest,
  type WikiStatusMutationResponse
} from './wiki-edit.service';
import {
  WikiReadService,
  type WikiBlameResponse,
  type WikiBacklinkResponse,
  type WikiCategoryResponse,
  type WikiDocumentTemplateSummary,
  type WikiContributionResponse,
  type WikiDeletedPageListResponse,
  type WikiDeletedPageRecoveryResponse,
  type WikiPageResponse,
  type WikiPageLifecycleEventListResponse,
  type WikiPageAclHistoryEventListResponse,
  type WikiRecentChangeListResponse,
  type WikiRevisionListResponse,
  type WikiRenderedRevisionResponse,
  type WikiSearchResponse,
  type WikiSearchSuggestionResponse,
  type WikiPublicStatsResponse,
  type WikiSpecialDocumentResponse,
  type WikiPublicBlockHistoryResponse
} from './wiki-read.service';
import { WikiProfileService, type WikiMeResponse, type WikiPublicProfileResponse } from './wiki-profile.service';
import { WikiCaptchaService } from './wiki-captcha.service';
import {
  WikiPageSwapService,
  type WikiPageSwapCandidateResponse,
  type WikiPageSwapRequest,
  type WikiPageSwapResponse,
} from './wiki-page-swap.service';
import {
  WikiUsernameService,
  type WikiUsernameChangeRequest,
  type WikiUsernameChangeResponse,
  type WikiUsernameStateResponse,
} from './wiki-username.service';

@Controller('v1/wiki')
export class WikiController {
  constructor(
    private readonly wikiProfiles: WikiProfileService,
    private readonly wikiRead: WikiReadService,
    private readonly wikiEdit: WikiEditService,
    private readonly wikiCaptcha: WikiCaptchaService,
    private readonly wikiPageSwap: WikiPageSwapService,
    @Optional() private readonly wikiUsernames?: WikiUsernameService,
  ) {}

  @Get('stats')
  @Throttle({ default: { limit: 60, ttl: 60 } })
  getPublicStats(@Query('namespace') namespace?: string): Promise<WikiPublicStatsResponse> {
    return this.wikiRead.getPublicStats(namespace);
  }

  @Get('page')
  @UseGuards(OptionalSessionGuard)
  getPage(
    @Query('namespace') namespace = 'main',
    @Query('title') title = '대문',
    @Req() request: FastifyRequest,
    @Query('redirect') redirect?: string,
    @Query('noRedirect') noRedirect?: string
  ): Promise<WikiPageResponse> {
    return this.wikiRead.getPage(namespace, title, request.sessionPayload ?? null, {
      followRedirects: shouldFollowRedirects(redirect, noRedirect)
    });
  }

  @Get('create-context')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 30, ttl: 60 } })
  getCreateContext(
    @CurrentSession() session: SessionPayload,
    @Query('namespace') namespace?: string,
    @Query('title') title?: string,
    @Query('spaceId') spaceId?: string
  ): Promise<WikiCreateContextResponse> {
    return this.wikiEdit.getCreateContext(session, { namespace, title, spaceId });
  }

  @Get('page/by-path')
  @UseGuards(OptionalSessionGuard)
  getPageByPath(
    @Query('path') path = '/wiki/대문',
    @Req() request: FastifyRequest,
    @Query('redirect') redirect?: string,
    @Query('noRedirect') noRedirect?: string
  ): Promise<WikiPageResponse> {
    return this.wikiRead.getPageByPath(path, request.sessionPayload ?? null, {
      followRedirects: shouldFollowRedirects(redirect, noRedirect)
    });
  }

  @Get('page/:id/revisions')
  @UseGuards(OptionalSessionGuard)
  getRevisions(@Param('id') pageId: string, @Req() request: FastifyRequest, @Query('cursor') cursor?: string, @Query('limit') limit?: string): Promise<WikiRevisionListResponse> {
    return this.wikiRead.getRevisions(pageId, request.sessionPayload ?? null, cursor, limit);
  }

  @Get('pages/:id/revisions')
  @UseGuards(OptionalSessionGuard)
  getPageRevisions(@Param('id') pageId: string, @Req() request: FastifyRequest, @Query('cursor') cursor?: string, @Query('limit') limit?: string): Promise<WikiRevisionListResponse> {
    return this.wikiRead.getRevisions(pageId, request.sessionPayload ?? null, cursor, limit);
  }

  @Get('pages/:id/lifecycle')
  @UseGuards(OptionalSessionGuard)
  getPageLifecycleEvents(
    @Param('id') pageId: string,
    @Req() request: FastifyRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ): Promise<WikiPageLifecycleEventListResponse> {
    return this.wikiRead.getPageLifecycleEvents(pageId, request.sessionPayload ?? null, cursor, limit);
  }

  @Get('pages/:id/acl-history')
  @UseGuards(OptionalSessionGuard)
  getPageAclHistoryEvents(
    @Param('id') pageId: string,
    @Req() request: FastifyRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ): Promise<WikiPageAclHistoryEventListResponse> {
    return this.wikiRead.getPageAclHistoryEvents(pageId, request.sessionPayload ?? null, cursor, limit);
  }

  @Get('pages/:id/raw')
  @UseGuards(OptionalSessionGuard)
  getPageRaw(
    @Param('id') pageId: string,
    @Req() request: FastifyRequest,
    @Query('revisionId') revisionId?: string
  ): Promise<WikiRevisionResponse> {
    return this.wikiEdit.getRawPage(pageId, request.sessionPayload ?? null, revisionId);
  }

  @Get('pages/:id/backlinks')
  @UseGuards(OptionalSessionGuard)
  getBacklinks(
    @Param('id') pageId: string,
    @Req() request: FastifyRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('types') types?: string,
    @Query('namespace') namespace?: string
  ): Promise<WikiBacklinkResponse> {
    return this.wikiRead.getBacklinks({
      pageId,
      viewer: request.sessionPayload ?? null,
      cursor,
      limit,
      types,
      namespace
    });
  }

  @Get('pages/:id/blame')
  @UseGuards(OptionalSessionGuard)
  getBlame(@Param('id') pageId: string, @Req() request: FastifyRequest): Promise<WikiBlameResponse> {
    return this.wikiRead.getBlame(pageId, request.sessionPayload ?? null);
  }

  @Get('recent')
  @UseGuards(OptionalSessionGuard)
  getRecent(
    @Req() request: FastifyRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('changeType') changeType?: string,
    @Query('namespace') namespace?: string,
    @Query('minor') minor?: string
  ): Promise<WikiRecentChangeListResponse> {
    return this.wikiRead.getRecent({ viewer: request.sessionPayload ?? null, cursor, limit, changeType, namespace, minor });
  }

  @Get('contributions/:profileId')
  @UseGuards(OptionalSessionGuard)
  getContributions(
    @Param('profileId') profileId: string,
    @Req() request: FastifyRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('activity') activity?: string
  ): Promise<WikiContributionResponse> {
    return this.wikiRead.getContributions({
      profileId,
      accountId: request.sessionPayload?.userId ?? null,
      session: request.sessionPayload ?? null,
      cursor,
      limit,
      activity
    });
  }

  @Get('profiles/:username')
  @UseGuards(OptionalSessionGuard)
  getPublicProfile(
    @Param('username') username: string,
    @Req() request: FastifyRequest
  ): Promise<WikiPublicProfileResponse> {
    return this.wikiProfiles.getPublicProfile(username, request.sessionPayload?.userId ?? null);
  }

  @Get('search')
  @UseGuards(OptionalSessionGuard)
  @Throttle({ default: { limit: 30, ttl: 60 } })
  search(
    @Req() request: FastifyRequest,
    @Query('q') q: string | undefined,
    @Query('namespace') namespace: string | undefined,
    @Query('serverSlug') serverSlug: string | undefined,
    @Query('target') target: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('cursor') cursor: string | undefined
  ): Promise<WikiSearchResponse> {
    return this.wikiRead.search({
      q,
      namespace,
      serverSlug,
      target,
      limit,
      cursor,
      viewer: request.sessionPayload ?? null
    });
  }

  @Get('search/suggest')
  @UseGuards(OptionalSessionGuard)
  @Throttle({ default: { limit: 60, ttl: 60 } })
  suggest(
    @Req() request: FastifyRequest,
    @Query('q') q: string | undefined,
    @Query('limit') limit: string | undefined
  ): Promise<WikiSearchSuggestionResponse> {
    return this.wikiRead.suggest({ q, limit, viewer: request.sessionPayload ?? null });
  }

  @Get('special')
  @UseGuards(OptionalSessionGuard)
  @Throttle({ default: { limit: 20, ttl: 60 } })
  special(
    @Req() request: FastifyRequest,
    @Query('type') type?: string,
    @Query('namespace') namespace?: string,
    @Query('limit') limit?: string
  ): Promise<WikiSpecialDocumentResponse> {
    return this.wikiRead.getSpecialDocuments({ type, namespace, limit, viewer: request.sessionPayload ?? null });
  }

  @Get('block-history')
  @Throttle({ default: { limit: 30, ttl: 60 } })
  blockHistory(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
    @Query('q') query?: string
  ): Promise<WikiPublicBlockHistoryResponse> {
    return this.wikiRead.getPublicBlockHistory({ cursor, limit, action, query });
  }

  @Get('categories/:category')
  @UseGuards(OptionalSessionGuard)
  categoryMembers(
    @Param('category') category: string,
    @Req() request: FastifyRequest,
    @Query('namespace') namespace?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ): Promise<WikiCategoryResponse> {
    return this.wikiRead.getCategoryMembers({ category, namespace, cursor, limit, viewer: request.sessionPayload ?? null });
  }

  @Get('categories')
  @UseGuards(OptionalSessionGuard)
  categoryMembersByQuery(
    @Query('category') category: string | undefined,
    @Req() request: FastifyRequest,
    @Query('namespace') namespace?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ): Promise<WikiCategoryResponse> {
    return this.wikiRead.getCategoryMembers({ category: category ?? '', namespace, cursor, limit, viewer: request.sessionPayload ?? null });
  }

  @Get('templates')
  @UseGuards(OptionalSessionGuard)
  templates(
    @Req() request: FastifyRequest,
    @Query('pageId') pageId?: string,
    @Query('spaceId') spaceId?: string
  ): Promise<WikiDocumentTemplateSummary[]> {
    return this.wikiRead.getDocumentTemplates({ pageId, spaceId, viewer: request.sessionPayload ?? null });
  }

  @Get('revisions/:revisionId')
  @UseGuards(OptionalSessionGuard)
  getRevision(
    @Param('revisionId') revisionId: string,
    @Req() request: FastifyRequest
  ): Promise<WikiRevisionResponse> {
    return this.wikiEdit.getRevision(revisionId, request.sessionPayload ?? null);
  }

  @Get('revisions/:revisionId/rendered')
  @UseGuards(OptionalSessionGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Cookie, Authorization')
  getRenderedRevision(
    @Param('revisionId') revisionId: string,
    @Req() request: FastifyRequest
  ): Promise<WikiRenderedRevisionResponse> {
    return this.wikiRead.getRenderedRevision(revisionId, request.sessionPayload ?? null);
  }

  @Get('revisions/:leftId/diff/:rightId')
  @UseGuards(OptionalSessionGuard)
  getRevisionDiff(
    @Param('leftId') leftId: string,
    @Param('rightId') rightId: string,
    @Req() request: FastifyRequest
  ): Promise<WikiRevisionDiffResponse> {
    return this.wikiEdit.getRevisionDiff(leftId, rightId, request.sessionPayload ?? null);
  }

  @Post('preview')
  @Throttle({ default: { limit: 30, ttl: 60 } })
  @UseGuards(SessionGuard)
  previewPage(
    @Body() body: { contentRaw?: string; pageId?: string; namespace?: string; localPath?: string },
    @CurrentSession() session: SessionPayload,
  ): Promise<WikiPreviewResponse> {
    return this.wikiEdit.preview(body.contentRaw, {
      pageId: body.pageId,
      namespace: body.namespace,
      localPath: body.localPath,
    }, session);
  }

  @Post('pages')
  @Throttle({ default: { limit: 8, ttl: 60 } })
  @UseGuards(SessionGuard)
  async createPage(
    @Body() body: WikiPageMutationRequest & { readonly captchaToken?: string },
    @CurrentSession() session: SessionPayload,
    @Req() request: FastifyRequest
  ): Promise<WikiMutationResponse> {
    await this.wikiCaptcha.assertVerified(body.captchaToken, request.clientIp ?? session.requestIp);
    const mutation = { ...body };
    delete mutation.captchaToken;
    return this.wikiEdit.createPage(session, mutation);
  }

  @Patch('pages/:id')
  @Throttle({ default: { limit: 12, ttl: 60 } })
  @UseGuards(SessionGuard)
  updatePage(
    @Param('id') pageId: string,
    @Body() body: WikiPageMutationRequest,
    @CurrentSession() session: SessionPayload
  ): Promise<WikiMutationResponse> {
    return this.wikiEdit.updatePage(session, pageId, body);
  }

  @Post('pages/:id/move')
  @Throttle({ default: { limit: 6, ttl: 60 } })
  @UseGuards(SessionGuard)
  movePage(
    @Param('id') pageId: string,
    @Body() body: WikiMoveRequest,
    @CurrentSession() session: SessionPayload
  ): Promise<WikiMoveResponse> {
    return this.wikiEdit.movePage(session, pageId, body);
  }

  @Get('pages/:id/swap-candidates')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  @UseGuards(SessionGuard)
  getPageSwapCandidates(
    @Param('id') pageId: string,
    @Query('q') query: string | undefined,
    @CurrentSession() session: SessionPayload,
  ): Promise<WikiPageSwapCandidateResponse> {
    return this.wikiPageSwap.listCandidates(session, pageId, query);
  }

  @Post('pages/:id/swap')
  @Throttle({ default: { limit: 6, ttl: 60 } })
  @UseGuards(SessionGuard)
  swapPage(
    @Param('id') pageId: string,
    @Body() body: WikiPageSwapRequest,
    @CurrentSession() session: SessionPayload,
  ): Promise<WikiPageSwapResponse> {
    return this.wikiPageSwap.swap(session, pageId, body);
  }

  @Post('pages/:id/delete')
  @Throttle({ default: { limit: 6, ttl: 60 } })
  @UseGuards(SessionGuard)
  deletePage(
    @Param('id') pageId: string,
    @Body() body: WikiStatusMutationRequest,
    @CurrentSession() session: SessionPayload
  ): Promise<WikiStatusMutationResponse> {
    return this.wikiEdit.deletePage(session, pageId, body);
  }

  @Post('pages/:id/restore')
  @Throttle({ default: { limit: 6, ttl: 60 } })
  @UseGuards(SessionGuard)
  restorePage(
    @Param('id') pageId: string,
    @Body() body: WikiStatusMutationRequest,
    @CurrentSession() session: SessionPayload
  ): Promise<WikiStatusMutationResponse> {
    return this.wikiEdit.restorePage(session, pageId, body);
  }

  @Post('pages/:id/revert')
  @Throttle({ default: { limit: 6, ttl: 60 } })
  @UseGuards(SessionGuard)
  revertPage(
    @Param('id') pageId: string,
    @Body() body: WikiRevertRequest,
    @CurrentSession() session: SessionPayload
  ): Promise<WikiMutationResponse> {
    return this.wikiEdit.revertPage(session, pageId, body);
  }

  @Post('pages/:id/sections')
  @Throttle({ default: { limit: 12, ttl: 60 } })
  @UseGuards(SessionGuard)
  appendSection(
    @Param('id') pageId: string,
    @Body() body: WikiSectionMutationRequest,
    @CurrentSession() session: SessionPayload
  ): Promise<WikiMutationResponse> {
    return this.wikiEdit.appendSection(session, pageId, body);
  }

  @Get('pages/:id/sections/:anchor')
  @UseGuards(SessionGuard)
  getSectionForEdit(
    @Param('id') pageId: string,
    @Param('anchor') anchor: string,
    @CurrentSession() session: SessionPayload
  ): Promise<WikiSectionEditResponse> {
    return this.wikiEdit.getSectionForEdit(session, pageId, anchor);
  }

  @Patch('pages/:id/sections/:anchor')
  @Throttle({ default: { limit: 12, ttl: 60 } })
  @UseGuards(SessionGuard)
  updateSection(
    @Param('id') pageId: string,
    @Param('anchor') anchor: string,
    @Body() body: WikiPageMutationRequest,
    @CurrentSession() session: SessionPayload
  ): Promise<WikiSectionMutationResponse> {
    return this.wikiEdit.updateSection(session, pageId, anchor, body);
  }

  @Get('me')
  @UseGuards(SessionGuard)
  getMe(@CurrentSession() session: SessionPayload): Promise<WikiMeResponse> {
    return this.wikiProfiles.getMe(session.userId);
  }

  @Get('me/username')
  @UseGuards(SessionGuard)
  getMyUsername(@CurrentSession() session: SessionPayload): Promise<WikiUsernameStateResponse> {
    if (!this.wikiUsernames) throw new Error('Wiki username service is unavailable.');
    return this.wikiUsernames.getState(session);
  }

  @Post('me/username')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 5, ttl: 300 } })
  changeMyUsername(
    @CurrentSession() session: SessionPayload,
    @Body() body: WikiUsernameChangeRequest,
  ): Promise<WikiUsernameChangeResponse> {
    if (!this.wikiUsernames) throw new Error('Wiki username service is unavailable.');
    return this.wikiUsernames.change(session, body);
  }

  @Get('me/deleted-pages')
  @UseGuards(SessionGuard)
  async getMyDeletedPages(
    @CurrentSession() session: SessionPayload,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ): Promise<WikiDeletedPageListResponse> {
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    return this.wikiRead.getDeletedPages({
      accountId: session.userId,
      profileId: profile.id,
      includeAll: session.permissions?.includes('wiki.admin') === true || session.groups?.includes('admin') === true,
      cursor,
      limit
    });
  }

  @Get('me/deleted-pages/:id/recovery')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 30, ttl: 60 } })
  getDeletedPageRecovery(
    @Param('id') pageId: string,
    @CurrentSession() session: SessionPayload,
    @Query('revisionId') revisionId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ): Promise<WikiDeletedPageRecoveryResponse> {
    return this.wikiRead.getDeletedPageRecovery({ pageId, viewer: session, revisionId, cursor, limit });
  }
}

function shouldFollowRedirects(redirect?: string, noRedirect?: string): boolean {
  return redirect !== '0' && noRedirect !== '1' && noRedirect !== 'true';
}

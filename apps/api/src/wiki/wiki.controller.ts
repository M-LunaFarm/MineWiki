import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
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
  type WikiPageMutationRequest,
  type WikiPreviewResponse,
  type WikiRevertRequest,
  type WikiRevisionDiffResponse,
  type WikiRevisionResponse,
  type WikiSectionMutationRequest,
  type WikiStatusMutationRequest,
  type WikiStatusMutationResponse
} from './wiki-edit.service';
import {
  WikiReadService,
  type WikiPageResponse,
  type WikiRecentChangeSummary,
  type WikiRevisionSummary,
  type WikiSearchResult
} from './wiki-read.service';
import { WikiProfileService, type WikiMeResponse } from './wiki-profile.service';

@Controller('v1/wiki')
export class WikiController {
  constructor(
    private readonly wikiProfiles: WikiProfileService,
    private readonly wikiRead: WikiReadService,
    private readonly wikiEdit: WikiEditService
  ) {}

  @Get('page')
  @UseGuards(OptionalSessionGuard)
  getPage(
    @Query('namespace') namespace = 'main',
    @Query('title') title = '대문',
    @Req() request: FastifyRequest,
    @Query('redirect') redirect?: string,
    @Query('noRedirect') noRedirect?: string
  ): Promise<WikiPageResponse> {
    return this.wikiRead.getPage(namespace, title, request.sessionPayload?.userId ?? null, {
      followRedirects: shouldFollowRedirects(redirect, noRedirect)
    });
  }

  @Get('page/by-path')
  @UseGuards(OptionalSessionGuard)
  getPageByPath(
    @Query('path') path = '/wiki/대문',
    @Req() request: FastifyRequest,
    @Query('redirect') redirect?: string,
    @Query('noRedirect') noRedirect?: string
  ): Promise<WikiPageResponse> {
    return this.wikiRead.getPageByPath(path, request.sessionPayload?.userId ?? null, {
      followRedirects: shouldFollowRedirects(redirect, noRedirect)
    });
  }

  @Get('page/:id/revisions')
  @UseGuards(OptionalSessionGuard)
  getRevisions(@Param('id') pageId: string, @Req() request: FastifyRequest): Promise<WikiRevisionSummary[]> {
    return this.wikiRead.getRevisions(pageId, request.sessionPayload?.userId ?? null);
  }

  @Get('pages/:id/revisions')
  @UseGuards(OptionalSessionGuard)
  getPageRevisions(@Param('id') pageId: string, @Req() request: FastifyRequest): Promise<WikiRevisionSummary[]> {
    return this.wikiRead.getRevisions(pageId, request.sessionPayload?.userId ?? null);
  }

  @Get('pages/:id/raw')
  @UseGuards(OptionalSessionGuard)
  getPageRaw(
    @Param('id') pageId: string,
    @Req() request: FastifyRequest,
    @Query('revisionId') revisionId?: string
  ): Promise<WikiRevisionResponse> {
    return this.wikiEdit.getRawPage(pageId, request.sessionPayload?.userId ?? null, revisionId);
  }

  @Get('recent')
  @UseGuards(OptionalSessionGuard)
  getRecent(@Req() request: FastifyRequest): Promise<WikiRecentChangeSummary[]> {
    return this.wikiRead.getRecent(request.sessionPayload?.userId ?? null);
  }

  @Get('search')
  @UseGuards(OptionalSessionGuard)
  search(
    @Req() request: FastifyRequest,
    @Query('q') q: string | undefined,
    @Query('namespace') namespace: string | undefined,
    @Query('limit') limit: string | undefined
  ): Promise<WikiSearchResult[]> {
    return this.wikiRead.search({
      q,
      namespace,
      limit,
      accountId: request.sessionPayload?.userId ?? null
    });
  }

  @Get('revisions/:revisionId')
  @UseGuards(OptionalSessionGuard)
  getRevision(
    @Param('revisionId') revisionId: string,
    @Req() request: FastifyRequest
  ): Promise<WikiRevisionResponse> {
    return this.wikiEdit.getRevision(revisionId, request.sessionPayload?.userId ?? null);
  }

  @Get('revisions/:leftId/diff/:rightId')
  @UseGuards(OptionalSessionGuard)
  getRevisionDiff(
    @Param('leftId') leftId: string,
    @Param('rightId') rightId: string,
    @Req() request: FastifyRequest
  ): Promise<WikiRevisionDiffResponse> {
    return this.wikiEdit.getRevisionDiff(leftId, rightId, request.sessionPayload?.userId ?? null);
  }

  @Post('preview')
  @Throttle({ default: { limit: 30, ttl: 60 } })
  @UseGuards(SessionGuard)
  previewPage(@Body() body: { contentRaw?: string }): WikiPreviewResponse {
    return this.wikiEdit.preview(body.contentRaw);
  }

  @Post('pages')
  @Throttle({ default: { limit: 8, ttl: 60 } })
  @UseGuards(SessionGuard)
  createPage(
    @Body() body: WikiPageMutationRequest,
    @CurrentSession() session: SessionPayload
  ): Promise<WikiMutationResponse> {
    return this.wikiEdit.createPage(session, body);
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

  @Get('me')
  @UseGuards(SessionGuard)
  getMe(@CurrentSession() session: SessionPayload): Promise<WikiMeResponse> {
    return this.wikiProfiles.getMe(session.userId);
  }
}

function shouldFollowRedirects(redirect?: string, noRedirect?: string): boolean {
  return redirect !== '0' && noRedirect !== '1' && noRedirect !== 'true';
}

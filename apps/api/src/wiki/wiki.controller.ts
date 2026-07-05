import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CurrentSession } from '../session/session.decorator';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import {
  WikiEditService,
  type WikiMutationResponse,
  type WikiPageMutationRequest,
  type WikiPreviewResponse,
  type WikiRevisionDiffResponse,
  type WikiRevisionResponse,
  type WikiSectionMutationRequest
} from './wiki-edit.service';
import { WikiReadService, type WikiPageResponse, type WikiRevisionSummary } from './wiki-read.service';
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
    @Req() request: FastifyRequest
  ): Promise<WikiPageResponse> {
    return this.wikiRead.getPage(namespace, title, request.sessionPayload?.userId ?? null);
  }

  @Get('page/by-path')
  @UseGuards(OptionalSessionGuard)
  getPageByPath(
    @Query('path') path = '/wiki/대문',
    @Req() request: FastifyRequest
  ): Promise<WikiPageResponse> {
    return this.wikiRead.getPageByPath(path, request.sessionPayload?.userId ?? null);
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
  @UseGuards(SessionGuard)
  previewPage(@Body() body: { contentRaw?: string }): WikiPreviewResponse {
    return this.wikiEdit.preview(body.contentRaw);
  }

  @Post('pages')
  @UseGuards(SessionGuard)
  createPage(
    @Body() body: WikiPageMutationRequest,
    @CurrentSession() session: SessionPayload
  ): Promise<WikiMutationResponse> {
    return this.wikiEdit.createPage(session.userId, body);
  }

  @Patch('pages/:id')
  @UseGuards(SessionGuard)
  updatePage(
    @Param('id') pageId: string,
    @Body() body: WikiPageMutationRequest,
    @CurrentSession() session: SessionPayload
  ): Promise<WikiMutationResponse> {
    return this.wikiEdit.updatePage(session.userId, pageId, body);
  }

  @Post('pages/:id/sections')
  @UseGuards(SessionGuard)
  appendSection(
    @Param('id') pageId: string,
    @Body() body: WikiSectionMutationRequest,
    @CurrentSession() session: SessionPayload
  ): Promise<WikiMutationResponse> {
    return this.wikiEdit.appendSection(session.userId, pageId, body);
  }

  @Get('me')
  @UseGuards(SessionGuard)
  getMe(@CurrentSession() session: SessionPayload): Promise<WikiMeResponse> {
    return this.wikiProfiles.getMe(session.userId);
  }
}

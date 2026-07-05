import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import {
  WikiEditService,
  type WikiMutationResponse,
  type WikiPageMutationRequest,
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
  getPage(
    @Query('namespace') namespace = 'main',
    @Query('title') title = '대문'
  ): Promise<WikiPageResponse> {
    return this.wikiRead.getPage(namespace, title);
  }

  @Get('page/by-path')
  getPageByPath(@Query('path') path = '/wiki/대문'): Promise<WikiPageResponse> {
    return this.wikiRead.getPageByPath(path);
  }

  @Get('page/:id/revisions')
  getRevisions(@Param('id') pageId: string): Promise<WikiRevisionSummary[]> {
    return this.wikiRead.getRevisions(pageId);
  }

  @Get('pages/:id/revisions')
  getPageRevisions(@Param('id') pageId: string): Promise<WikiRevisionSummary[]> {
    return this.wikiRead.getRevisions(pageId);
  }

  @Get('revisions/:revisionId')
  getRevision(@Param('revisionId') revisionId: string): Promise<WikiRevisionResponse> {
    return this.wikiEdit.getRevision(revisionId);
  }

  @Get('revisions/:leftId/diff/:rightId')
  getRevisionDiff(
    @Param('leftId') leftId: string,
    @Param('rightId') rightId: string
  ): Promise<WikiRevisionDiffResponse> {
    return this.wikiEdit.getRevisionDiff(leftId, rightId);
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

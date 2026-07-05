import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { WikiReadService, type WikiPageResponse, type WikiRevisionSummary } from './wiki-read.service';
import { WikiProfileService, type WikiMeResponse } from './wiki-profile.service';

@Controller('v1/wiki')
export class WikiController {
  constructor(
    private readonly wikiProfiles: WikiProfileService,
    private readonly wikiRead: WikiReadService
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

  @Get('me')
  @UseGuards(SessionGuard)
  getMe(@CurrentSession() session: SessionPayload): Promise<WikiMeResponse> {
    return this.wikiProfiles.getMe(session.userId);
  }
}

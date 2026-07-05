import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { WikiProfileService, type WikiMeResponse } from './wiki-profile.service';

@UseGuards(SessionGuard)
@Controller('v1/wiki')
export class WikiController {
  constructor(private readonly wikiProfiles: WikiProfileService) {}

  @Get('me')
  getMe(@CurrentSession() session: SessionPayload): Promise<WikiMeResponse> {
    return this.wikiProfiles.getMe(session.userId);
  }
}

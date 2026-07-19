import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { CurrentSession } from '../session/session.decorator';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import { WikiPageAclService } from './wiki-page-acl.service';

@Controller('v1/wiki/pages/:pageId/acl')
export class WikiPageAclController {
  constructor(private readonly pageAcl: WikiPageAclService) {}

  @Get()
  @UseGuards(OptionalSessionGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Cookie, Authorization')
  getPageAcl(@Param('pageId') pageId: string, @Req() request: FastifyRequest) {
    return this.pageAcl.getPageAcl(pageId, request.sessionPayload ?? null, request.clientIp);
  }

  @Post()
  @RequireStepUp('wiki_admin')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 20, ttl: 60 } })
  createRule(
    @Param('pageId') pageId: string,
    @Body() body: { action?: string; effect?: string; subjectType?: string; subjectValue?: string; reason?: string | null; expiresAt?: string | null },
    @CurrentSession() session: SessionPayload
  ) {
    return this.pageAcl.createRule(pageId, session, body);
  }

  @Delete(':ruleId')
  @RequireStepUp('wiki_admin')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 20, ttl: 60 } })
  deleteRule(
    @Param('pageId') pageId: string,
    @Param('ruleId') ruleId: string,
    @Body() body: { reason?: string | null },
    @CurrentSession() session: SessionPayload
  ) {
    return this.pageAcl.deleteRule(pageId, ruleId, session, body.reason);
  }

  @Patch('order')
  @RequireStepUp('wiki_admin')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 20, ttl: 60 } })
  reorderRules(
    @Param('pageId') pageId: string,
    @Body() body: { action?: string; ruleIds?: readonly string[]; reason?: string | null },
    @CurrentSession() session: SessionPayload
  ) {
    return this.pageAcl.reorderRules(pageId, session, body);
  }
}

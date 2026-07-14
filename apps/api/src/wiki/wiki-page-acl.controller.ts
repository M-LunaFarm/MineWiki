import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { CurrentSession } from '../session/session.decorator';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { WikiPageAclService } from './wiki-page-acl.service';

@Controller('v1/wiki/pages/:pageId/acl')
export class WikiPageAclController {
  constructor(private readonly pageAcl: WikiPageAclService) {}

  @Get()
  @UseGuards(OptionalSessionGuard)
  getPageAcl(@Param('pageId') pageId: string, @Req() request: FastifyRequest) {
    return this.pageAcl.getPageAcl(pageId, request.sessionPayload ?? null);
  }

  @Post()
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

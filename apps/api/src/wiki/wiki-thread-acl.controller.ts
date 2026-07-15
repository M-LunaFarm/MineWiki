import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { CurrentSession } from '../session/session.decorator';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import { WikiThreadAclService } from './wiki-thread-acl.service';

@Controller('v1/wiki/discussions/:threadId/acl')
export class WikiThreadAclController {
  constructor(private readonly threadAcl: WikiThreadAclService) {}

  @Get()
  @UseGuards(OptionalSessionGuard)
  getThreadAcl(@Param('threadId') threadId: string, @Req() request: FastifyRequest) {
    return this.threadAcl.getThreadAcl(threadId, request.sessionPayload ?? null);
  }

  @Post()
  @RequireStepUp('wiki_admin')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 20, ttl: 60 } })
  createRule(
    @Param('threadId') threadId: string,
    @Body() body: {
      action?: string;
      effect?: string;
      subjectType?: string;
      subjectValue?: string;
      reason?: string | null;
      expiresAt?: string | null;
    },
    @CurrentSession() session: SessionPayload
  ) {
    return this.threadAcl.createRule(threadId, session, body);
  }

  @Delete(':ruleId')
  @RequireStepUp('wiki_admin')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 20, ttl: 60 } })
  deleteRule(
    @Param('threadId') threadId: string,
    @Param('ruleId') ruleId: string,
    @Body() body: { reason?: string | null },
    @CurrentSession() session: SessionPayload
  ) {
    return this.threadAcl.deleteRule(threadId, ruleId, session, body.reason);
  }

  @Patch('order')
  @RequireStepUp('wiki_admin')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 20, ttl: 60 } })
  reorderRules(
    @Param('threadId') threadId: string,
    @Body() body: {
      action?: string;
      ruleIds?: readonly string[];
      expectedRuleSetHash?: string;
      reason?: string | null;
    },
    @CurrentSession() session: SessionPayload
  ) {
    return this.threadAcl.reorderRules(threadId, session, body);
  }
}

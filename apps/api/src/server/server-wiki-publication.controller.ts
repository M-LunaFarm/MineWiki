import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import {
  ServerWikiPublicationService,
  type ServerWikiPublicationActor,
  type ReviewServerWikiReleaseCandidateInput,
  type RequestServerWikiReleaseChangesInput,
  type SubmitServerWikiReleaseCandidateInput,
  type UpdateServerWikiPublicationInput,
} from './server-wiki-publication.service';

const updatePublicationSchema = z.object({
  status: z.enum(['published', 'unpublished']),
  expectedVersion: z.number().int().min(0).max(4_294_967_295),
  expectedCandidateToken: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  candidateId: z.string().regex(/^[1-9][0-9]{0,19}$/u).optional(),
  reason: z.string().trim().min(5).max(500),
}).strict().superRefine((value, context) => {
  if (value.status === 'published' && !value.expectedCandidateToken) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expectedCandidateToken'],
      message: 'expectedCandidateToken is required when publishing.',
    });
  }
  if (value.status === 'published' && !value.candidateId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidateId'],
      message: 'candidateId is required when publishing.',
    });
  }
});

const reviewCandidateSchema = z.object({
  candidateId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
  candidateToken: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

const requestChangesSchema = reviewCandidateSchema.extend({
  note: z.string().trim().min(5).max(1000),
}).strict();

const submitCandidateSchema = z.object({
  expectedVersion: z.number().int().min(0).max(4_294_967_295),
  expectedCandidateToken: z.string().regex(/^[0-9a-f]{64}$/u),
  reason: z.string().trim().min(5).max(500),
}).strict();

@Controller('v1/servers/:serverId/wiki-publication')
@UseGuards(SessionGuard)
export class ServerWikiPublicationController {
  constructor(private readonly publication: ServerWikiPublicationService) {}

  @Get()
  @Throttle({ default: { limit: 30, ttl: 60 } })
  get(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @CurrentSession() session: SessionPayload,
  ) {
    return this.publication.get(serverId, actorFromSession(session));
  }

  @Patch()
  @RequireStepUp('server_admin')
  @Throttle({ default: { limit: 8, ttl: 60 } })
  update(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    const input = updatePublicationSchema.parse(body) as UpdateServerWikiPublicationInput;
    return this.publication.update(serverId, input, actorFromSession(session));
  }

  @Post('candidate')
  @RequireStepUp('server_admin')
  @Throttle({ default: { limit: 8, ttl: 60 } })
  submitCandidate(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    const input = submitCandidateSchema.parse(body) as SubmitServerWikiReleaseCandidateInput;
    return this.publication.submitCandidate(serverId, input, actorFromSession(session));
  }

  @Post('approval')
  @RequireStepUp('wiki_release_review')
  @Throttle({ default: { limit: 12, ttl: 60 } })
  approveCandidate(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    const input = reviewCandidateSchema.parse(body) as ReviewServerWikiReleaseCandidateInput;
    return this.publication.approveCandidate(serverId, input, actorFromSession(session));
  }

  @Delete('approval')
  @RequireStepUp('wiki_release_review')
  @Throttle({ default: { limit: 12, ttl: 60 } })
  revokeCandidateApproval(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    const input = reviewCandidateSchema.parse(body) as ReviewServerWikiReleaseCandidateInput;
    return this.publication.revokeCandidateApproval(serverId, input, actorFromSession(session));
  }

  @Post('changes-request')
  @RequireStepUp('wiki_release_review')
  @Throttle({ default: { limit: 8, ttl: 60 } })
  requestCandidateChanges(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    const input = requestChangesSchema.parse(body) as RequestServerWikiReleaseChangesInput;
    return this.publication.requestCandidateChanges(serverId, input, actorFromSession(session));
  }
}

function actorFromSession(session: SessionPayload): ServerWikiPublicationActor {
  return { accountId: session.userId, permissions: session.permissions };
}

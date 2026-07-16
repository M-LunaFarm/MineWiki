import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import {
  ServerWikiCollaboratorService,
  type CreateServerWikiCollaboratorInput,
  type RemoveServerWikiCollaboratorInput,
  type ServerWikiCollaboratorActor,
  type UpdateServerWikiCollaboratorInput,
} from './server-wiki-collaborator.service';

const collaboratorRoleSchema = z.enum(['manager', 'editor', 'reviewer']);
const reasonSchema = z.string().trim().min(5).max(500);
const exactUsernameSchema = z.string()
  .min(1)
  .max(64)
  .refine((value) => value.normalize('NFKC') === value, {
    message: 'username must be NFKC-normalized exactly.',
  });

const createCollaboratorSchema = z.object({
  username: exactUsernameSchema,
  role: collaboratorRoleSchema,
  reason: reasonSchema,
}).strict();

const updateCollaboratorSchema = z.object({
  role: collaboratorRoleSchema,
  expectedRole: collaboratorRoleSchema,
  reason: reasonSchema,
}).strict();

const removeCollaboratorSchema = z.object({
  expectedRole: collaboratorRoleSchema,
  reason: reasonSchema,
}).strict();

@Controller('v1/servers/:serverId/wiki-collaborators')
@RequireStepUp('server_admin')
@UseGuards(SessionGuard)
export class ServerWikiCollaboratorController {
  constructor(private readonly collaborators: ServerWikiCollaboratorService) {}

  @Get()
  @Throttle({ default: { limit: 30, ttl: 60 } })
  list(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @CurrentSession() session: SessionPayload,
  ) {
    return this.collaborators.list(serverId, actorFromSession(session));
  }

  @Post()
  @Throttle({ default: { limit: 8, ttl: 60 } })
  create(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    const input = createCollaboratorSchema.parse(body) as CreateServerWikiCollaboratorInput;
    return this.collaborators.create(serverId, input, actorFromSession(session));
  }

  @Patch(':profileId')
  @Throttle({ default: { limit: 12, ttl: 60 } })
  update(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Param('profileId') profileId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    const input = updateCollaboratorSchema.parse(body) as UpdateServerWikiCollaboratorInput;
    return this.collaborators.update(serverId, profileId, input, actorFromSession(session));
  }

  @Delete(':profileId')
  @Throttle({ default: { limit: 8, ttl: 60 } })
  remove(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Param('profileId') profileId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    const input = removeCollaboratorSchema.parse(body) as RemoveServerWikiCollaboratorInput;
    return this.collaborators.remove(serverId, profileId, input, actorFromSession(session));
  }
}

function actorFromSession(session: SessionPayload): ServerWikiCollaboratorActor {
  return {
    accountId: session.userId,
    permissions: session.permissions,
  };
}

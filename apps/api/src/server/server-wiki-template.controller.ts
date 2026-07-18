import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import { ServerWikiCollaboratorService } from './server-wiki-collaborator.service';
import {
  ServerWikiTemplateService,
  type ServerWikiTemplateInput,
  type ServerWikiTemplateUpdateInput,
} from './server-wiki-template.service';

const templateFields = {
  key: z.string().trim().min(2).max(64),
  title: z.string().trim().min(1).max(255),
  description: z.string().max(2_000).nullable().optional(),
  defaultCategory: z.string().trim().max(255).nullable().optional(),
  contentRaw: z.string().min(1).max(256 * 1024),
};
const createTemplateSchema = z.object(templateFields).strict();
const updateTemplateSchema = z.object({ ...templateFields, expectedVersion: z.number().int().min(1) }).strict();
const archiveTemplateSchema = z.object({ expectedVersion: z.coerce.number().int().min(1) }).strict();

@Controller('v1/servers/:serverId/wiki-templates')
@UseGuards(SessionGuard)
export class ServerWikiTemplateController {
  constructor(
    private readonly collaborators: ServerWikiCollaboratorService,
    private readonly templates: ServerWikiTemplateService,
  ) {}

  @Get()
  async list(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @CurrentSession() session: SessionPayload,
  ) {
    await this.authorize(serverId, session);
    return this.templates.list(serverId);
  }

  @Post()
  @RequireStepUp('server_admin')
  @Throttle({ default: { limit: 12, ttl: 60 } })
  async create(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    const authority = await this.authorize(serverId, session);
    return this.templates.create(serverId, authority.accountId, createTemplateSchema.parse(body) as ServerWikiTemplateInput);
  }

  @Patch(':templateId')
  @RequireStepUp('server_admin')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  async update(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Param('templateId') templateId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    const authority = await this.authorize(serverId, session);
    return this.templates.update(serverId, templateId, authority.accountId, updateTemplateSchema.parse(body) as ServerWikiTemplateUpdateInput);
  }

  @Delete(':templateId')
  @RequireStepUp('server_admin')
  @Throttle({ default: { limit: 12, ttl: 60 } })
  async archive(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Param('templateId') templateId: string,
    @Query('expectedVersion') expectedVersion: string,
    @CurrentSession() session: SessionPayload,
  ) {
    const authority = await this.authorize(serverId, session);
    const parsed = archiveTemplateSchema.parse({ expectedVersion });
    return this.templates.archive(serverId, templateId, authority.accountId, parsed.expectedVersion);
  }

  private authorize(serverId: string, session: SessionPayload) {
    return this.collaborators.authorizeContentSettings(serverId, {
      accountId: session.userId,
      permissions: session.permissions,
    });
  }
}

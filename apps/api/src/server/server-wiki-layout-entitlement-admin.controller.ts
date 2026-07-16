import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import {
  ServerWikiLayoutEntitlementAdminService,
  type ExtendServerWikiLayoutEntitlementInput,
  type GrantServerWikiLayoutEntitlementInput,
  type RevokeServerWikiLayoutEntitlementInput,
} from './server-wiki-layout-entitlement-admin.service';

const dateTimeSchema = z.string().datetime({ offset: true });
const reasonSchema = z.string().trim().min(5).max(500);
const sourceSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/u);
const externalReferenceSchema = z.string()
  .trim()
  .min(1)
  .max(191)
  .regex(/^[\x21-\x7e]+$/u)
  .refine((value) => value.normalize('NFKC') === value, {
    message: 'externalRef must be NFKC-normalized exactly.',
  });

const grantSchema = z.object({
  layoutKey: z.enum(['handbook', 'brand']),
  startsAt: dateTimeSchema,
  expiresAt: dateTimeSchema,
  source: sourceSchema,
  externalRef: externalReferenceSchema.optional(),
  reason: reasonSchema,
}).strict().refine(
  (value) => new Date(value.expiresAt).getTime() > new Date(value.startsAt).getTime(),
  { message: 'expiresAt must be later than startsAt.', path: ['expiresAt'] },
);

const extendSchema = z.object({
  expiresAt: dateTimeSchema,
  reason: reasonSchema,
}).strict();

const revokeSchema = z.object({
  reason: reasonSchema,
}).strict();

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().regex(/^[1-9][0-9]*$/u).max(20).optional(),
}).strict();

@Controller('v1/admin/servers/:serverId/wiki-layout-entitlements')
@RequireStepUp('server_admin')
@UseGuards(SessionGuard)
export class ServerWikiLayoutEntitlementAdminController {
  constructor(private readonly entitlements: ServerWikiLayoutEntitlementAdminService) {}

  @Get()
  @Throttle({ default: { limit: 30, ttl: 60 } })
  list(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @CurrentSession() session: SessionPayload,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    this.assertGlobalAdmin(session);
    const query = listSchema.parse({
      limit: limit?.trim() || undefined,
      before: before?.trim() || undefined,
    });
    return this.entitlements.list(serverId, query);
  }

  @Post()
  @Throttle({ default: { limit: 8, ttl: 60 } })
  grant(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    this.assertGlobalAdmin(session);
    const input = grantSchema.parse(body) as GrantServerWikiLayoutEntitlementInput;
    return this.entitlements.grant(serverId, input, session.userId);
  }

  @Post(':entitlementId/extend')
  @Throttle({ default: { limit: 12, ttl: 60 } })
  extend(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Param('entitlementId') entitlementId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    this.assertGlobalAdmin(session);
    const input = extendSchema.parse(body) as ExtendServerWikiLayoutEntitlementInput;
    return this.entitlements.extend(serverId, entitlementId, input, session.userId);
  }

  @Post(':entitlementId/revoke')
  @Throttle({ default: { limit: 8, ttl: 60 } })
  revoke(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Param('entitlementId') entitlementId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    this.assertGlobalAdmin(session);
    const input = revokeSchema.parse(body) as RevokeServerWikiLayoutEntitlementInput;
    return this.entitlements.revoke(serverId, entitlementId, input, session.userId);
  }

  private assertGlobalAdmin(session: SessionPayload): void {
    if (
      session.groups?.includes('owner') !== true
      && session.groups?.includes('admin') !== true
    ) {
      throw new ForbiddenException('Global owner or admin access is required.');
    }
  }
}

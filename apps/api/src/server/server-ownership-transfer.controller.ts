import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import {
  ServerOwnershipTransferService,
  type CreateOwnershipTransferInput,
  type ManageOwnershipTransferInput,
} from './server-ownership-transfer.service';

const reason = z.string().trim().min(5).max(500);
const createSchema = z.object({
  targetUsername: z.string().min(1).max(64).refine((value) => value.normalize('NFKC') === value),
  reason,
}).strict();
const manageSchema = z.object({ expectedVersion: z.number().int().min(1).max(1_000_000), reason }).strict();

@Controller('v1/servers/:serverId/ownership-transfers')
@RequireStepUp('server_ownership_transfer')
@UseGuards(SessionGuard)
export class ServerOwnershipTransferController {
  constructor(private readonly transfers: ServerOwnershipTransferService) {}

  @Get('current')
  @Throttle({ default: { limit: 30, ttl: 60 } })
  current(@Param('serverId', new ParseUUIDPipe()) serverId: string, @CurrentSession() session: SessionPayload) {
    return this.transfers.current(serverId, { accountId: session.userId });
  }

  @Post()
  @Throttle({ default: { limit: 4, ttl: 60 } })
  create(@Param('serverId', new ParseUUIDPipe()) serverId: string, @Body() body: unknown, @CurrentSession() session: SessionPayload) {
    return this.transfers.create(serverId, createSchema.parse(body) as CreateOwnershipTransferInput, { accountId: session.userId });
  }

  @Delete(':transferId')
  @Throttle({ default: { limit: 6, ttl: 60 } })
  cancel(@Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Param('transferId', new ParseUUIDPipe()) transferId: string,
    @Body() body: unknown, @CurrentSession() session: SessionPayload) {
    return this.transfers.cancel(serverId, transferId, manageSchema.parse(body) as ManageOwnershipTransferInput, { accountId: session.userId });
  }
}

@Controller('v1/me/server-ownership-transfers')
@UseGuards(SessionGuard)
export class MyServerOwnershipTransferController {
  constructor(private readonly transfers: ServerOwnershipTransferService) {}

  @Get()
  @Throttle({ default: { limit: 30, ttl: 60 } })
  async mine(@CurrentSession() session: SessionPayload) {
    return { items: await this.transfers.mine({ accountId: session.userId }) };
  }

  @Post(':transferId/accept')
  @RequireStepUp('server_ownership_transfer')
  @Throttle({ default: { limit: 6, ttl: 60 } })
  accept(@Param('transferId', new ParseUUIDPipe()) transferId: string,
    @Body() body: unknown, @CurrentSession() session: SessionPayload) {
    return this.transfers.respond(transferId, 'accept', manageSchema.parse(body) as ManageOwnershipTransferInput, { accountId: session.userId });
  }

  @Post(':transferId/decline')
  @RequireStepUp('server_ownership_transfer')
  @Throttle({ default: { limit: 6, ttl: 60 } })
  decline(@Param('transferId', new ParseUUIDPipe()) transferId: string,
    @Body() body: unknown, @CurrentSession() session: SessionPayload) {
    return this.transfers.respond(transferId, 'decline', manageSchema.parse(body) as ManageOwnershipTransferInput, { accountId: session.userId });
  }
}

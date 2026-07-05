import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { extractClientIp } from '../common/http/client-ip';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { SupportService } from './support.service';

@Controller('v1/support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @UseGuards(SessionGuard)
  @Get('agents/me')
  agentState(@CurrentSession() session: SessionPayload) {
    return this.support.getViewerState(session.userId);
  }

  @UseGuards(SessionGuard)
  @Get('tickets')
  listTickets(
    @CurrentSession() session: SessionPayload,
    @Query('view') view?: string,
    @Query('status') status?: string,
  ) {
    return this.support.listTickets(session, { view, status });
  }

  @UseGuards(SessionGuard)
  @Get('tickets/:ticketId')
  getTicket(
    @Param('ticketId', new ParseUUIDPipe()) ticketId: string,
    @CurrentSession() session: SessionPayload,
  ) {
    return this.support.getTicketDetail(session, ticketId);
  }

  @UseGuards(SessionGuard)
  @Post('tickets')
  createTicket(@CurrentSession() session: SessionPayload, @Body() body: unknown) {
    return this.support.createTicket(session, body);
  }

  @Post('tickets/guest')
  createGuestTicket(@Body() body: unknown, @Req() request: FastifyRequest) {
    return this.support.createGuestTicket(body, {
      ipAddress: extractClientIp(request),
      userAgent: request.headers['user-agent'] ?? null,
    });
  }

  @UseGuards(SessionGuard)
  @Post('tickets/:ticketId/messages')
  createMessage(
    @Param('ticketId', new ParseUUIDPipe()) ticketId: string,
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown,
  ) {
    return this.support.createMessage(session, ticketId, body);
  }

  @UseGuards(SessionGuard)
  @Patch('tickets/:ticketId')
  updateTicket(
    @Param('ticketId', new ParseUUIDPipe()) ticketId: string,
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown,
  ) {
    return this.support.updateTicket(session, ticketId, body);
  }
}

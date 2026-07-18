import { Body, Controller, Post, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { AccountDataExportService } from './account-data-export.service';

const requestSchema = z.object({
  password: z.string().min(1).max(1024).optional(),
}).strict();

@Controller('v1/auth/account-data-export')
export class AccountDataExportController {
  constructor(private readonly exports: AccountDataExportService) {}

  @Post()
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 2, ttl: 3600 } })
  async download(
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const payload = requestSchema.parse(body);
    const stream = await this.exports.create({ session, password: payload.password });
    const date = new Date().toISOString().slice(0, 10);
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="minewiki-account-data-${date}.json"`);
    reply.header('Cache-Control', 'private, no-store, max-age=0');
    reply.header('Pragma', 'no-cache');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Accel-Buffering', 'no');
    return new StreamableFile(stream);
  }
}

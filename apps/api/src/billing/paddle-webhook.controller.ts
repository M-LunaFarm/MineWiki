import { Controller, Headers, HttpCode, Post, RawBodyRequest, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { PaddleWebhookService } from './paddle-webhook.service';

@Controller('v1/webhooks')
export class PaddleWebhookController {
  constructor(private readonly paddle: PaddleWebhookService) {}

  @Post('paddle')
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60 } })
  ingest(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Headers('paddle-signature') signature?: string,
  ) {
    return this.paddle.ingest(request.rawBody, signature);
  }
}

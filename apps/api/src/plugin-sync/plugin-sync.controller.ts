import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { PluginSyncService, type PluginSyncResponse } from './plugin-sync.service';

const pluginSyncRequestSchema = z.object({
  timestamp: z.union([z.string(), z.number()])
    .transform((value) => String(value))
    .refine((value) => /^\d{1,13}$/u.test(value), 'invalid_timestamp'),
  nonce: z.string().min(1).max(128),
  signature: z.string().regex(/^[a-f0-9]{64}$/iu),
  payload: z.record(z.unknown())
}).superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value.payload), 'utf8') > 16 * 1024) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'payload_too_large' });
  }
});

@Controller()
export class PluginSyncController {
  constructor(private readonly pluginSync: PluginSyncService) {}

  @Post([
    'v1/plugin/sync',
    'api/v1/plugin/sync-9b4f7d2c6a5e4f3aa1d8b9a7c6e5d4f3',
    'api/v1/plugin/sync'
  ])
  @Throttle({ default: { limit: 30, ttl: 60 } })
  sync(@Body() body: unknown): Promise<PluginSyncResponse> {
    return this.pluginSync.sync(pluginSyncRequestSchema.parse(body) as {
      timestamp: string;
      nonce: string;
      signature: string;
      payload: Record<string, unknown>;
    });
  }
}

import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { PluginSyncService, type PluginSyncResponse } from './plugin-sync.service';

const pluginSyncRequestSchema = z.object({
  timestamp: z.union([z.string(), z.number()]).transform((value) => String(value)),
  nonce: z.string().min(1),
  signature: z.string().min(1),
  payload: z.record(z.unknown())
});

@Controller()
export class PluginSyncController {
  constructor(private readonly pluginSync: PluginSyncService) {}

  @Post('v1/plugin/sync')
  @Throttle({ default: { limit: 30, ttl: 60 } })
  sync(@Body() body: unknown): Promise<PluginSyncResponse> {
    return this.pluginSync.sync(pluginSyncRequestSchema.parse(body) as {
      timestamp: string;
      nonce: string;
      signature: string;
      payload: Record<string, unknown>;
    });
  }

  @Post('api/v1/plugin/sync-9b4f7d2c6a5e4f3aa1d8b9a7c6e5d4f3')
  @Throttle({ default: { limit: 30, ttl: 60 } })
  syncLegacyHashed(@Body() body: unknown): Promise<PluginSyncResponse> {
    return this.sync(body);
  }

  @Post('api/v1/plugin/sync')
  @Throttle({ default: { limit: 30, ttl: 60 } })
  syncLegacyPlain(@Body() body: unknown): Promise<PluginSyncResponse> {
    return this.sync(body);
  }
}

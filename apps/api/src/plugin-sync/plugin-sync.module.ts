import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { PluginSyncController } from './plugin-sync.controller';
import { PluginSyncService } from './plugin-sync.service';
import {
  DiscordMinecraftLinkRepository,
  GuildEventRepository,
  GuildVerificationRepository,
  PluginServerRepository
} from '../verify/guild.repositories';

@Module({
  imports: [EventsModule],
  controllers: [PluginSyncController],
  providers: [
    PluginSyncService,
    PluginServerRepository,
    GuildVerificationRepository,
    DiscordMinecraftLinkRepository,
    GuildEventRepository
  ],
  exports: [PluginSyncService]
})
export class PluginSyncModule {}

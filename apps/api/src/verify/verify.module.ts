import { Module } from '@nestjs/common';
import { VerifyController } from './verify.controller';
import { VerifyService } from './verify.service';
import { SessionModule } from '../session/session.module';
import { EventsModule } from '../events/events.module';
import { DiscordVerifyController } from './discord-verify.controller';
import { GuildController } from './guild.controller';
import { GuildAccessService } from './guild-access.service';
import {
  DiscordMinecraftLinkRepository,
  GuildChannelSettingsRepository,
  GuildEventRepository,
  GuildSettingsRepository,
  GuildVerificationRepository
} from './guild.repositories';
import { MinecraftModule } from '../minecraft/minecraft.module';

@Module({
  imports: [SessionModule, EventsModule, MinecraftModule],
  controllers: [VerifyController, DiscordVerifyController, GuildController],
  providers: [
    VerifyService,
    GuildAccessService,
    GuildSettingsRepository,
    GuildChannelSettingsRepository,
    DiscordMinecraftLinkRepository,
    GuildVerificationRepository,
    GuildEventRepository
  ],
  exports: [
    VerifyService,
    GuildAccessService,
    GuildSettingsRepository,
    GuildChannelSettingsRepository,
    DiscordMinecraftLinkRepository,
    GuildVerificationRepository,
    GuildEventRepository
  ]
})
export class VerifyModule {}
